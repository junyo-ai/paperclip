import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentFileRoots,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  approvals,
  budgetPolicies,
  builtInManagedResources,
  companies,
  companyMemberships,
  companySkillVersions,
  companySkills,
  createDb,
  environments,
  heartbeatRuns,
  principalPermissionGrants,
  roleTemplates,
  roleTemplateVersions,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import type { RoleTemplateSpec } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { ROLE_TEMPLATE_GAP_REASON_PREFIX, roleTemplateStore } from "../services/role-template-store.js";
import { seedRoleTemplates } from "../services/role-template-seed.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-hire role template route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

const BOARD_ACTOR: Express.Request["actor"] = { type: "board", userId: "local-board", source: "local_implicit" };

function agentActor(
  companyId: string,
  agentId: string,
  runId?: string,
): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt", runId };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

const TEMPLATE_SKILL_KEYS = ["paperclipai/paperclip/paperclip", "paperclipai/paperclip/para-memory-files"] as const;

const TEMPLATE_SPEC: RoleTemplateSpec = {
  templateName: "测试专员 v1",
  character: {
    personaPrompt:
      "【职责边界】\n负责角色模板招联回归测试：验证模板解析、字段合并、预算门禁与来源记录三条主链路；覆盖 templateId 有效、无效、缺失三态；不修改产品代码，不对外承诺合同、报价与法务口径。\n\n【工作风格】\n以任务为中心：开工先领取任务，结束时更新状态、留下结论与下一步；信息不足时一次性集中提问，不反复打断；数据导向，用断言结果决定收尾或继续排查。\n\n【输出规范】\n交付统一 Markdown，中文为默认语言；引用数据必须标注来源，禁止编造数字与案例；任务收尾必附结论、下一步建议与不超过三条的待确认事项。",
    title: "测试专员",
    role: "engineer",
  },
  skills: [
    { key: TEMPLATE_SKILL_KEYS[0], reason: "核心运行技能。" },
    { key: TEMPLATE_SKILL_KEYS[1], reason: "跨会话记忆。" },
  ],
  defaults: {
    budgetMonthlyCents: 1500,
    permissions: { canCreateAgents: false, canCreateSkills: false },
    notes: "低档预算起步。",
  },
  rationale: ["回归测试用最小模板。"],
};

async function seedFixtureCompany(db: Db, requireBoardApprovalForNewAgents = false) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db
    .insert(companies)
    .values({
      name: `Role Template Co ${nonce}`,
      issuePrefix: `RT${nonce.slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents,
    })
    .returning();
  return company!;
}

async function seedCompanySkills(db: Db, companyId: string) {
  await db.insert(companySkills).values(
    TEMPLATE_SKILL_KEYS.map((key) => ({
      companyId,
      key,
      slug: key.split("/").at(-1)!,
      name: key.split("/").at(-1)!,
      markdown: "# skill",
    })),
  );
}

async function seedPublishedTemplate(db: Db, companyId: string) {
  const store = roleTemplateStore(db);
  const actor = { actorType: "user" as const, actorId: "local-board" };
  const { template } = await store.create(
    companyId,
    { key: "regression-specialist", spec: TEMPLATE_SPEC },
    actor,
  );
  const published = await store.publish(companyId, template.id, actor);
  return published;
}

async function seedHiringAgent(db: Db, companyId: string) {
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      name: "Chief Of Staff",
      role: "general",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { canCreateAgents: true },
    })
    .returning();
  return agent!;
}

async function seedHeartbeatRun(db: Db, companyId: string, agentId: string) {
  const [run] = await db
    .insert(heartbeatRuns)
    .values({ companyId, agentId, status: "running", contextSnapshot: {} })
    .returning();
  return run!;
}

function managedAgentsMd(row: typeof agents.$inferSelect): string {
  const config = row.adapterConfig as Record<string, unknown>;
  expect(config.instructionsBundleMode).toBe("managed");
  expect(typeof config.instructionsFilePath).toBe("string");
  return config.instructionsFilePath as string;
}

describeEmbeddedPostgres("template-aware agent hire wiring", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome!: string;
  let originalPaperclipHome: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-role-template-");
    db = createDb(tempDb.connectionString);
    originalPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await mkdtemp(join(tmpdir(), "paperclip-template-hire-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentFileRoots);
    await db.delete(roleTemplateVersions);
    await db.delete(roleTemplates);
    await db.delete(companySkills);
    await db.delete(companySkillVersions);
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeState);
    await db.delete(agentConfigRevisions);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    await rm(paperclipHome, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("creates an agent from a published template with persona, provenance, snapshot and audit", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const app = createApp(db, BOARD_ACTOR);

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "测试一号", templateId: published.template.id, adapterType: "claude_local" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.hiredFromTemplateId).toBe(published.template.id);
    expect(res.body.hiredFromTemplateVersion).toBe(1);
    expect(res.body.roleTemplateSnapshot).toMatchObject({ templateKey: "regression-specialist", templateVersion: 1 });

    const [row] = await db.select().from(agents).where(eq(agents.id, res.body.id));
    expect(row).toBeTruthy();
    expect(row!.title).toBe(TEMPLATE_SPEC.character.title);
    expect(row!.role).toBe("engineer");
    expect(row!.budgetMonthlyCents).toBe(1500);
    expect(row!.hiredFromTemplateId).toBe(published.template.id);
    expect(row!.hiredFromTemplateVersion).toBe(1);
    expect((row!.roleTemplateSnapshot as Record<string, unknown>).callerOverrides).toEqual([]);
    expect((row!.roleTemplateSnapshot as Record<string, unknown>).applied).toMatchObject({
      title: TEMPLATE_SPEC.character.title,
      personaPrompt: TEMPLATE_SPEC.character.personaPrompt,
    });
    expect((row!.permissions as Record<string, unknown>)).toMatchObject({
      canCreateAgents: false,
      canCreateSkills: false,
    });
    expect(readFileSync(managedAgentsMd(row!), "utf8")).toBe(TEMPLATE_SPEC.character.personaPrompt);

    const [audit] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, "role_template.hire_applied")));
    expect(audit?.entityId).toBe(published.template.id);
    expect((audit?.details as Record<string, unknown>)?.agentId).toBe(res.body.id);
  });

  it("lets explicit caller fields override the template and records the diff", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const app = createApp(db, BOARD_ACTOR);

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({
        name: "测试二号",
        templateId: published.template.id,
        adapterType: "claude_local",
        title: "资深测试专员",
        role: "general",
        budgetMonthlyCents: 0,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [row] = await db.select().from(agents).where(eq(agents.id, res.body.id));
    expect(row!.title).toBe("资深测试专员");
    expect(row!.role).toBe("general");
    expect(row!.budgetMonthlyCents).toBe(0);
    expect((row!.roleTemplateSnapshot as Record<string, unknown>).callerOverrides).toEqual(
      expect.arrayContaining(["title", "role", "budgetMonthlyCents"]),
    );
  });

  it("returns 422 when a template hire omits the caller-supplied name", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const app = createApp(db, BOARD_ACTOR);

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ templateId: published.template.id, adapterType: "claude_local" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("explicit agent name");
  });

  it("rejects a hire against an unpublished template with role_template_not_hireable", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const { template } = await roleTemplateStore(db).create(
      company.id,
      { key: "draft-specialist", spec: TEMPLATE_SPEC },
      { actorType: "user", actorId: "local-board" },
    );
    const app = createApp(db, BOARD_ACTOR);

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "测试三号", templateId: template.id, adapterType: "claude_local" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("role_template_not_hireable");
  });

  it("rejects a hire whose template skills left the company library, listing them", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    await db
      .delete(companySkills)
      .where(and(eq(companySkills.companyId, company.id), eq(companySkills.key, TEMPLATE_SKILL_KEYS[1])));
    const app = createApp(db, BOARD_ACTOR);

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "测试四号", templateId: published.template.id, adapterType: "claude_local" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain(TEMPLATE_SKILL_KEYS[1]);
    expect(res.body.details).toMatchObject({ missingSkillKeys: [TEMPLATE_SKILL_KEYS[1]] });
  });

  it("rejects a template persona on an adapter without managed instructions support", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const app = createApp(db, BOARD_ACTOR);

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "流程专员", templateId: published.template.id, adapterType: "process" });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("managed instructions");

    const hires = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(hires).toHaveLength(0);
  });

  it("rejects templateId combined with setupId", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const app = createApp(db, BOARD_ACTOR);

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({
        name: "草稿专员",
        setupId: randomUUID(),
        templateId: published.template.id,
        adapterType: "claude_local",
      });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("setupId");
  });

  it("creates an agent without template provenance when templateId is absent", async () => {
    const company = await seedFixtureCompany(db);
    const app = createApp(db, BOARD_ACTOR);

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "无模板专员", adapterType: "claude_local" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [row] = await db.select().from(agents).where(eq(agents.id, res.body.id));
    expect(row!.hiredFromTemplateId).toBeNull();
    expect(row!.hiredFromTemplateVersion).toBeNull();
    expect(row!.roleTemplateSnapshot).toBeNull();
  });

  it("blocks a non-board caller from activating a template-sourced budget", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const hiringAgent = await seedHiringAgent(db, company.id);
    const app = createApp(db, agentActor(company.id, hiringAgent.id));

    const res = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({ name: "预算测试", templateId: published.template.id, adapterType: "claude_local" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe("board_access_required");
  });

  it("keeps the template canCreateSkills when the caller omits it, honors an explicit override", async () => {
    const company = await seedFixtureCompany(db);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const app = createApp(db, BOARD_ACTOR);

    const omitted = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({
        name: "权限省略",
        templateId: published.template.id,
        adapterType: "claude_local",
        permissions: { canCreateAgents: true },
      });
    expect(omitted.status, JSON.stringify(omitted.body)).toBe(201);
    const [omittedRow] = await db.select().from(agents).where(eq(agents.id, omitted.body.id));
    expect(omittedRow!.permissions).toMatchObject({ canCreateAgents: true, canCreateSkills: false });

    const explicit = await request(app)
      .post(`/api/companies/${company.id}/agents`)
      .send({
        name: "权限显式",
        templateId: published.template.id,
        adapterType: "claude_local",
        permissions: { canCreateAgents: true, canCreateSkills: true },
      });
    expect(explicit.status, JSON.stringify(explicit.body)).toBe(201);
    const [explicitRow] = await db.select().from(agents).where(eq(agents.id, explicit.body.id));
    expect(explicitRow!.permissions).toMatchObject({ canCreateAgents: true, canCreateSkills: true });
  });

  it("hires through the agent-hires route with template provenance", async () => {
    const company = await seedFixtureCompany(db, true);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const hiringAgent = await seedHiringAgent(db, company.id);
    const app = createApp(db, agentActor(company.id, hiringAgent.id));

    const res = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "模板雇员", templateId: published.template.id, adapterType: "claude_local" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.approval?.type).toBe("hire_agent");

    const [row] = await db.select().from(agents).where(eq(agents.id, res.body.agent.id));
    expect(row!.status).toBe("pending_approval");
    expect(row!.hiredFromTemplateId).toBe(published.template.id);
    expect(row!.hiredFromTemplateVersion).toBe(1);
    expect(row!.title).toBe(TEMPLATE_SPEC.character.title);
    expect(row!.budgetMonthlyCents).toBe(1500);
    expect(readFileSync(managedAgentsMd(row!), "utf8")).toBe(TEMPLATE_SPEC.character.personaPrompt);

    const [audit] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, company.id), eq(activityLog.action, "role_template.hire_applied")));
    expect(audit?.entityId).toBe(published.template.id);
  });

  it("returns the prior hire when the run retries after the template was deprecated", async () => {
    const company = await seedFixtureCompany(db, true);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const hiringAgent = await seedHiringAgent(db, company.id);
    const run = await seedHeartbeatRun(db, company.id, hiringAgent.id);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));

    const payload = { name: "幂等专员", templateId: published.template.id, adapterType: "claude_local" };
    const first = await request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    await db.update(roleTemplates).set({ status: "deprecated" }).where(eq(roleTemplates.id, published.template.id));

    const retry = await request(app).post(`/api/companies/${company.id}/agent-hires`).send(payload);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.agent.id).toBe(first.body.agent.id);

    const hires = await db.select().from(agents).where(eq(agents.companyId, company.id));
    expect(hires.filter((row) => row.name === "幂等专员")).toHaveLength(1);
  });

  it("treats an explicit zero budget as a corrected request, not a retry", async () => {
    const company = await seedFixtureCompany(db, true);
    await seedCompanySkills(db, company.id);
    const published = await seedPublishedTemplate(db, company.id);
    const hiringAgent = await seedHiringAgent(db, company.id);
    const run = await seedHeartbeatRun(db, company.id, hiringAgent.id);
    const app = createApp(db, agentActor(company.id, hiringAgent.id, run.id));

    const first = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "预算修正", templateId: published.template.id, adapterType: "claude_local" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.agent.budgetMonthlyCents).toBe(1500);

    const corrected = await request(app)
      .post(`/api/companies/${company.id}/agent-hires`)
      .send({ name: "预算修正", templateId: published.template.id, adapterType: "claude_local", budgetMonthlyCents: 0 });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect(corrected.body.agent.id).not.toBe(first.body.agent.id);
    expect(corrected.body.agent.budgetMonthlyCents).toBe(0);
  });
});

describeEmbeddedPostgres("company creation seeds role templates", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-role-template-seeds-");
    db = createDb(tempDb!.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(builtInManagedResources);
    await db.delete(roleTemplateVersions);
    await db.delete(roleTemplates);
    await db.delete(companySkills);
    await db.delete(companySkillVersions);
    await db.delete(agentWakeupRequests);
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agentRuntimeState);
    await db.delete(agentConfigRevisions);
    await db.delete(agentFileRoots);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("installs both seeds at company creation, gating on the bundled skill inventory", async () => {
    const company = await companyService(db).create({ name: `Seed Co ${randomUUID().slice(0, 8)}` });

    const seeds = await db
      .select()
      .from(roleTemplates)
      .where(eq(roleTemplates.companyId, company.id));
    const byKey = new Map(seeds.map((row) => [row.key, row]));
    expect([...byKey.keys()].sort()).toEqual(["content-marketing-specialist", "software-engineer"]);

    const marketing = byKey.get("content-marketing-specialist")!;
    expect(marketing.status).toBe("published");
    expect(marketing.currentVersion).toBe(1);
    const engineer = byKey.get("software-engineer")!;
    expect(engineer.status).toBe("deprecated");
    expect(engineer.deprecationReason).toContain(ROLE_TEMPLATE_GAP_REASON_PREFIX);

    for (const seed of [marketing, engineer]) {
      const [version] = await db
        .select()
        .from(roleTemplateVersions)
        .where(and(eq(roleTemplateVersions.templateId, seed.id), eq(roleTemplateVersions.version, 1)));
      expect(version).toBeTruthy();
    }

    const rerun = await seedRoleTemplates(company.id, db);
    expect(rerun.map((result) => result.outcome)).toEqual(["already_present", "already_present"]);
  });
});
