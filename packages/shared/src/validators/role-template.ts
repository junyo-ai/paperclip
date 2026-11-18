import { z } from "zod";
import { AGENT_ROLES } from "../constants.js";

export const ROLE_TEMPLATE_STATUSES = ["draft", "published", "deprecated"] as const;
export type RoleTemplateStatus = (typeof ROLE_TEMPLATE_STATUSES)[number];

/** Slug shape for template keys, unique per company among live rows. */
export const ROLE_TEMPLATE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/**
 * Permissions a template may preset at hire time. Deliberately the narrow
 * subset of `agentPermissionsSchema` the design validated; everything else
 * stays caller-owned.
 */
export const roleTemplatePermissionsSchema = z.object({
  canCreateAgents: z.boolean().optional(),
  canCreateSkills: z.boolean().optional(),
});

/**
 * Template spec v1, refined from the two accepted JUN-2/JUN-3 deliverables:
 * both fit the same five-field schema, so validation mirrors their bounds.
 */
export const roleTemplateSpecSchema = z.object({
  templateName: z.string().trim().min(1).max(120),
  character: z.object({
    // Three-section convention validated in practice: 职责边界 / 工作风格 / 输出规范.
    // Hard cap 1200 chars (validated deliverables: 548 and 543).
    personaPrompt: z.string().trim().min(200).max(1200),
    title: z.string().trim().min(1).max(80),
    role: z.enum(AGENT_ROLES).default("general"),
  }),
  skills: z
    .array(
      z.object({
        key: z.string().min(1).max(256),
        reason: z.string().trim().min(1).max(400),
      }),
    )
    .min(1)
    .max(10)
    .superRefine((skills, ctx) => {
      const seen = new Set<string>();
      for (const [index, skill] of skills.entries()) {
        if (seen.has(skill.key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate skill key: ${skill.key}`,
            path: [index, "key"],
          });
        }
        seen.add(skill.key);
      }
    }),
  defaults: z.object({
    // Advisory metadata surfaced in the hire UI; never applied to runtimeConfig.
    modelHint: z.string().max(120).optional(),
    budgetMonthlyCents: z.number().int().min(0).max(2_000_000).optional(),
    environmentKind: z.enum(["session", "git_repo"]).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(4).optional(),
    permissions: roleTemplatePermissionsSchema.optional(),
    notes: z.string().max(2000).optional(),
  }),
  // Editorial record from the design deliverables; never applied at hire.
  rationale: z.array(z.string().max(600)).max(8),
});

export type RoleTemplateSpec = z.infer<typeof roleTemplateSpecSchema>;

export const roleTemplateCreateSchema = z
  .object({
    key: z.string().regex(ROLE_TEMPLATE_KEY_PATTERN).optional(),
    spec: roleTemplateSpecSchema,
    sourceIssueId: z.string().guid().optional().nullable(),
  })
  .strict();

export type RoleTemplateCreate = z.infer<typeof roleTemplateCreateSchema>;

export const roleTemplateUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    spec: roleTemplateSpecSchema.optional(),
    // Router-reserved fields (design §8): preconfiguration only, nothing reads them yet.
    routerVisible: z.boolean().optional(),
    dispatchWeight: z.number().int().min(0).max(1000).optional(),
    capabilityTags: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  });

export type RoleTemplateUpdate = z.infer<typeof roleTemplateUpdateSchema>;

export const roleTemplateListQuerySchema = z.object({
  status: z.enum(ROLE_TEMPLATE_STATUSES).optional(),
  includeDeleted: z.boolean().optional(),
});

export type RoleTemplateListQuery = z.infer<typeof roleTemplateListQuerySchema>;

export const roleTemplateDeprecateSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .default({});
