import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySkills,
  companySkillVersions,
  createDb,
  heartbeatRuns,
  toolProfileBindings,
  toolProfiles,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  executeLessonCaptureTool,
  LESSON_CAPTURE_CHAT_TOOLS,
  type LessonCaptureChatSession,
} from "./lesson-capture-chat-tools.js";
import { createToolGatewayService } from "./tool-gateway.js";

const LESSON = {
  domain: "git",
  trigger: "Never force-push shared branches",
  rule: "Push with --force-with-lease only after re-checking the remote ref.",
  evidence: "A force push in PR 12 dropped a teammate's unmerged commits.",
};

describe("Lesson capture chat tool contract", () => {
  it("exposes a read-only propose tool and a write record tool", () => {
    expect(LESSON_CAPTURE_CHAT_TOOLS.map((tool) => [tool.name, tool.risk])).toEqual([
      ["lesson-capture:propose_lesson", "read"],
      ["lesson-capture:record_lesson", "write"],
    ]);
    for (const tool of LESSON_CAPTURE_CHAT_TOOLS) {
      expect(tool.providerType).toBe("paperclip_lesson_capture");
      expect(tool.pluginId).toBe("lesson-capture");
      expect(typeof tool.parametersSchema).toBe("object");
    }
  });

  it("keeps the confirmation flow and admin gate in the agent guidance", () => {
    const [propose, record] = LESSON_CAPTURE_CHAT_TOOLS;
    expect(propose.description).toContain("record_lesson");
    expect(propose.description).toContain("confirmation");
    expect(propose.description).toContain("alreadyCaptured");
    expect(record.description).toContain("owner or admin");
    expect(record.description).toContain("idempotent");
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Lesson capture chat tool execution", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const originalHome = process.env.PAPERCLIP_HOME;
  const originalPackageStorage = process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED;

  beforeAll(async () => {
    process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED = "true";
    database = await startEmbeddedPostgresTestDatabase("paperclip-lesson-capture-");
    db = createDb(database.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-lesson-test-"));
    process.env.PAPERCLIP_HOME = home;
  }, 30_000);
  afterAll(async () => {
    if (originalPackageStorage === undefined) delete process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED;
    else process.env.PAPERCLIP_SKILL_PACKAGE_STORAGE_ENABLED = originalPackageStorage;
    if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  }, 60_000);

  async function fixture() {
    const [company] = await db
      .insert(companies)
      .values({ name: `Lesson Capture ${randomUUID().slice(0, 8)}`, issuePrefix: randomUUID().slice(0, 8) })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Lesson agent",
        role: "general",
        adapterType: "codex_local",
        adapterConfig: {},
      })
      .returning();
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
    agentId: string | null,
    overrides: Partial<LessonCaptureChatSession> = {},
  ): LessonCaptureChatSession {
    return {
      companyId,
      agentId,
      runId: null,
      actorType: "agent",
      actorId: agentId,
      responsibleUserId: null,
      identityContextId: null,
      ...overrides,
    };
  }

  const propose = (s: LessonCaptureChatSession, body: unknown) =>
    executeLessonCaptureTool(db, s, "propose_lesson", body);
  const record = (s: LessonCaptureChatSession, body: Record<string, unknown>) =>
    executeLessonCaptureTool(db, s, "record_lesson", body);

  // First service touch seeds the repo's bundled skills into the company, so
  // every assertion below scopes to the lessons skills this tool creates.
  const lessonsSkillRows = (companyId: string) =>
    db.select().from(companySkills).where(
      and(eq(companySkills.companyId, companyId), like(companySkills.slug, "lessons-%")),
    );
  const lessonsVersionRows = async (companyId: string) => {
    const skills = await lessonsSkillRows(companyId);
    const ids = new Set(skills.map((skill) => skill.id));
    const rows = await db
      .select()
      .from(companySkillVersions)
      .where(eq(companySkillVersions.companyId, companyId));
    return rows.filter((row) => ids.has(row.companySkillId));
  };

  it("propose drafts an entry without storing anything", async () => {
    const f = await fixture();
    const result = await propose(session(f.company.id, f.agent.id), LESSON);
    expect(result).toMatchObject({
      valid: true,
      stored: false,
      domain: "git",
      alreadyCaptured: false,
      skill: { key: `company/${f.company.id}/lessons-git`, name: "Lessons: git" },
    });
    expect(result.entry).toMatch(/^### Never force-push shared branches（\d{4}-\d{2}-\d{2}）$/m);
    expect(result.entry).toContain(`- **Rule**: ${LESSON.rule}`);
    expect(result.entry).toContain(`- **Evidence**: ${LESSON.evidence}`);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await lessonsSkillRows(f.company.id)).toHaveLength(0);
  });

  it.each([
    "../git", "git/../../secrets", "Git", "git..ci", "git_", "a".repeat(41),
  ])("propose rejects the unsafe or invalid domain %s", async (domain) => {
    const f = await fixture();
    const result = await propose(session(f.company.id, f.agent.id), { ...LESSON, domain });
    expect(result).toMatchObject({ valid: false });
    expect(result.issues).toContainEqual(expect.objectContaining({ path: "domain" }));
  });

  it.each(["unsponsored", "viewer", "operator", "stranger"] as const)(
    "record refuses a non-admin %s session and writes nothing",
    async (kind) => {
      const f = await fixture();
      const s =
        kind === "unsponsored"
          ? session(f.company.id, f.agent.id)
          : session(f.company.id, f.agent.id, {
              responsibleUserId: kind === "stranger" ? "stranger-u" : `${kind}-u`,
            });
      await expect(record(s, LESSON)).rejects.toMatchObject({ status: 403 });
      expect(await lessonsSkillRows(f.company.id)).toHaveLength(0);
      const [agentRow] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
      expect(agentRow.adapterConfig).toEqual({});
    },
  );

  it.each(["admin sponsor", "owner actor"] as const)(
    "record stores the lesson and assigns the skill for an admin-backed %s session",
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
      const result = await record(s, LESSON);
      expect(result).toMatchObject({
        recorded: true,
        alreadyCaptured: false,
        assignedToAgent: true,
        skill: { key: `company/${f.company.id}/lessons-git`, name: "Lessons: git" },
      });
      const rows = await lessonsSkillRows(f.company.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ slug: "lessons-git", sourceType: "managed" });
      expect(rows[0].markdown).toContain("# Lessons: git");
      expect(rows[0].markdown).toMatch(/^### Never force-push shared branches（\d{4}-\d{2}-\d{2}）$/m);
      expect(rows[0].markdown).toContain(`- **Rule**: ${LESSON.rule}`);
      expect(rows[0].markdown).toContain(`- **Evidence**: ${LESSON.evidence}`);
      expect(rows[0].description).toContain("Never force-push shared branches");
      const versions = await lessonsVersionRows(f.company.id);
      expect(versions).toHaveLength(1);
      expect(versions[0].authorUserId).toBe(kind === "admin sponsor" ? "admin-u" : "owner-u");
      const [agentRow] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
      expect(
        (agentRow.adapterConfig as Record<string, { desiredSkills?: string[] }>).paperclipSkillSync?.desiredSkills,
      ).toContain(`company/${f.company.id}/lessons-git`);
    },
  );

  it("record is idempotent per domain and trigger", async () => {
    const f = await fixture();
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    await record(s, LESSON);
    // Same trigger, different casing and spacing: still the same lesson.
    const replay = await record(s, {
      ...LESSON,
      trigger: "never   force-push SHARED branches",
      rule: "Rewritten rule must not be stored twice.",
    });
    expect(replay).toMatchObject({ recorded: false, alreadyCaptured: true });
    expect(await lessonsSkillRows(f.company.id)).toHaveLength(1);
    expect(await lessonsVersionRows(f.company.id)).toHaveLength(1);
    const [row] = await lessonsSkillRows(f.company.id);
    expect(row.markdown).not.toContain("Rewritten rule must not be stored twice.");
  });

  it("record appends further lessons to the same domain skill", async () => {
    const f = await fixture();
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    await record(s, LESSON);
    const second = await record(s, {
      domain: "git",
      trigger: "Rebase onto the target branch before opening a PR",
      rule: "Rebase locally; never ask reviewers to resolve conflicts.",
      evidence: "PR 14 accumulated merge knots after two upstream lands.",
    });
    expect(second).toMatchObject({ recorded: true, alreadyCaptured: false });
    const rows = await lessonsSkillRows(f.company.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].markdown).toContain("### Rebase onto the target branch before opening a PR");
    expect(rows[0].markdown).toContain("### Never force-push shared branches");
    expect(rows[0].description).toContain("Rebase onto the target branch before opening a PR");
    expect(await lessonsVersionRows(f.company.id)).toHaveLength(2);
  });

  it("record rejects an invalid body before touching the skill library", async () => {
    const f = await fixture();
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    await expect(
      record(s, { ...LESSON, domain: "git/../escape" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(record(s, { ...LESSON, rule: "no" })).rejects.toMatchObject({ status: 422 });
    expect(await lessonsSkillRows(f.company.id)).toHaveLength(0);
  });

  it("propose reports alreadyCaptured once a lesson is stored", async () => {
    const f = await fixture();
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    await record(s, LESSON);
    const result = await propose(session(f.company.id, f.agent.id), LESSON);
    expect(result).toMatchObject({ valid: true, alreadyCaptured: true });
  });

  it("record without an agent session stores the lesson without assigning anyone", async () => {
    const f = await fixture();
    const s = session(f.company.id, null, {
      actorType: "user",
      actorId: "owner-u",
      responsibleUserId: "owner-u",
    });
    const result = await record(s, LESSON);
    expect(result).toMatchObject({ recorded: true, assignedToAgent: false });
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(agentRow.adapterConfig).toEqual({});
  });

  it("propose and record reject multiline lesson fields", async () => {
    const f = await fixture();
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    const multiline = { ...LESSON, trigger: "Push safely\nbefore release" };
    const draft = await propose(s, multiline);
    expect(draft).toMatchObject({ valid: false });
    expect(draft.issues).toContainEqual(expect.objectContaining({ path: "trigger" }));
    await expect(record(s, multiline)).rejects.toMatchObject({ status: 422 });
    expect(await lessonsSkillRows(f.company.id)).toHaveLength(0);
  });

  it("record clears a stale version pin on the lessons skill assignment", async () => {
    const f = await fixture();
    const skillKey = `company/${f.company.id}/lessons-git`;
    const pinnedVersionId = randomUUID();
    await db
      .update(agents)
      .set({
        adapterConfig: {
          paperclipSkillSync: { desiredSkills: [{ key: skillKey, versionId: pinnedVersionId }] },
        },
      })
      .where(eq(agents.id, f.agent.id));
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    const result = await record(s, LESSON);
    expect(result).toMatchObject({ recorded: true, assignedToAgent: true });
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(
      (agentRow.adapterConfig as Record<string, { desiredSkills?: string[] }>).paperclipSkillSync?.desiredSkills,
    ).toEqual([skillKey]);
  });

  it("record keeps assignments for every domain recorded by the agent", async () => {
    const f = await fixture();
    const s = session(f.company.id, f.agent.id, { responsibleUserId: "admin-u" });
    await record(s, LESSON);
    await record(s, {
      domain: "ci",
      trigger: "Never skip the typecheck layer locally",
      rule: "Run the layered typecheck before pushing.",
      evidence: "A broken layer slipped through twice in one week.",
    });
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(
      (agentRow.adapterConfig as Record<string, { desiredSkills?: string[] }>).paperclipSkillSync?.desiredSkills,
    ).toEqual([
      `company/${f.company.id}/lessons-git`,
      `company/${f.company.id}/lessons-ci`,
    ]);
  });

  it("resolves and executes the lesson tools through the gateway", async () => {
    const f = await fixture();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.company.id,
        agentId: f.agent.id,
        status: "running",
        contextSnapshot: {},
        responsibleUserId: "admin-u",
      })
      .returning();
    const [profile] = await db
      .insert(toolProfiles)
      .values({
        companyId: f.company.id,
        profileKey: `lessons-all-${randomUUID().slice(0, 8)}`,
        name: `Lessons profile ${randomUUID().slice(0, 8)}`,
        defaultAction: "allow",
      })
      .returning();
    await db.insert(toolProfileBindings).values({
      companyId: f.company.id,
      profileId: profile.id,
      targetType: "agent",
      targetId: f.agent.id,
    });
    const gateway = createToolGatewayService(db);
    const gatewaySession = await gateway.createSession({
      companyId: f.company.id,
      agentId: f.agent.id,
      runId: run.id,
    });
    const result = await gateway.executeTool({
      sessionToken: gatewaySession.token,
      tool: "lesson-capture:propose_lesson",
      parameters: LESSON,
    });
    expect(result).toMatchObject({ status: "completed", tool: "lesson-capture:propose_lesson" });
    expect(result.result).toMatchObject({
      data: {
        valid: true,
        stored: false,
        domain: "git",
        alreadyCaptured: false,
      },
    });
    expect(await lessonsSkillRows(f.company.id)).toHaveLength(0);
  });
});
