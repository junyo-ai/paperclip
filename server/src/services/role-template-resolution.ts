import type { RoleTemplateSpec } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/**
 * Which hire-relevant fields the caller actually sent, read from the
 * pre-validation raw request body. `validate()` replaces `req.body` with the
 * parsed output and `createAgentSchema` defaults an omitted `role` (and
 * `budgetMonthlyCents`) — so by the time the handler sees them, "caller
 * omitted" and "caller sent the default" are indistinguishable. These flags
 * restore the distinction: explicit caller value wins, template fills gaps.
 */
export type TemplateHireRawFields = {
  rolePresent: boolean;
  budgetMonthlyCentsPresent: boolean;
};

export function readTemplateHireRawFields(rawBody: unknown): TemplateHireRawFields {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
    return { rolePresent: false, budgetMonthlyCentsPresent: false };
  }
  return {
    rolePresent: Object.prototype.hasOwnProperty.call(rawBody, "role"),
    budgetMonthlyCentsPresent: Object.prototype.hasOwnProperty.call(rawBody, "budgetMonthlyCents"),
  };
}

/** The hire-relevant slice of a validated create/hire body, loosely typed. */
export type TemplateHireBody = {
  name?: unknown;
  title?: unknown;
  role?: unknown;
  budgetMonthlyCents?: unknown;
  desiredSkills?: Array<string | { key: string; versionId?: string | null }>;
  permissions?: Record<string, unknown>;
  instructionsBundle?: { entryFile?: string; files: Record<string, string> };
};

export type ResolvedAgentInstructionsBundle = {
  entryFile: string;
  files: Record<string, string>;
};

export type TemplateHireMerge = {
  title: string | null;
  role: string;
  budgetMonthlyCents: number;
  desiredSkills: Array<{ key: string; versionId: string | null }> | undefined;
  permissions: Record<string, unknown> | undefined;
  instructionsBundle: ResolvedAgentInstructionsBundle;
  inferenceConnectionId: string | undefined;
};

/** The copy-on-hire application record written to `agents.roleTemplateSnapshot`. */
export type RoleTemplateSnapshot = {
  templateKey: string;
  templateVersion: number;
  applied: {
    title: string | null;
    role: string;
    personaPrompt: string;
    skills: RoleTemplateSpec["skills"];
    defaults: RoleTemplateSpec["defaults"] & { budgetMonthlyCents?: number };
  };
  callerOverrides: string[];
  appliedAt: string;
};

export type ResolveTemplateIntoAgentCreateOptions = {
  templateKey: string;
  templateVersion: number;
  raw: TemplateHireRawFields;
  appliedAt?: Date;
};

/**
 * Pure merge (design §6.3): explicit caller value wins, template fills the
 * gaps, schema defaults apply last. Never touches capabilities, environment,
 * adapter or metadata — those stay caller-owned.
 */
export function resolveTemplateIntoAgentCreate(
  spec: RoleTemplateSpec,
  body: TemplateHireBody,
  options: ResolveTemplateIntoAgentCreateOptions,
): { merged: TemplateHireMerge; snapshot: RoleTemplateSnapshot } {
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    throw unprocessable("A template hire requires an explicit agent name: one template can produce many agents");
  }

  const callerOverrides: string[] = [];

  // title: caller wins, including an explicit null.
  let title: string | null;
  if (body.title !== undefined) {
    title = (body.title as string | null) ?? null;
    callerOverrides.push("title");
  } else {
    title = spec.character.title;
  }

  // role: read from the raw body — the validated body can no longer tell an
  // omitted role from an explicit "general".
  let role: string;
  if (options.raw.rolePresent && typeof body.role === "string") {
    role = body.role;
    callerOverrides.push("role");
  } else {
    role = spec.character.role;
  }

  // budgetMonthlyCents: same raw-body rule; falls back to the schema default
  // when neither caller nor template sets one.
  let budgetMonthlyCents: number;
  if (options.raw.budgetMonthlyCentsPresent && typeof body.budgetMonthlyCents === "number") {
    budgetMonthlyCents = body.budgetMonthlyCents;
    callerOverrides.push("budgetMonthlyCents");
  } else if (typeof spec.defaults.budgetMonthlyCents === "number") {
    budgetMonthlyCents = spec.defaults.budgetMonthlyCents;
  } else {
    budgetMonthlyCents = typeof body.budgetMonthlyCents === "number" ? body.budgetMonthlyCents : 0;
  }

  // desiredSkills: union merge, caller wins per key. Core defaults are still
  // appended downstream by withDefaultRoleSkillSelections.
  const mergedSkills = new Map<string, { key: string; versionId: string | null }>();
  if (body.desiredSkills !== undefined) {
    callerOverrides.push("desiredSkills");
    for (const selection of body.desiredSkills) {
      const entry = typeof selection === "string"
        ? { key: selection, versionId: null as string | null }
        : { key: selection.key, versionId: selection.versionId ?? null };
      mergedSkills.set(entry.key, entry);
    }
  }
  for (const skill of spec.skills) {
    if (!mergedSkills.has(skill.key)) {
      mergedSkills.set(skill.key, { key: skill.key, versionId: null });
    }
  }
  const desiredSkills = mergedSkills.size > 0 ? Array.from(mergedSkills.values()) : undefined;

  // permissions: shallow merge, caller key-level precedence, template subset only.
  let permissions: Record<string, unknown> | undefined;
  const templatePermissions = spec.defaults.permissions;
  if (body.permissions !== undefined || templatePermissions !== undefined) {
    permissions = { ...(templatePermissions ?? {}), ...(body.permissions ?? {}) };
    if (Object.keys(permissions).length === 0) permissions = undefined;
    if (body.permissions !== undefined) callerOverrides.push("permissions");
  }

  // instructionsBundle: a caller bundle replaces the persona-derived one wholesale.
  let instructionsBundle: ResolvedAgentInstructionsBundle;
  if (body.instructionsBundle !== undefined) {
    instructionsBundle = {
      entryFile: body.instructionsBundle.entryFile ?? "AGENTS.md",
      files: body.instructionsBundle.files,
    };
    callerOverrides.push("instructionsBundle");
  } else {
    instructionsBundle = {
      entryFile: "AGENTS.md",
      files: { "AGENTS.md": spec.character.personaPrompt },
    };
  }

  const effectiveDefaults: RoleTemplateSnapshot["applied"]["defaults"] = {
    ...spec.defaults,
    budgetMonthlyCents:
      spec.defaults.budgetMonthlyCents !== undefined || options.raw.budgetMonthlyCentsPresent
        ? budgetMonthlyCents
        : undefined,
  };

  return {
    merged: { title, role, budgetMonthlyCents, desiredSkills, permissions, instructionsBundle, inferenceConnectionId: spec.defaults.inferenceConnectionId },
    snapshot: {
      templateKey: options.templateKey,
      templateVersion: options.templateVersion,
      applied: {
        title,
        role,
        personaPrompt: spec.character.personaPrompt,
        skills: spec.skills,
        defaults: effectiveDefaults,
      },
      callerOverrides,
      appliedAt: (options.appliedAt ?? new Date()).toISOString(),
    },
  };
}
