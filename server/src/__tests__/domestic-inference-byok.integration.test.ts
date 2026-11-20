import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  agents, authUsers, closeRegisteredClients, companies, companyMemberships, companySecretVersions, companySecrets,
  connectionGrants, createDb, toolConnections, toolConnectionInstalls,
} from "@paperclipai/db";
import express, { type Request } from "express";
import request from "supertest";
import { domesticDefaultRouting, type AiConnectionBinding } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_DOMESTIC_AI_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping domestic AI PostgreSQL integration on this host: ${support.reason ?? "embedded PostgreSQL unavailable"}`);
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("domestic inference BYOK with real PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let embedded: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let isolatedHome: ReturnType<typeof createIsolatedTestHome>;
  let request_ : MockInstance<typeof fetch>;

  beforeAll(async () => {
    isolatedHome = createIsolatedTestHome();
    vi.stubEnv("PAPERCLIP_HOME", isolatedHome.home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "domestic-ai-real-db");
    if (!external) embedded = await startEmbeddedPostgresTestDatabase("paperclip-domestic-ai-db-");
    db = createDb(external ?? embedded!.connectionString);
    request_ = vi.spyOn(globalThis, "fetch");
  }, 90_000);
  beforeEach(() => { request_.mockReset().mockRejectedValue(new Error("Provider network is forbidden in domestic BYOK tests")); });
  afterAll(async () => {
    request_?.mockRestore();
    if (external) await closeRegisteredClients(external);
    await db?.$client.end();
    await embedded?.cleanup();
    vi.unstubAllEnvs();
    isolatedHome?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
    const owner = `domestic-owner-${randomUUID()}`, member = `domestic-member-${randomUUID()}`, foreign = `domestic-foreign-${randomUUID()}`;
    await db.insert(companies).values([
      { id: companyId, name: "Domestic BYOK fixture", issuePrefix: `DBF${companyId.slice(0, 8)}` },
      { id: otherCompanyId, name: "Foreign domestic fixture", issuePrefix: `DBX${otherCompanyId.slice(0, 8)}` },
    ]);
    await db.insert(authUsers).values([owner, member, foreign].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companyMemberships).values([
      { companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "owner" },
      { companyId, principalId: member, principalType: "user", status: "active", membershipRole: "member" },
      { companyId: otherCompanyId, principalId: foreign, principalType: "user", status: "active", membershipRole: "owner" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Domestic runner", adapterType: "opencode_local" });
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res, next) => {
      const userId = String(req.headers["x-test-user"] ?? owner);
      const role = String(req.headers["x-test-role"] ?? (userId === member ? "member" : userId === foreign ? "foreign" : "owner"));
      req.actor = role === "foreign"
        ? { type: "board", source: "session", userId: foreign, companyIds: [otherCompanyId], memberships: [{ companyId: otherCompanyId, membershipRole: "owner", status: "active" }] }
        : { type: "board", source: "session", userId, companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] };
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    return { companyId, otherCompanyId, agentId, owner, member, foreign, service: aiConnectionService(db), app, base: `/api/companies/${companyId}/ai-connections` };
  }

  const sharedIntent = (provider: "deepseek" | "zhipu" | "moonshot" | "minimax", apiKey: string) => ({
    provider, method: "api_key" as const, ownership: "shared" as const, name: `${provider} company key`, apiKey, allAgents: true, agentIds: [],
  });

  it("saves a company-shared domestic connection with the injected default routing and a masked key", async () => {
    const f = await fixture();
    request_.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const created = await request(f.app).post(f.base).send(sharedIntent("deepseek", "fixture-deepseek-key"));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(request_).toHaveBeenCalledTimes(1);
    expect(String(request_.mock.calls[0]![0])).toBe("https://api.deepseek.com/models");
    expect(created.body).toEqual({ connectionId: expect.any(String), grantId: expect.any(String) });
    expect(JSON.stringify(created.body)).not.toContain("fixture-deepseek-key");
    const summary = (await f.service.list(f.companyId, f.owner)).find(row => row.id === created.body.connectionId);
    expect(summary).toMatchObject({ provider: "deepseek", method: "api_key", routing: domesticDefaultRouting("deepseek"), isDefault: false });
    expect(JSON.stringify(summary)).not.toContain("fixture-deepseek-key");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, created.body.grantId));
    expect(grant).toMatchObject({ kind: "organization", status: "active" });
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, created.body.connectionId));
    expect(installs).toEqual([expect.objectContaining({ targetType: "company", targetId: f.companyId })]);
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId));
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id));
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(versions)).not.toContain("fixture-deepseek-key");
    expect(request_).toHaveBeenCalledTimes(1);
  });

  it("skips provider probing only for base URL overrides and still validates official-endpoint routing", async () => {
    const f = await fixture();
    const override = await request(f.app).post(f.base).send({
      ...sharedIntent("moonshot", "fixture-moonshot-key"),
      routing: { kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: "https://gateway.internal/v1", models: [] },
    });
    expect(override.status, JSON.stringify(override.body)).toBe(201);
    expect(request_).not.toHaveBeenCalled();
    expect((await f.service.list(f.companyId, f.owner)).find(row => row.id === override.body.connectionId)?.routing).toEqual({
      ...domesticDefaultRouting("moonshot"), baseUrl: "https://gateway.internal/v1",
    });
    request_.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const rejected = await request(f.app).post(f.base).send({
      ...sharedIntent("moonshot", "fixture-moonshot-key-2"),
      routing: { kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: "https://api.moonshot.cn/v1", models: [{ id: "custom-model" }] },
    });
    expect(rejected.status).toBe(422);
    expect(JSON.stringify(rejected.body)).not.toContain("fixture-moonshot-key-2");
    expect(String(request_.mock.calls[0]![0])).toBe("https://api.moonshot.cn/v1/models");
    request_.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const custom = await request(f.app).post(f.base).send({
      ...sharedIntent("moonshot", "fixture-moonshot-key-2"),
      routing: { kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: "https://api.moonshot.cn/v1", models: [{ id: "custom-model" }] },
    });
    expect(custom.status, JSON.stringify(custom.body)).toBe(201);
    expect((await f.service.list(f.companyId, f.owner)).find(row => row.id === custom.body.connectionId)?.routing).toMatchObject({
      baseUrl: "https://api.moonshot.cn/v1", models: [{ id: "custom-model" }],
    });
  });

  it("projects the shared domestic connection into the opencode harness and strips ambient provider credentials", async () => {
    const f = await fixture();
    const saved = await f.service.save(f.companyId, f.owner, { ...sharedIntent("zhipu", "fixture-zhipu-key"), routing: domesticDefaultRouting("zhipu") }, "fixture-zhipu-key");
    const binding = { provider: "zhipu", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId } satisfies AiConnectionBinding;
    const runtime = await prepareManagedAiRuntime(db, {
      companyId: f.companyId, responsibleUserId: f.owner, agentId: f.agentId, adapterType: "opencode_local", binding,
      config: { model: "glm-4.5", env: { ZHIPU_API_KEY: "ambient-zhipu", ANTHROPIC_API_KEY: "ambient-anthropic" } },
    });
    try {
      expect(runtime.attribution).toMatchObject({ provider: "zhipu", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId });
      expect(runtime.config.env.PAPERCLIP_AI_PROVIDER_KEY).toBe("fixture-zhipu-key");
      expect(runtime.config.env.PAPERCLIP_AI_PROVIDER_URL).toBe("https://open.bigmodel.cn/api/paas/v4");
      expect(JSON.parse(String(runtime.config.env.OPENCODE_CONFIG_CONTENT)).provider.paperclip.options).toEqual({
        baseURL: "https://open.bigmodel.cn/api/paas/v4", apiKey: "fixture-zhipu-key",
      });
      expect(runtime.config.env.ZHIPU_API_KEY).toBe("");
      expect(runtime.config.env.ANTHROPIC_API_KEY).toBe("");
      expect(request_).not.toHaveBeenCalled();
    } finally { await runtime.cleanup(); }
  });

  it("resolves the three-state domestic fallback and never treats a routed connection as a personal default", async () => {
    const f = await fixture();
    const saved = await f.service.save(f.companyId, f.owner, { ...sharedIntent("moonshot", "fixture-moonshot-key"), routing: domesticDefaultRouting("moonshot") }, "fixture-moonshot-key");
    const binding = { provider: "moonshot", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId } satisfies AiConnectionBinding;
    expect(await f.service.inferenceBindingAvailable(f.companyId, f.owner, binding)).toBe(true);
    expect(await f.service.inferenceBindingAvailable(f.otherCompanyId, f.foreign, binding)).toBe(false);
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, saved.connectionId));
    expect(await f.service.inferenceBindingAvailable(f.companyId, f.owner, binding)).toBe(false);
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, saved.connectionId));
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, saved.grantId));
    expect(await f.service.inferenceBindingAvailable(f.companyId, f.owner, binding)).toBe(false);
    const responsible = { provider: "moonshot", method: "api_key", mode: "responsible_user" } satisfies AiConnectionBinding;
    expect(await f.service.inferenceBindingAvailable(f.companyId, f.owner, responsible)).toBe(false);
    const personal = await f.service.save(f.companyId, f.owner, {
      provider: "moonshot", method: "api_key", ownership: "personal", name: "Personal moonshot",
      apiKey: "fixture-personal-key", allAgents: false, agentIds: [f.agentId], routing: domesticDefaultRouting("moonshot"),
    }, "fixture-personal-key");
    expect(await f.service.inferenceBindingAvailable(f.companyId, f.owner, responsible)).toBe(false);
    await expect(f.service.setDefault(f.companyId, f.owner, personal.grantId)).rejects.toThrow("Custom providers use an explicit connection selection");
    expect(request_).not.toHaveBeenCalled();
  });

  it("resolves a template inference reference through the hiring company's admission and drops unusable ones", async () => {
    const f = await fixture();
    const saved = await f.service.save(f.companyId, f.owner, { ...sharedIntent("deepseek", "fixture-deepseek-key"), routing: domesticDefaultRouting("deepseek") }, "fixture-deepseek-key");
    const resolve = (connectionId: string) => f.service.templateInferenceBinding({
      companyId: f.companyId, userId: f.owner, agentId: f.agentId, adapterType: "opencode_local",
      model: "deepseek-chat", connectionId,
    });
    expect(await resolve(saved.connectionId)).toEqual({
      provider: "deepseek", method: "api_key", mode: "shared", connectionId: saved.connectionId, grantId: saved.grantId,
    });
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, saved.connectionId));
    expect(await resolve(saved.connectionId)).toBeUndefined();
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, saved.connectionId));
    expect(await f.service.templateInferenceBinding({
      companyId: f.otherCompanyId, userId: f.foreign, agentId: f.agentId, adapterType: "opencode_local",
      model: "deepseek-chat", connectionId: saved.connectionId,
    })).toBeUndefined();
    expect(await f.service.templateInferenceBinding({
      companyId: f.companyId, userId: f.owner, agentId: f.agentId, adapterType: "claude_local",
      model: "deepseek-chat", connectionId: saved.connectionId,
    })).toBeUndefined();
    expect(request_).not.toHaveBeenCalled();
  });

  it("authorizes shared domestic connections for connection managers only and keeps them company-scoped", async () => {
    const f = await fixture();
    request_.mockResolvedValue(new Response("{}", { status: 200 }));
    expect((await request(f.app).post(f.base).set("x-test-user", f.member).send(sharedIntent("minimax", "fixture-minimax-key"))).status).toBe(403);
    expect((await request(f.app).post(f.base).set("x-test-user", f.member).set("x-test-role", "viewer").send(sharedIntent("minimax", "fixture-minimax-key"))).status).toBe(403);
    expect((await request(f.app).post(f.base.replace(f.companyId, f.otherCompanyId)).send(sharedIntent("minimax", "fixture-minimax-key"))).status).toBe(403);
    expect(request_).not.toHaveBeenCalled();
    const created = await request(f.app).post(f.base).send(sharedIntent("minimax", "fixture-minimax-key"));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const own = await request(f.app).get(f.base);
    expect(own.status).toBe(200);
    expect(own.body.connections.find((row: { id: string }) => row.id === created.body.connectionId)).toMatchObject({
      provider: "minimax", routing: domesticDefaultRouting("minimax"),
    });
    expect(JSON.stringify(own.body)).not.toContain("fixture-minimax-key");
    expect((await request(f.app).get(f.base).set("x-test-user", f.foreign)).status).toBe(403);
    expect(request_).toHaveBeenCalledTimes(1);
  });
});
