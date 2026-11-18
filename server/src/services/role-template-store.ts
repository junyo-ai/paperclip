import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  companySkills,
  roleTemplateCreateReceipts,
  roleTemplates,
  roleTemplateVersions,
  type Db,
  type RoleTemplate,
  type RoleTemplateVersion,
} from "@paperclipai/db";
import {
  ROLE_TEMPLATE_KEY_PATTERN,
  roleTemplateSpecSchema,
  type RoleTemplateSpec,
  type RoleTemplateStatus,
  type RoleTemplateUpdate,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { isUniqueViolation } from "../db-errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

export const ROLE_TEMPLATE_NOT_HIREABLE_CODE = "role_template_not_hireable";

export const ROLE_TEMPLATE_GAP_REASON_PREFIX = "missing-skills:";

/** The audit fields `logActivity` reads, as `getActorInfo` produces them. */
export type RoleTemplateAuditActor = {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

const SYSTEM_ACTOR: RoleTemplateAuditActor = { actorType: "system", actorId: "system" };

/** Deterministic hash of a spec: jsonb round-trips reorder keys, so sort first. */
export function roleTemplateSpecHash(spec: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(spec))).digest("hex");
}

/**
 * Skill keys from the spec that do not resolve against the company's live
 * `company_skills` registry. Publish and hire both gate on this.
 */
export async function missingRoleTemplateSkillKeys(
  db: Db,
  companyId: string,
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({ key: companySkills.key })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, companyId), inArray(companySkills.key, keys)));
  const present = new Set(rows.map((row) => row.key));
  return [...new Set(keys)].filter((key) => !present.has(key));
}

/** Derive a template key from the display name; null when no slug survives. */
export function deriveRoleTemplateKey(templateName: string): string | null {
  const slug = templateName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ROLE_TEMPLATE_KEY_PATTERN.test(slug) ? slug : null;
}

export type RoleTemplateVersionRow = Pick<
  RoleTemplateVersion,
  "id" | "version" | "spec" | "changelog" | "createdByUserId" | "createdAt"
>;

async function audit(
  db: Db,
  companyId: string,
  templateId: string,
  action: string,
  actor: RoleTemplateAuditActor,
  details: Record<string, unknown>,
  publications: ActivityPublication[],
) {
  await logActivity(
    db,
    {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      action,
      entityType: "role_template",
      entityId: templateId,
      details,
    },
    publications,
  );
}

export function roleTemplateStore(db: Db) {
  async function getLiveRow(companyId: string, templateId: string): Promise<RoleTemplate | null> {
    const [row] = await db
      .select()
      .from(roleTemplates)
      .where(
        and(
          eq(roleTemplates.id, templateId),
          eq(roleTemplates.companyId, companyId),
          isNull(roleTemplates.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function requireLiveRow(companyId: string, templateId: string): Promise<RoleTemplate> {
    const row = await getLiveRow(companyId, templateId);
    if (!row) throw notFound("Role template not found");
    return row;
  }

  async function listVersions(companyId: string, templateId: string): Promise<RoleTemplateVersionRow[]> {
    return db
      .select({
        id: roleTemplateVersions.id,
        version: roleTemplateVersions.version,
        spec: roleTemplateVersions.spec,
        changelog: roleTemplateVersions.changelog,
        createdByUserId: roleTemplateVersions.createdByUserId,
        createdAt: roleTemplateVersions.createdAt,
      })
      .from(roleTemplateVersions)
      .where(and(eq(roleTemplateVersions.companyId, companyId), eq(roleTemplateVersions.templateId, templateId)))
      .orderBy(asc(roleTemplateVersions.version));
  }

  async function getVersionRow(
    runner: Db,
    companyId: string,
    templateId: string,
    version: number,
  ): Promise<RoleTemplateVersion | null> {
    const [row] = await runner
      .select()
      .from(roleTemplateVersions)
      .where(
        and(
          eq(roleTemplateVersions.companyId, companyId),
          eq(roleTemplateVersions.templateId, templateId),
          eq(roleTemplateVersions.version, version),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Publish gate (design §5.4): spec parses, key is a slug, skills resolve. */
  async function assertPublishable(db: Db, companyId: string, row: RoleTemplate): Promise<void> {
    const invalid: string[] = [];
    const spec = roleTemplateSpecSchema.safeParse(row.workingSpec);
    if (!spec.success) invalid.push(`spec: ${spec.error.issues[0]?.message ?? "invalid spec"}`);
    if (!ROLE_TEMPLATE_KEY_PATTERN.test(row.key)) invalid.push(`key: ${row.key} is not a valid slug`);
    // When the spec does not parse, its skill list cannot be trusted; the
    // spec failure above already fails the gate.
    const skillKeys = spec.success ? spec.data.skills.map((skill) => skill.key) : [];
    const missing = await missingRoleTemplateSkillKeys(db, companyId, skillKeys);
    if (missing.length > 0) invalid.push(`skills: missing from the company library: ${missing.join(", ")}`);
    if (invalid.length > 0) {
      throw unprocessable("Role template is not publishable", { invalid });
    }
  }

  return {
    list: async (
      companyId: string,
      query: { status?: RoleTemplateStatus; includeDeleted?: boolean } = {},
    ): Promise<RoleTemplate[]> => {
      const conditions = [eq(roleTemplates.companyId, companyId)];
      if (!query.includeDeleted) conditions.push(isNull(roleTemplates.deletedAt));
      if (query.status) conditions.push(eq(roleTemplates.status, query.status));
      return db
        .select()
        .from(roleTemplates)
        .where(and(...conditions))
        .orderBy(desc(roleTemplates.updatedAt));
    },

    get: async (companyId: string, templateId: string) => ({
      template: await requireLiveRow(companyId, templateId),
      versions: await listVersions(companyId, templateId),
    }),

    /** The published version row only, for agent-facing detail responses. */
    getPublishedVersion: async (companyId: string, templateId: string) => {
      const row = await requireLiveRow(companyId, templateId);
      if (row.currentVersion < 1) return null;
      return getVersionRow(db, companyId, templateId, row.currentVersion);
    },

    create: async (
      companyId: string,
      input: { key?: string; spec: RoleTemplateSpec; sourceIssueId?: string | null },
      actor: RoleTemplateAuditActor = SYSTEM_ACTOR,
      options: { idempotencyKey?: string | null } = {},
    ): Promise<{ template: RoleTemplate; replayed: boolean }> => {
      const key = input.key ?? deriveRoleTemplateKey(input.spec.templateName);
      if (!key) {
        throw unprocessable(
          "A template key is required: the template name contains no usable slug (lowercase letters, digits, dashes)",
        );
      }

      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx) => {
        let createReceipt: { receiptKey: string; fingerprint: string } | null = null;
        if (options.idempotencyKey) {
          const receiptKey = `role-template:${actor.actorType}:${actor.actorId}:${options.idempotencyKey}`;
          const fingerprint = roleTemplateSpecHash({ key, spec: input.spec, sourceIssueId: input.sourceIssueId ?? null });
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${receiptKey}, 0))`);
          const [receipt] = await tx
            .select()
            .from(roleTemplateCreateReceipts)
            .where(
              and(
                eq(roleTemplateCreateReceipts.companyId, companyId),
                eq(roleTemplateCreateReceipts.key, receiptKey),
                sql`${roleTemplateCreateReceipts.createdAt} >= now() - interval '24 hours'`,
              ),
            )
            .limit(1);
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) {
              throw conflict("Idempotency key was already used with a different template body");
            }
            const [existing] = await tx
              .select()
              .from(roleTemplates)
              .where(eq(roleTemplates.id, receipt.templateId))
              .limit(1);
            if (existing) return { template: existing, replayed: true };
          }
          createReceipt = { receiptKey, fingerprint };
        }

        let created: RoleTemplate;
        try {
          [created] = await tx
            .insert(roleTemplates)
            .values({
              companyId,
              key,
              name: input.spec.templateName,
              status: "draft",
              workingSpec: input.spec,
              sourceIssueId: input.sourceIssueId ?? null,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
              createdByAgentId: actor.actorType === "agent" ? actor.agentId ?? null : null,
            })
            .returning();
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw conflict(`A live role template with key "${key}" already exists`);
          }
          throw error;
        }

        if (createReceipt) {
          await tx
            .insert(roleTemplateCreateReceipts)
            .values({ companyId, key: createReceipt.receiptKey, fingerprint: createReceipt.fingerprint, templateId: created.id })
            .onConflictDoUpdate({
              target: [roleTemplateCreateReceipts.companyId, roleTemplateCreateReceipts.key],
              set: { fingerprint: createReceipt.fingerprint, templateId: created.id, createdAt: sql`now()` },
            });
        }
        await audit(tx as unknown as Db, companyId, created.id, "role_template.created", actor, { key, name: created.name }, publications);
        return { template: created, replayed: false };
      });
      for (const publication of publications) publishActivity(publication);
      return result;
    },

    update: async (
      companyId: string,
      templateId: string,
      patch: RoleTemplateUpdate,
      actor: RoleTemplateAuditActor,
    ): Promise<RoleTemplate> => {
      const row = await requireLiveRow(companyId, templateId);
      const publications: ActivityPublication[] = [];
      const updated = await db.transaction(async (tx) => {
        const [row2] = await tx
          .update(roleTemplates)
          .set({
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.spec !== undefined ? { workingSpec: patch.spec, name: patch.spec.templateName } : {}),
            ...(patch.routerVisible !== undefined ? { routerVisible: patch.routerVisible } : {}),
            ...(patch.dispatchWeight !== undefined ? { dispatchWeight: patch.dispatchWeight } : {}),
            ...(patch.capabilityTags !== undefined ? { capabilityTags: patch.capabilityTags } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(roleTemplates.id, row.id), isNull(roleTemplates.deletedAt)))
          .returning();
        if (!row2) throw notFound("Role template not found");
        await audit(tx as unknown as Db, companyId, row2.id, "role_template.updated", actor, {
          fields: Object.keys(patch),
        }, publications);
        return row2;
      });
      for (const publication of publications) publishActivity(publication);
      return updated;
    },

    /**
     * Validate, then freeze `workingSpec` as version `currentVersion+1`.
     * Re-publishing an unchanged published spec is the only no-op; an edited
     * spec always produces version N+1.
     */
    publish: async (
      companyId: string,
      templateId: string,
      actor: RoleTemplateAuditActor,
      options: { changelog?: string | null } = {},
    ): Promise<{ template: RoleTemplate; version: RoleTemplateVersionRow; createdVersion: boolean }> => {
      const row = await requireLiveRow(companyId, templateId);
      if (row.status === "deprecated") {
        throw conflict("Restore the role template before publishing it again");
      }

      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(roleTemplates)
          .where(eq(roleTemplates.id, row.id))
          .for("update");
        if (!locked || locked.deletedAt) throw notFound("Role template not found");
        if (locked.status === "deprecated") {
          throw conflict("Restore the role template before publishing it again");
        }
        await assertPublishable(tx as unknown as Db, companyId, locked);

        if (locked.currentVersion > 0 && locked.status === "published") {
          const [current] = await tx
            .select({
              id: roleTemplateVersions.id,
              version: roleTemplateVersions.version,
              spec: roleTemplateVersions.spec,
              changelog: roleTemplateVersions.changelog,
              createdByUserId: roleTemplateVersions.createdByUserId,
              createdAt: roleTemplateVersions.createdAt,
            })
            .from(roleTemplateVersions)
            .where(
              and(
                eq(roleTemplateVersions.templateId, locked.id),
                eq(roleTemplateVersions.version, locked.currentVersion),
              ),
            )
            .limit(1);
          // Unchanged published spec: the one no-op publish.
          if (current && roleTemplateSpecHash(current.spec) === roleTemplateSpecHash(locked.workingSpec)) {
            return { template: locked, version: current, createdVersion: false };
          }
        }

        const nextVersion = locked.currentVersion + 1;
        let inserted: RoleTemplateVersionRow;
        try {
          [inserted] = await tx
            .insert(roleTemplateVersions)
            .values({
              templateId: locked.id,
              companyId,
              version: nextVersion,
              spec: locked.workingSpec,
              changelog: options.changelog ?? null,
              createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            })
            .returning({
              id: roleTemplateVersions.id,
              version: roleTemplateVersions.version,
              spec: roleTemplateVersions.spec,
              changelog: roleTemplateVersions.changelog,
              createdByUserId: roleTemplateVersions.createdByUserId,
              createdAt: roleTemplateVersions.createdAt,
            });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw conflict("The role template was published concurrently; retry");
          }
          throw error;
        }
        const [updated] = await tx
          .update(roleTemplates)
          .set({
            status: "published",
            currentVersion: nextVersion,
            publishedAt: new Date(),
            deprecatedAt: null,
            deprecationReason: null,
            updatedAt: new Date(),
          })
          .where(eq(roleTemplates.id, locked.id))
          .returning();
        await audit(tx as unknown as Db, companyId, updated.id, "role_template.published", actor, {
          version: nextVersion,
        }, publications);
        return { template: updated, version: inserted, createdVersion: true };
      });
      for (const publication of publications) publishActivity(publication);
      return result;
    },

    deprecate: async (
      companyId: string,
      templateId: string,
      options: { reason?: string } = {},
      actor: RoleTemplateAuditActor = SYSTEM_ACTOR,
    ): Promise<RoleTemplate> => {
      const row = await requireLiveRow(companyId, templateId);
      if (options.reason?.startsWith(ROLE_TEMPLATE_GAP_REASON_PREFIX)) {
        throw unprocessable(`Deprecation reasons cannot start with "${ROLE_TEMPLATE_GAP_REASON_PREFIX}"; that marker is reserved for the seed installer`);
      }
      const publications: ActivityPublication[] = [];
      const updated = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(roleTemplates)
          .where(eq(roleTemplates.id, row.id))
          .for("update");
        if (!locked || locked.deletedAt) throw notFound("Role template not found");
        if (locked.status === "draft") throw conflict("Only a published role template can be deprecated");
        if (locked.status === "deprecated") return locked;
        const [row2] = await tx
          .update(roleTemplates)
          .set({
            status: "deprecated",
            deprecatedAt: new Date(),
            deprecationReason: options.reason ?? null,
            updatedAt: new Date(),
          })
          .where(eq(roleTemplates.id, locked.id))
          .returning();
        await audit(tx as unknown as Db, companyId, row2.id, "role_template.deprecated", actor, {
          reason: options.reason ?? null,
        }, publications);
        return row2;
      });
      for (const publication of publications) publishActivity(publication);
      return updated;
    },

    /** deprecated → published: resume hiring at the latest version. */
    restore: async (
      companyId: string,
      templateId: string,
      actor: RoleTemplateAuditActor,
    ): Promise<RoleTemplate> => {
      const row = await requireLiveRow(companyId, templateId);
      const publications: ActivityPublication[] = [];
      const updated = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(roleTemplates)
          .where(eq(roleTemplates.id, row.id))
          .for("update");
        if (!locked || locked.deletedAt) throw notFound("Role template not found");
        if (locked.status === "draft") throw conflict("Publish the role template before restoring it");
        if (locked.status === "published") return locked;
        if (locked.currentVersion > 0) {
          const versionRow = await getVersionRow(tx as unknown as Db, companyId, locked.id, locked.currentVersion);
          const missing = versionRow
            ? await missingRoleTemplateSkillKeys(
                tx as unknown as Db,
                companyId,
                (versionRow.spec as RoleTemplateSpec).skills.map((skill) => skill.key),
              )
            : [];
          if (missing.length > 0) {
            throw conflict(
              `The role template's published skills are still missing from the company library: ${missing.join(", ")}`,
            );
          }
        }
        const [row2] = await tx
          .update(roleTemplates)
          .set({
            status: "published",
            deprecatedAt: null,
            deprecationReason: null,
            updatedAt: new Date(),
          })
          .where(eq(roleTemplates.id, locked.id))
          .returning();
        await audit(tx as unknown as Db, companyId, row2.id, "role_template.restored", actor, {
          version: row2.currentVersion,
        }, publications);
        return row2;
      });
      for (const publication of publications) publishActivity(publication);
      return updated;
    },

    /** Soft delete; hired agents' snapshots and version rows survive. */
    softDelete: async (companyId: string, templateId: string, actor: RoleTemplateAuditActor): Promise<RoleTemplate> => {
      const row = await requireLiveRow(companyId, templateId);
      if (row.status === "published") {
        throw conflict("Deprecate the role template before deleting it");
      }
      const publications: ActivityPublication[] = [];
      const updated = await db.transaction(async (tx) => {
        const [row2] = await tx
          .update(roleTemplates)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(and(eq(roleTemplates.id, row.id), isNull(roleTemplates.deletedAt), ne(roleTemplates.status, "published")))
          .returning();
        if (!row2) {
          const [current] = await tx.select().from(roleTemplates).where(eq(roleTemplates.id, row.id)).limit(1);
          if (current && !current.deletedAt && current.status === "published") {
            throw conflict("Deprecate the role template before deleting it");
          }
          throw notFound("Role template not found");
        }
        await audit(tx as unknown as Db, companyId, row2.id, "role_template.deleted", actor, { key: row2.key }, publications);
        return row2;
      });
      for (const publication of publications) publishActivity(publication);
      return updated;
    },

    /**
     * Hire resolution (design §6.2): only published, non-deleted templates with
     * a frozen version row whose skills all resolve can produce an agent.
     */
    resolveForHire: async (
      companyId: string,
      templateId: string,
    ): Promise<{ template: RoleTemplate; version: number; spec: RoleTemplateSpec }> => {
      const row = await getLiveRow(companyId, templateId);
      if (!row || row.status !== "published" || row.currentVersion < 1) {
        throw unprocessable("Role template is not hireable", { code: ROLE_TEMPLATE_NOT_HIREABLE_CODE });
      }
      const versionRow = await getVersionRow(db, companyId, row.id, row.currentVersion);
      if (!versionRow) {
        throw unprocessable("Role template is not hireable", { code: ROLE_TEMPLATE_NOT_HIREABLE_CODE });
      }
      const spec = versionRow.spec as RoleTemplateSpec;
      const missing = await missingRoleTemplateSkillKeys(
        db,
        companyId,
        spec.skills.map((skill) => skill.key),
      );
      if (missing.length > 0) {
        throw unprocessable(
          `Role template skills are missing from the company library: ${missing.join(", ")}. Install them from the catalog or pick another template.`,
          { missingSkillKeys: missing },
        );
      }
      return { template: row, version: versionRow.version, spec };
    },
  };
}

export type RoleTemplateStore = ReturnType<typeof roleTemplateStore>;
