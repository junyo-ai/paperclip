import { describe, expect, it } from "vitest";
import { roleTemplateSpecSchema } from "@paperclipai/shared";
import { ROLE_TEMPLATE_SEEDS } from "../services/role-template-seed.js";
import softwareEngineerV1 from "../role-template-seeds/software-engineer-v1.json" with { type: "json" };

const DEVPIPELINE_CLOSURE_KEY = "paperclipai/bundled/software-development/devpipeline-closure";
const REVIEW_LOOP_KEY = "paperclipai/bundled/software-development/review-loop";

describe("role template seed specs", () => {
  it("ships unique seed keys and every spec passes the shared validators", () => {
    expect(ROLE_TEMPLATE_SEEDS.map((seed) => seed.key).sort()).toEqual([
      "content-marketing-specialist",
      "software-engineer",
      "software-engineer-v2",
    ]);
    for (const seed of ROLE_TEMPLATE_SEEDS) {
      expect(() => roleTemplateSpecSchema.parse(seed.spec)).not.toThrow();
    }
  });

  it("keeps the v1 seed untouched", () => {
    const v1 = ROLE_TEMPLATE_SEEDS.find((seed) => seed.key === "software-engineer")!;
    expect(v1.spec).toEqual(softwareEngineerV1.spec);
    expect(softwareEngineerV1.spec.character.personaPrompt).not.toContain("研发闭环");
  });

  it("enriches v2 with the process-discipline skills while keeping the v1 skill base", () => {
    const v2 = roleTemplateSpecSchema.parse(
      ROLE_TEMPLATE_SEEDS.find((seed) => seed.key === "software-engineer-v2")!.spec,
    );
    const v1 = roleTemplateSpecSchema.parse(softwareEngineerV1.spec);

    expect(v2.character.personaPrompt.length).toBeLessThan(800);
    // v2 is an enrichment of v1, not a rewrite: v1 text stays as the base.
    expect(v2.character.personaPrompt.startsWith(v1.character.personaPrompt.slice(0, 200))).toBe(true);
    expect(v2.character.personaPrompt).toContain("研发闭环");
    expect(v2.character.personaPrompt).toContain("git add -A");
    expect(v2.character.personaPrompt).toContain("co-author/Generated-with");
    expect(v2.character.personaPrompt).toContain("落盘证据");
    expect(v2.character.personaPrompt).toContain("PR merged + CI 绿 + review 线程清零");

    const v2Keys = v2.skills.map((skill) => skill.key);
    expect(v2Keys).toEqual(expect.arrayContaining(v1.skills.map((skill) => skill.key)));
    expect(v2Keys).toEqual(expect.arrayContaining([DEVPIPELINE_CLOSURE_KEY, REVIEW_LOOP_KEY]));
    expect(new Set(v2Keys).size).toBe(v2Keys.length);

    // Hiring semantics stay identical: only skills/personaPrompt/rationale change.
    expect(v2.defaults).toEqual(v1.defaults);
    expect(v2.character.title).toBe(v1.character.title);
    expect(v2.character.role).toBe(v1.character.role);
  });

  it("references only skill keys that exist in the shipped catalog or core skill set", async () => {
    const { catalogSkills } = await import("@paperclipai/skills-catalog");
    const catalogKeys = new Set(catalogSkills.map((skill) => skill.key));
    const corePrefix = "paperclipai/paperclip/";
    for (const seed of ROLE_TEMPLATE_SEEDS) {
      const spec = roleTemplateSpecSchema.parse(seed.spec);
      for (const skill of spec.skills) {
        const known = skill.key.startsWith(corePrefix) || catalogKeys.has(skill.key);
        expect(known, `${seed.key} references unknown skill ${skill.key}`).toBe(true);
      }
    }
  });
});
