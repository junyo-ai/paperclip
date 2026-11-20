import type { AiProviderRouting } from "./ai-provider-routing.js";

export const DOMESTIC_AI_PROVIDERS = [
  "deepseek",
  "zhipu",
  "moonshot",
  "minimax",
] as const;
export type DomesticAiProvider = (typeof DOMESTIC_AI_PROVIDERS)[number];

export const DOMESTIC_AI_PROVIDER_DEFAULTS: Record<
  DomesticAiProvider,
  { baseUrl: string; models: readonly { id: string; label?: string }[] }
> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [
      { id: "glm-4.5", label: "GLM-4.5" },
      { id: "glm-4.5-air", label: "GLM-4.5 Air" },
      { id: "glm-4.5-flash", label: "GLM-4.5 Flash" },
    ],
  },
  moonshot: {
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      { id: "kimi-k2-0905-preview", label: "Kimi K2" },
      { id: "kimi-k2-turbo-preview", label: "Kimi K2 Turbo" },
    ],
  },
  minimax: {
    baseUrl: "https://api.minimax.chat/v1",
    models: [
      { id: "MiniMax-M2", label: "MiniMax M2" },
      { id: "MiniMax-M1", label: "MiniMax M1" },
    ],
  },
};

export function isDomesticAiProvider(
  provider: string,
): provider is DomesticAiProvider {
  return (DOMESTIC_AI_PROVIDERS as readonly string[]).includes(provider);
}

export function domesticDefaultRouting(
  provider: DomesticAiProvider,
  baseUrlOverride?: string,
): AiProviderRouting {
  return {
    kind: "gateway",
    protocol: "chat",
    auth: "bearer",
    baseUrl:
      baseUrlOverride?.trim() ||
      DOMESTIC_AI_PROVIDER_DEFAULTS[provider].baseUrl,
    models: DOMESTIC_AI_PROVIDER_DEFAULTS[provider].models.map((model) => ({
      ...model,
    })),
  };
}
