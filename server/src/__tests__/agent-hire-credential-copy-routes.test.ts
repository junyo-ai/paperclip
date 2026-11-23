import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  environments,
  approvals,
  principalPermissionGrants,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-hire credential copy route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

// The fixed Claude Code OAuth binding. It is a user-secret reference to the
// fixed key. Copying it to another agent would trip the create-transaction
// binding invariant, so the copy path must skip it and report that.
const FIXED_CLAUDE_OAUTH_BINDING = { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } as const;

// The local implicit board actor always passes authorization, so it stands in
// for a user actor without needing a seeded company membership. The hire
// dialog is an operator flow, so the copy tests hire as a board actor.
function userActor(): Express.Request["actor"] {
  return { type: "board", userId: "local-board", source: "local_implicit" };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("hired agent credential binding copy", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-hire-credential-copy-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-hire-credential-copy-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(userSecretDeclarations);
    await db.delete(userSecretDefinitions);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(requireBoardApproval = false) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Cred Copy Co ${companyId.slice(0, 8)}`,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: requireBoardApproval,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, adapterType: string, env: Record<string, unknown>,
    extraConfig: Record<string, unknown> = {}) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Source ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        adapterType,
        adapterConfig: { env, ...extraConfig },
        runtimeConfig: {},
        permissions: { canCreateAgents: true },
      })
      .returning();
    return row!;
  }

  async function createCompanySecret(companyId: string, value: string) {
    return secretService(db).create(companyId, {
      name: `cred-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
  }

  function secretRef(secretId: string, extra: Record<string, unknown> = {}) {
    return { type: "secret_ref" as const, secretId, ...extra };
  }

  function hire(actor: Express.Request["actor"], companyId: string, payload: Record<string, unknown>) {
    const app = createApp(db, actor);
    return request(app).post(`/api/companies/${companyId}/agent-hires`).send(payload);
  }

  function childEnvOf(res: request.Response): Record<string, unknown> {
    return ((res.body.agent?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env) ?? {};
  }

  function childBindings(companyId: string, agentId: string) {
    return db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.companyId, companyId),
          eq(companySecretBindings.targetType, "agent"),
          eq(companySecretBindings.targetId, agentId),
        ),
      );
  }

  it("copies the source agent's credential references and derives the child bindings", async () => {
    const companyId = await seedCompany();
    const githubSecret = await createCompanySecret(companyId, "ghp-copied-pat");
    const anthropicSecret = await createCompanySecret(companyId, "sk-ant-copied");
    const source = await seedAgent(companyId, "claude_local", {
      GITHUB_TOKEN: secretRef(githubSecret.id),
      ANTHROPIC_API_KEY: secretRef(anthropicSecret.id, { version: 2 }),
    });

    const res = await hire(userActor(), companyId, {
      name: "Copied Bindings Child",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).GITHUB_TOKEN).toMatchObject({ type: "secret_ref", secretId: githubSecret.id });
    expect(childEnvOf(res).ANTHROPIC_API_KEY).toMatchObject({
      type: "secret_ref",
      secretId: anthropicSecret.id,
      version: 2,
    });
    // The copy flag is consumed at hire time; it never persists on the agent.
    expect(JSON.stringify(res.body)).not.toContain("copyCredentialBindingsFromAgentId");

    const bindings = await childBindings(companyId, res.body.agent.id);
    expect(bindings).toHaveLength(2);
    expect(bindings.find(row => row.configPath === "env.GITHUB_TOKEN")).toMatchObject({
      secretId: githubSecret.id,
      versionSelector: "latest",
    });
    expect(bindings.find(row => row.configPath === "env.ANTHROPIC_API_KEY")).toMatchObject({
      secretId: anthropicSecret.id,
      versionSelector: "2",
    });
  });

  it("copies a hermes gateway apiKey binding onto a hermes hire", async () => {
    const companyId = await seedCompany();
    const gatewaySecret = await createCompanySecret(companyId, "hermes-copied-key");
    const source = await seedAgent(companyId, "hermes_gateway", {}, {
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: secretRef(gatewaySecret.id),
    });

    const res = await hire(userActor(), companyId, {
      name: "Hermes Copy Child",
      role: "engineer",
      adapterType: "hermes_gateway",
      adapterConfig: { apiBaseUrl: "http://127.0.0.1:8642" },
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent?.adapterConfig?.apiKey).toMatchObject({ type: "secret_ref", secretId: gatewaySecret.id });
    const bindings = await childBindings(companyId, res.body.agent.id);
    expect(bindings.find(row => row.configPath === "apiKey")).toMatchObject({
      secretId: gatewaySecret.id,
      versionSelector: "latest",
    });
  });

  it("does not copy a hermes apiKey binding onto a hire of another adapter", async () => {
    const companyId = await seedCompany();
    const gatewaySecret = await createCompanySecret(companyId, "hermes-copied-key");
    const source = await seedAgent(companyId, "hermes_gateway", {}, {
      apiBaseUrl: "http://127.0.0.1:8642",
      apiKey: secretRef(gatewaySecret.id),
    });

    const res = await hire(userActor(), companyId, {
      name: "Claude Child From Hermes Source",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent?.adapterConfig?.apiKey).toBeUndefined();
  });

  it("lets a key the hire request supplies win over the copied reference", async () => {
    const companyId = await seedCompany();
    const sourceSecret = await createCompanySecret(companyId, "ghp-source-pat");
    const childSecret = await createCompanySecret(companyId, "ghp-child-pat");
    const source = await seedAgent(companyId, "claude_local", {
      GITHUB_TOKEN: secretRef(sourceSecret.id),
    });

    const res = await hire(userActor(), companyId, {
      name: "Child Wins Copy",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: { env: { GITHUB_TOKEN: secretRef(childSecret.id) } },
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).GITHUB_TOKEN).toMatchObject({ type: "secret_ref", secretId: childSecret.id });
    const bindings = await childBindings(companyId, res.body.agent.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ configPath: "env.GITHUB_TOKEN", secretId: childSecret.id });
  });

  it("does not copy plain environment values", async () => {
    const companyId = await seedCompany();
    const source = await seedAgent(companyId, "claude_local", {
      GITHUB_TOKEN: "ghp-plain-value",
      SOME_PATH: { type: "plain", value: "/plain/path" },
    });

    const res = await hire(userActor(), companyId, {
      name: "Plain Value Copy Attempt",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    expect(childEnv.SOME_PATH).toBeUndefined();
    expect(await childBindings(companyId, res.body.agent.id)).toHaveLength(0);
  });

  it("skips the fixed Claude OAuth binding and reports a credential_binding_skipped warning", async () => {
    const companyId = await seedCompany();
    const anthropicSecret = await createCompanySecret(companyId, "sk-ant-oauth-source");
    const source = await seedAgent(companyId, "claude_local", {
      CLAUDE_CODE_OAUTH_TOKEN: { ...FIXED_CLAUDE_OAUTH_BINDING },
      ANTHROPIC_API_KEY: secretRef(anthropicSecret.id),
    });

    const res = await hire(userActor(), companyId, {
      name: "OAuth Skip Child",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(childEnv.ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref", secretId: anthropicSecret.id });
    // The child holds no Claude claim: the source agent keeps its own.
    expect(await db.select().from(userSecretDeclarations).where(eq(userSecretDeclarations.targetId, res.body.agent.id))).toHaveLength(0);

    const warnings = (res.body.agent.configurationWarnings ?? []) as Array<{ code: string; field: string; message: string }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "credential_binding_skipped", field: "copyCredentialBindingsFromAgentId" });
    expect(warnings[0].message).toContain(source.name);
    expect(JSON.stringify(warnings)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN_VALUE");
  });

  it("rejects a copy source in another company with 422 and creates no agent", async () => {
    const sourceCompanyId = await seedCompany();
    const targetCompanyId = await seedCompany();
    const secret = await createCompanySecret(sourceCompanyId, "ghp-cross-company");
    const source = await seedAgent(sourceCompanyId, "claude_local", {
      GITHUB_TOKEN: secretRef(secret.id),
    });

    const res = await hire(userActor(), targetCompanyId, {
      name: "Cross Company Copy Attempt",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("same company");
    expect(await db.select().from(agents).where(eq(agents.companyId, targetCompanyId))).toHaveLength(0);
    expect(await childBindings(targetCompanyId, source.id)).toHaveLength(0);
  });

  it("rejects an unknown copy source with 422", async () => {
    const companyId = await seedCompany();
    const res = await hire(userActor(), companyId, {
      name: "Unknown Source Copy Attempt",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: randomUUID(),
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("copyCredentialBindingsFromAgentId");
  });

  it("omits the flag for a hire with no copy source and warns nothing", async () => {
    const companyId = await seedCompany();
    const res = await hire(userActor(), companyId, {
      name: "No Copy Source Child",
      role: "engineer",
      adapterType: "claude_local",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.configurationWarnings).toBeUndefined();
    expect(Object.keys(childEnvOf(res))).toHaveLength(0);
  });

  it("keeps copied references in a pending-approval hire snapshot", async () => {
    const companyId = await seedCompany(true);
    const githubSecret = await createCompanySecret(companyId, "ghp-approval-pat");
    const source = await seedAgent(companyId, "claude_local", {
      GITHUB_TOKEN: secretRef(githubSecret.id),
    });

    const res = await hire(userActor(), companyId, {
      name: "Approval Copy Child",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent.status).toBe("pending_approval");
    const approvalEnv = ((res.body.approval?.payload?.adapterConfig as { env?: Record<string, unknown> } | undefined)?.env) ?? {};
    expect(approvalEnv.GITHUB_TOKEN).toMatchObject({ type: "secret_ref", secretId: githubSecret.id });
  });

  async function grantConfigRead(companyId: string, agentId: string, sourceId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey: "agents:read",
      scope: { agentIds: [sourceId] },
      grantedByUserId: null,
    });
  }

  it("rejects a copy source whose configuration the agent actor cannot read", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "ghp-unreadable-source");
    const source = await seedAgent(companyId, "claude_local", {
      GITHUB_TOKEN: secretRef(secret.id),
    });
    const caller = await seedAgent(companyId, "claude_local", {});

    const res = await hire(agentActor(companyId, caller.id), companyId, {
      name: "Unreadable Source Copy Attempt",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("not readable");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(2);
  });

  it("copies bindings for an agent actor with an agents:read grant on the source", async () => {
    const companyId = await seedCompany();
    const secret = await createCompanySecret(companyId, "ant-granted-source");
    const source = await seedAgent(companyId, "claude_local", {
      ANTHROPIC_API_KEY: secretRef(secret.id),
    });
    const caller = await seedAgent(companyId, "claude_local", {});
    await grantConfigRead(companyId, caller.id, source.id);

    const res = await hire(agentActor(companyId, caller.id), companyId, {
      name: "Granted Copy Child",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(childEnvOf(res).ANTHROPIC_API_KEY).toMatchObject({ type: "secret_ref", secretId: secret.id });
  });

  it("does not copy ANTHROPIC_API_KEY onto a hire that holds the fixed Claude OAuth binding", async () => {
    const companyId = await seedCompany();
    const anthropicSecret = await createCompanySecret(companyId, "sk-ant-copy-source");
    const source = await seedAgent(companyId, "claude_local", {
      ANTHROPIC_API_KEY: secretRef(anthropicSecret.id),
    });
    const parent = await seedAgent(companyId, "claude_local", {
      CLAUDE_CODE_OAUTH_TOKEN: {
        ...FIXED_CLAUDE_OAUTH_BINDING,
        version: "latest",
        required: true,
        allowMissingOverride: false,
      },
    });
    await grantConfigRead(companyId, parent.id, source.id);

    const res = await hire(agentActor(companyId, parent.id), companyId, {
      name: "OAuth Hold Copy Child",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const childEnv = childEnvOf(res);
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toMatchObject({ type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" });
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    const warnings = (res.body.agent.configurationWarnings ?? []) as Array<{ code: string; message: string }>;
    expect(warnings.some(warning =>
      warning.code === "credential_binding_skipped" && warning.message.includes("ANTHROPIC_API_KEY"),
    )).toBe(true);
  });

  it("rejects copied keys the agent local-adapter guard would reject for a direct request", async () => {
    const companyId = await seedCompany();
    const preloadSecret = await createCompanySecret(companyId, "libpreload.so.1");
    const source = await seedAgent(companyId, "claude_local", {
      LD_PRELOAD: secretRef(preloadSecret.id),
    });
    const caller = await seedAgent(companyId, "claude_local", {});
    await grantConfigRead(companyId, caller.id, source.id);

    const res = await hire(agentActor(companyId, caller.id), companyId, {
      name: "Guarded Copy Attempt",
      role: "engineer",
      adapterType: "claude_local",
      copyCredentialBindingsFromAgentId: source.id,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Agent keys cannot configure host-executed local adapter settings");
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(2);
  });
});
