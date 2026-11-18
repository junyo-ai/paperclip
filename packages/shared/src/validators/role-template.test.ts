import { describe, expect, it } from "vitest";
import { AGENT_ROLES } from "../constants.js";
import { roleTemplateSpecSchema } from "./role-template.js";

const validSpec = {
  templateName: "内容营销专员 v1（content-marketing-specialist-v1）",
  character: {
    personaPrompt: "你是本公司聘用的数字员工，岗位：内容营销专员。\n\n【职责边界】\n负责内容营销全流程：选题策划、成稿撰写与改稿、多渠道适配改写、发布排期、效果复盘；不修改产品代码，不对外承诺合同与报价。\n\n【工作风格】\n以任务为中心：开工先领取任务，结束时更新状态并留下结论；接到任务先确认受众、渠道与成功指标，数据导向地决定加投、调整或放弃，并把方法论沉淀入长期记忆。\n\n【输出规范】\n交付统一 Markdown：短段落、每篇附备选标题与摘要；引用数据必须标注来源，禁止编造数字与案例；任务收尾必附成稿链接与不超过三条的下一步建议。",
    title: "内容营销专员",
    role: "general",
  },
  skills: [
    { key: "paperclipai/paperclip/paperclip", reason: "核心运行技能：心跳领任务与状态流转。" },
    { key: "paperclipai/paperclip/slack", reason: "跨团队协同与发布进展同步。" },
  ],
  defaults: {
    modelHint: "glm-5-turbo",
    budgetMonthlyCents: 2000,
    environmentKind: "session",
    maxConcurrentRuns: 2,
    permissions: { canCreateAgents: false, canCreateSkills: false },
    notes: "低档预算起步。",
  },
  rationale: ["以最小闭环验证模板结构。"],
};

describe("roleTemplateSpecSchema", () => {
  it("accepts a complete spec and defaults role to general", () => {
    const parsed = roleTemplateSpecSchema.parse({
      ...validSpec,
      character: { ...validSpec.character, role: undefined },
    });
    expect(parsed.character.role).toBe("general");
    expect(parsed.defaults.budgetMonthlyCents).toBe(2000);
  });

  it("rejects a personaPrompt shorter than 200 or longer than 1200 chars", () => {
    const short = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      character: { ...validSpec.character, personaPrompt: "过短" },
    });
    expect(short.success).toBe(false);

    const long = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      character: { ...validSpec.character, personaPrompt: "长".repeat(1201) },
    });
    expect(long.success).toBe(false);
  });

  it("rejects an empty or oversized skills list", () => {
    const empty = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      skills: [],
    });
    expect(empty.success).toBe(false);

    const tooMany = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      skills: Array.from({ length: 11 }, (_, index) => ({
        key: `skill-${index}`,
        reason: "占位理由",
      })),
    });
    expect(tooMany.success).toBe(false);
  });

  it("rejects duplicate skill keys", () => {
    const result = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      skills: [
        { key: "paperclipai/paperclip/paperclip", reason: "核心运行技能。" },
        { key: "paperclipai/paperclip/paperclip", reason: "重复引用。" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("restricts character.role to AGENT_ROLES", () => {
    const result = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      character: { ...validSpec.character, role: "chief-marketing-guru" },
    });
    expect(result.success).toBe(false);
    expect(AGENT_ROLES).toContain("general");
  });

  it("enforces defaults numeric bounds", () => {
    const budget = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      defaults: { ...validSpec.defaults, budgetMonthlyCents: 2_000_001 },
    });
    expect(budget.success).toBe(false);

    const runs = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      defaults: { ...validSpec.defaults, maxConcurrentRuns: 5 },
    });
    expect(runs.success).toBe(false);
  });

  it("rejects a malformed defaults payload (budget as string)", () => {
    const result = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      defaults: { ...validSpec.defaults, budgetMonthlyCents: "2000" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a spec whose template name exceeds 120 chars", () => {
    const result = roleTemplateSpecSchema.safeParse({
      ...validSpec,
      templateName: "长".repeat(121),
    });
    expect(result.success).toBe(false);
  });
});
