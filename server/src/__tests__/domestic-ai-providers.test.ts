import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DOMESTIC_AI_PROVIDERS,
  DOMESTIC_AI_PROVIDER_DEFAULTS,
  aiConnectionCatalogSlug,
  createAiConnectionSchema,
  domesticDefaultRouting,
  isAiConnectionCompatible,
  isDomesticAiProvider,
  roleTemplateSpecSchema,
} from "@paperclipai/shared";
import { validateAiApiKey } from "../services/ai-api-key-test.js";

const VALIDATE_ENDPOINTS = {
  deepseek: "https://api.deepseek.com/models",
  zhipu: "https://open.bigmodel.cn/api/paas/v4/models",
  moonshot: "https://api.moonshot.cn/v1/models",
  minimax: "https://api.minimax.chat/v1/models",
} as const;

describe("domestic AI provider registry", () => {
  it.each(DOMESTIC_AI_PROVIDERS)("validates a %s API key against its fixed official endpoint", async (provider) => {
    const request = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(validateAiApiKey(provider, "fixture-key", request)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe(VALIDATE_ENDPOINTS[provider]);
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fixture-key");
  });

  it.each(DOMESTIC_AI_PROVIDERS)("maps a rejected %s key to a provider rejection without leaking the response", async (provider) => {
    const request = vi.fn().mockResolvedValue(new Response("secret-provider-body", { status: 401 }));
    const rejection = (await validateAiApiKey(provider, "fixture-key", request).catch((error: unknown) => error)) as Error;
    expect(rejection).toMatchObject({ status: 422 });
    expect(rejection.message).toBe("The provider rejected this API key.");
  });

  it.each(DOMESTIC_AI_PROVIDERS)("reports an unreachable %s endpoint as a verification failure", async (provider) => {
    const request = vi.fn().mockRejectedValue(new Error("network down"));
    const rejection = (await validateAiApiKey(provider, "fixture-key", request).catch((error: unknown) => error)) as Error;
    expect(rejection).toMatchObject({ status: 422 });
    expect(rejection.message).not.toContain("network down");
  });

  it.each(DOMESTIC_AI_PROVIDERS)("accepts %s API-key connections with and without chat gateway routing", (provider) => {
    const base = { provider, method: "api_key" as const, name: "Fixture", ownership: "personal" as const, apiKey: "fixture-key" };
    expect(createAiConnectionSchema.parse(base)).not.toHaveProperty("routing");
    const routing = domesticDefaultRouting(provider);
    expect(createAiConnectionSchema.parse({ ...base, routing })).toMatchObject({ routing });
    expect(createAiConnectionSchema.parse({ ...base, routing: { ...routing, baseUrl: "https://gateway.internal/v1" } })).toMatchObject({
      routing: { kind: "gateway", baseUrl: "https://gateway.internal/v1" },
    });
  });

  it.each(DOMESTIC_AI_PROVIDERS)("rejects %s subscriptions and non-chat routing shapes", (provider) => {
    const base = { provider, name: "Fixture", ownership: "personal" as const };
    const subscription = createAiConnectionSchema.safeParse({ ...base, method: "subscription", loginSessionId: "fixture-session" });
    expect(subscription.success).toBe(false);
    expect(subscription.error!.issues.map((issue) => issue.message)).toContain("Unsupported sign-in method");
    const messages = createAiConnectionSchema.safeParse({ ...base, method: "api_key", apiKey: "fixture-key", routing: { kind: "gateway" as const, protocol: "messages" as const, auth: "bearer" as const, models: [] } });
    expect(messages.success).toBe(false);
    expect(messages.error!.issues.map((issue) => issue.message)).toContain("The provider must match the endpoint’s API format.");
    const responses = createAiConnectionSchema.safeParse({ ...base, method: "api_key", apiKey: "fixture-key", routing: { kind: "gateway" as const, protocol: "responses" as const, auth: "bearer" as const, models: [] } });
    expect(responses.success).toBe(false);
    const unauthenticated = createAiConnectionSchema.safeParse({ ...base, method: "api_key", routing: { kind: "gateway" as const, protocol: "chat" as const, auth: "none" as const, baseUrl: domesticDefaultRouting(provider).baseUrl, models: [] } });
    expect(unauthenticated.success).toBe(false);
    expect(unauthenticated.error!.issues.map((issue) => issue.message)).toContain("Domestic providers require an API key.");
  });

  it.each(DOMESTIC_AI_PROVIDERS)("derives the %s default routing with copied catalog models", (provider) => {
    const defaults = DOMESTIC_AI_PROVIDER_DEFAULTS[provider];
    const routing = domesticDefaultRouting(provider);
    expect(routing).toEqual({ kind: "gateway", protocol: "chat", auth: "bearer", baseUrl: defaults.baseUrl, models: [...defaults.models] });
    routing.models.splice(0, routing.models.length);
    expect(domesticDefaultRouting(provider).models).toEqual([...defaults.models]);
    expect(domesticDefaultRouting(provider, "https://override.example/v1").baseUrl).toBe("https://override.example/v1");
    expect(domesticDefaultRouting(provider, "   ").baseUrl).toBe(defaults.baseUrl);
  });

  it("recognizes only the four domestic providers", () => {
    for (const provider of DOMESTIC_AI_PROVIDERS) expect(isDomesticAiProvider(provider)).toBe(true);
    for (const provider of ["anthropic", "openai", "openrouter", "xai", "google", "github", ""]) expect(isDomesticAiProvider(provider)).toBe(false);
  });

  it("keeps domestic catalog slugs provider-scoped and preserves routed catalog rules for other providers", () => {
    expect(aiConnectionCatalogSlug("deepseek", domesticDefaultRouting("deepseek"))).toBe("deepseek");
    expect(aiConnectionCatalogSlug("zhipu")).toBe("zhipu");
    expect(aiConnectionCatalogSlug("openai", { kind: "gateway", protocol: "chat" })).toBe("chat-completions-api");
    expect(aiConnectionCatalogSlug("anthropic", { kind: "gateway", protocol: "messages" })).toBe("messages-api");
  });

  it.each(DOMESTIC_AI_PROVIDERS)("restricts %s connections to chat-completions harnesses", (provider) => {
    const binding = { provider, method: "api_key" as const, mode: "responsible_user" as const };
    expect(isAiConnectionCompatible(binding, "opencode_local")).toBe(true);
    expect(isAiConnectionCompatible(binding, "claude_local")).toBe(false);
    expect(isAiConnectionCompatible(binding, "codex_local")).toBe(false);
    expect(isAiConnectionCompatible(binding, "pi_local")).toBe(false);
    const routed = { provider, method: "api_key" as const, routing: domesticDefaultRouting(provider) };
    expect(isAiConnectionCompatible(routed, "opencode_local")).toBe(true);
    expect(isAiConnectionCompatible(routed, "hermes_local")).toBe(true);
    expect(isAiConnectionCompatible(routed, "claude_local")).toBe(false);
    expect(isAiConnectionCompatible(routed, "antigravity_runtime")).toBe(false);
  });

  it("accepts an optional UUID inference connection reference on role-template defaults", () => {
    const spec = (inferenceConnectionId?: string) => roleTemplateSpecSchema.safeParse({
      templateName: "Domestic inference reviewer",
      character: { personaPrompt: "d".repeat(200), title: "Reviewer", role: "general" },
      skills: [{ key: "code-review", reason: "Reviews changes" }],
      defaults: inferenceConnectionId ? { inferenceConnectionId } : {},
      rationale: [],
    });
    expect(spec(randomUUID()).success).toBe(true);
    expect(spec().success).toBe(true);
    expect(spec("not-a-uuid").success).toBe(false);
  });
});
