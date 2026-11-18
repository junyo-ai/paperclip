import { describe, expect, it } from "vitest";
import type { RoleTemplateSpec } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { readTemplateHireRawFields, resolveTemplateIntoAgentCreate, type TemplateHireBody } from "./role-template-resolution.js";

const spec: RoleTemplateSpec = {
  templateName: "内容营销专员 v1",
  character: {
    personaPrompt: "【职责边界】…\n\n【工作风格】…\n\n【输出规范】…",
    title: "内容营销专员",
    role: "general",
  },
  skills: [
    { key: "paperclipai/paperclip/paperclip", reason: "核心运行技能。" },
    { key: "paperclipai/paperclip/slack", reason: "跨团队协同。" },
  ],
  defaults: {
    modelHint: "glm-5-turbo",
    budgetMonthlyCents: 2000,
    permissions: { canCreateAgents: false, canCreateSkills: false },
    notes: "低档预算起步。",
  },
  rationale: ["以最小闭环验证模板结构。"],
};

const options = {
  templateKey: "content-marketing-specialist",
  templateVersion: 1,
  raw: readTemplateHireRawFields({}),
  appliedAt: new Date("2026-11-18T00:00:00.000Z"),
};

describe("readTemplateHireRawFields", () => {
  it("detects presence without inheriting values, and ignores non-objects", () => {
    expect(readTemplateHireRawFields({ role: "general", budgetMonthlyCents: 0 })).toEqual({
      rolePresent: true,
      budgetMonthlyCentsPresent: true,
    });
    expect(readTemplateHireRawFields({ name: "x" })).toEqual({
      rolePresent: false,
      budgetMonthlyCentsPresent: false,
    });
    expect(readTemplateHireRawFields(null)).toEqual({ rolePresent: false, budgetMonthlyCentsPresent: false });
    expect(readTemplateHireRawFields([1, 2])).toEqual({ rolePresent: false, budgetMonthlyCentsPresent: false });
  });
});

describe("resolveTemplateIntoAgentCreate", () => {
  it("requires an explicit agent name", () => {
    expect(() => resolveTemplateIntoAgentCreate(spec, {}, options)).toThrow(HttpError);
    expect(() => resolveTemplateIntoAgentCreate(spec, { name: "  " }, options)).toThrow(
      expect.objectContaining({ status: 422 }),
    );
  });

  it("fills every templated field from the spec when the caller only sends a name", () => {
    const { merged, snapshot } = resolveTemplateIntoAgentCreate(spec, { name: "营销一号" }, options);
    expect(merged.title).toBe("内容营销专员");
    expect(merged.role).toBe("general");
    expect(merged.budgetMonthlyCents).toBe(2000);
    expect(merged.desiredSkills).toEqual([
      { key: "paperclipai/paperclip/paperclip", versionId: null },
      { key: "paperclipai/paperclip/slack", versionId: null },
    ]);
    expect(merged.permissions).toEqual({ canCreateAgents: false, canCreateSkills: false });
    expect(merged.instructionsBundle).toEqual({
      entryFile: "AGENTS.md",
      files: { "AGENTS.md": spec.character.personaPrompt },
    });
    expect(snapshot.callerOverrides).toEqual([]);
    expect(snapshot.templateVersion).toBe(1);
  });

  it("lets explicit caller values win over the template (title, role, budget)", () => {
    const body: TemplateHireBody = {
      name: "营销一号",
      title: "资深内容营销",
      role: "general", // equal to the schema default: only a raw-body role counts as an override
      budgetMonthlyCents: 5000,
    };
    const raw = readTemplateHireRawFields({ role: body.role, budgetMonthlyCents: body.budgetMonthlyCents });
    const { merged, snapshot } = resolveTemplateIntoAgentCreate(spec, body, { ...options, raw });
    expect(merged.title).toBe("资深内容营销");
    expect(merged.role).toBe("general");
    expect(merged.budgetMonthlyCents).toBe(5000);
    expect(snapshot.callerOverrides).toEqual(["title", "role", "budgetMonthlyCents"]);
  });

  it("applies the template role and budget only when the raw body omits them", () => {
    const body: TemplateHireBody = { name: "营销一号", role: "general", budgetMonthlyCents: 0 };
    const raw = readTemplateHireRawFields({ name: "营销一号" });
    const { merged, snapshot } = resolveTemplateIntoAgentCreate(spec, body, { ...options, raw });
    // The validated body carries the schema defaults; the template fills in.
    expect(merged.role).toBe("general");
    expect(merged.budgetMonthlyCents).toBe(2000);
    expect(snapshot.callerOverrides).toEqual([]);
  });

  it("falls back to the schema default when neither caller nor template sets a budget", () => {
    const budgetless = { ...spec, defaults: { ...spec.defaults, budgetMonthlyCents: undefined } };
    const body: TemplateHireBody = { name: "营销一号", budgetMonthlyCents: 0 };
    const raw = readTemplateHireRawFields({ name: "营销一号" });
    const { merged } = resolveTemplateIntoAgentCreate(budgetless, body, { ...options, raw });
    expect(merged.budgetMonthlyCents).toBe(0);
  });

  it("union-merges desiredSkills with the caller winning per key", () => {
    const body: TemplateHireBody = {
      name: "营销一号",
      desiredSkills: [
        { key: "paperclipai/paperclip/paperclip", versionId: "version-7" },
        "paperclipai/paperclip/agentmail",
      ],
    };
    const { merged, snapshot } = resolveTemplateIntoAgentCreate(spec, body, options);
    expect(merged.desiredSkills).toEqual([
      { key: "paperclipai/paperclip/paperclip", versionId: "version-7" },
      { key: "paperclipai/paperclip/agentmail", versionId: null },
      { key: "paperclipai/paperclip/slack", versionId: null },
    ]);
    expect(snapshot.callerOverrides).toEqual(["desiredSkills"]);
  });

  it("shallow-merges permissions with caller key-level precedence", () => {
    const body: TemplateHireBody = {
      name: "营销一号",
      permissions: { canCreateAgents: true },
    };
    const { merged } = resolveTemplateIntoAgentCreate(spec, body, options);
    expect(merged.permissions).toEqual({ canCreateAgents: true, canCreateSkills: false });
  });

  it("replaces the persona-derived instructionsBundle wholesale", () => {
    const body: TemplateHireBody = {
      name: "营销一号",
      instructionsBundle: { entryFile: "PERSONA.md", files: { "PERSONA.md": "自拟提示词" } },
    };
    const { merged, snapshot } = resolveTemplateIntoAgentCreate(spec, body, options);
    expect(merged.instructionsBundle).toEqual({
      entryFile: "PERSONA.md",
      files: { "PERSONA.md": "自拟提示词" },
    });
    expect(snapshot.callerOverrides).toContain("instructionsBundle");
  });

  it("defaults an omitted caller bundle entry file to AGENTS.md like the hire path", () => {
    const body: TemplateHireBody = {
      name: "营销一号",
      instructionsBundle: { files: { "README.md": "readme", "AGENTS.md": "persona" } },
    };
    const { merged } = resolveTemplateIntoAgentCreate(spec, body, options);
    expect(merged.instructionsBundle.entryFile).toBe("AGENTS.md");
  });

  it("records the applied template content and timestamp in the snapshot", () => {
    const { snapshot } = resolveTemplateIntoAgentCreate(spec, { name: "营销一号" }, options);
    expect(snapshot.templateKey).toBe("content-marketing-specialist");
    expect(snapshot.applied.personaPrompt).toBe(spec.character.personaPrompt);
    expect(snapshot.applied.skills).toEqual(spec.skills);
    expect(snapshot.applied.defaults.budgetMonthlyCents).toBe(2000);
    expect(snapshot.appliedAt).toBe("2026-11-18T00:00:00.000Z");
  });
});
