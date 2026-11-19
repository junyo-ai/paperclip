import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  roleTemplates,
} from "@paperclipai/db";
import type { RoleTemplateSpec } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  executeRoleTemplateTool,
  ROLE_TEMPLATE_CHAT_TOOLS,
  type RoleTemplateChatSession,
} from "./role-template-chat-tools.js";

const SPEC: RoleTemplateSpec = {
  templateName: "Support Specialist",
  character: {
    personaPrompt:
      "【职责边界】\n负责工单一线支持：受理、分类、复现诊断并给出修复建议；对无法就地解决的问题完整移交工程团队并跟进到关闭；不修改生产配置，不对外承诺 SLA 赔偿与合同口径。\n\n【工作风格】\n以工单为中心：开工先认领并写明计划，结束必留结论、证据与下一步；信息不足时一次性集中提问，不反复打断用户；数据导向，用复现结果和断言决定收尾或升级；跨团队移交时附完整上下文，不让用户重述问题。\n\n【输出规范】\n统一 Markdown 输出，中文为默认语言；引用数据必须标注来源，禁止编造数字与案例；修复建议给出验证步骤与回滚说明；任务收尾必附结论、下一步建议与不超过三条的待确认事项。",
    title: "Support Specialist",
    role: "general",
  },
  skills: [
    { key: "paperclipai/paperclip/paperclip", reason: "核心运行技能。" },
    { key: "library/absent-skill", reason: "尚未入库的技能。" },
  ],
  defaults: { notes: "低档预算起步。" },
  rationale: ["对话式建模板回归测试。"],
};

describe("Role template chat tool contract", () => {
  it("exposes a read-only draft tool and a write create tool", () => {
    expect(ROLE_TEMPLATE_CHAT_TOOLS.map((tool) => [tool.name, tool.risk])).toEqual([
      ["role-template-builder:draft_role_template", "read"],
      ["role-template-builder:create_role_template", "write"],
    ]);
    for (const tool of ROLE_TEMPLATE_CHAT_TOOLS) {
      expect(tool.providerType).toBe("paperclip_role_template");
      expect(tool.pluginId).toBe("role-template-builder");
      expect(typeof tool.parametersSchema).toBe("object");
    }
  });

  it("only create demands an idempotency key", () => {
    const [draft, create] = ROLE_TEMPLATE_CHAT_TOOLS;
    expect(draft.parametersSchema.required ?? []).not.toContain("idempotencyKey");
    expect(create.parametersSchema.required ?? []).toContain("idempotencyKey");
  });

  it("keeps the confirmation flow and admin gate in the agent guidance", () => {
    const [draft, create] = ROLE_TEMPLATE_CHAT_TOOLS;
    expect(draft.description).toContain("create_role_template");
    expect(draft.description).toContain("confirmation");
    expect(create.description).toContain("owner or admin");
    expect(create.description).toContain("idempotencyKey");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Role template chat tool execution", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-role-template-chat-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture() {
    const [company] = await db
      .insert(companies)
      .values({ name: `Role Template Chat ${randomUUID().slice(0, 8)}`, issuePrefix: randomUUID().slice(0, 8) })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Builder agent", role: "general", adapterType: "codex_local" })
      .returning();
    await db.insert(companySkills).values({
      companyId: company.id,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "paperclip",
      markdown: "# skill",
    });
    for (const [userId, membershipRole] of [
      ["owner-u", "owner"],
      ["admin-u", "admin"],
      ["operator-u", "operator"],
      ["viewer-u", "viewer"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: userId,
        membershipRole,
        status: "active",
      });
    }
    return { company, agent };
  }

  function session(
    companyId: string,
    agentId: string,
    overrides: Partial<RoleTemplateChatSession> = {},
  ): RoleTemplateChatSession {
    return {
      companyId,
      agentId,
      runId: null,
      actorType: "agent",
      actorId: agentId,
      responsibleUserId: null,
      ...overrides,
    };
  }

  const draftInput = (s: RoleTemplateChatSession, spec: unknown, key?: string) =>
    executeRoleTemplateTool(db, s, "draft_role_template", { spec, key });
  const createInput = (s: RoleTemplateChatSession, body: Record<string, unknown>) =>
    executeRoleTemplateTool(db, s, "create_role_template", body);

  it("draft validates a good spec without storing it", async () => {
    const f = await fixture();
    const result = await draftInput(session(f.company.id, f.agent.id), SPEC);
    expect(result).toMatchObject({
      valid: true,
      stored: false,
      draft: { key: "support-specialist", spec: SPEC },
      missingSkills: ["library/absent-skill"],
    });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await db.select().from(roleTemplates).where(eq(roleTemplates.companyId, f.company.id)),
    ).toHaveLength(0);
  });

  it("draft reports spec violations as issues instead of throwing", async () => {
    const f = await fixture();
    const result = await draftInput(session(f.company.id, f.agent.id), {
      ...SPEC,
      character: { ...SPEC.character, personaPrompt: "太短" },
    });
    expect(result).toMatchObject({ valid: false });
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "spec.character.personaPrompt" }),
    );
  });

  it("draft rejects names that cannot yield a slug key", async () => {
    const f = await fixture();
    const result = await draftInput(session(f.company.id, f.agent.id), {
      ...SPEC,
      templateName: "？？！！",
    });
    expect(result).toMatchObject({
      valid: false,
      issues: [{ path: "key" }],
    });
  });

  it.each(["unsponsored", "viewer", "operator", "stranger"] as const)(
    "create refuses a non-admin %s session",
    async (kind) => {
      const f = await fixture();
      const s =
        kind === "unsponsored"
          ? session(f.company.id, f.agent.id)
          : session(f.company.id, f.agent.id, {
              responsibleUserId: kind === "stranger" ? "stranger-u" : `${kind}-u`,
            });
      await expect(
        createInput(s, { spec: SPEC, idempotencyKey: "confirm-1" }),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await db.select().from(roleTemplates).where(eq(roleTemplates.companyId, f.company.id)),
      ).toHaveLength(0);
    },
  );

  it.each(["admin sponsor", "owner actor"] as const)(
    "create stores a draft for an admin-backed %s session",
    async (kind) => {
      const f = await fixture();
      const s =
        kind === "admin sponsor"
          ? session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" })
          : session(f.company.id, f.agent.id, {
              actorType: "user",
              actorId: "owner-u",
              responsibleUserId: "owner-u",
            });
      const result = await createInput(s, { spec: SPEC, idempotencyKey: "confirm-1" });
      expect(result).toMatchObject({
        created: true,
        replayed: false,
        template: { key: "support-specialist", name: "Support Specialist", status: "draft" },
      });
      const rows = await db
        .select()
        .from(roleTemplates)
        .where(eq(roleTemplates.companyId, f.company.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe("support-specialist");
    },
  );

  it("create rejects an invalid body before touching the store", async () => {
    const f = await fixture();
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    await expect(
      createInput(s, { spec: { ...SPEC, templateName: "" }, idempotencyKey: "confirm-1" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("create replays the same confirmation and rejects a mutated one", async () => {
    const f = await fixture();
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    const first = await createInput(s, { spec: SPEC, idempotencyKey: "confirm-1" });
    const replay = await createInput(s, { spec: SPEC, idempotencyKey: "confirm-1" });
    expect(replay).toMatchObject({ created: false, replayed: true });
    expect(replay.template!.id).toBe(first.template!.id);
    expect(
      await db.select().from(roleTemplates).where(eq(roleTemplates.companyId, f.company.id)),
    ).toHaveLength(1);
    await expect(
      createInput(s, {
        spec: { ...SPEC, templateName: "Support Specialist v2" },
        idempotencyKey: "confirm-1",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
