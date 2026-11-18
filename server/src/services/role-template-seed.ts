import { and, eq, isNull, like, sql } from "drizzle-orm";
import { roleTemplates, roleTemplateVersions, type Db, type RoleTemplate } from "@paperclipai/db";
import { roleTemplateSpecSchema, type RoleTemplateSpec } from "@paperclipai/shared";
import { companySkillService } from "./company-skills.js";
import { logActivity } from "./activity-log.js";
import { missingRoleTemplateSkillKeys, type RoleTemplateAuditActor } from "./role-template-store.js";
import contentMarketingSeed from "../role-template-seeds/content-marketing-specialist-v1.json" with { type: "json" };
import softwareEngineerSeed from "../role-template-seeds/software-engineer-v1.json" with { type: "json" };

type RoleTemplateSeedFile = { key: string; spec: unknown };

/** The two templates validated through real agent runs (design §5.5). */
export const ROLE_TEMPLATE_SEEDS: RoleTemplateSeedFile[] = [contentMarketingSeed, softwareEngineerSeed];

export type RoleTemplateSeedOutcome =
  | "installed"
  | "installed_with_gaps"
  | "recovered"
  | "already_present"
  | "conflict";

export type RoleTemplateSeedResult = {
  key: string;
  outcome: RoleTemplateSeedOutcome;
  templateId: string | null;
  missingSkillKeys: string[];
};

const GAPPED_REASON_PREFIX = "missing-skills:";

function gappedReason(missingSkillKeys: string[]): string {
  return `${GAPPED_REASON_PREFIX} ${missingSkillKeys.join(", ")}`;
}

/**
 * Install the seed templates for a company. Idempotent by `(companyId, key)`:
 * an existing live row is never overwritten — except the gapped-seed recovery,
 * where a row installed with `missing-skills:` gaps is conditionally updated
 * (row-locked CAS) once every missing skill resolves. Soft-deleted rows are
 * invisible here, so their keys are reusable.
 */
export async function seedRoleTemplates(
  companyId: string,
  db: Db,
  actor: RoleTemplateAuditActor = { actorType: "system", actorId: "system" },
): Promise<RoleTemplateSeedResult[]> {
  // Materialize the bundled skill inventory first so core-skill seeds can
  // resolve cleanly on a fresh company.
  const inventory = await companySkillService(db).list(companyId);
  const installedKeys = new Set(inventory.map((skill) => skill.key));

  const results: RoleTemplateSeedResult[] = [];
  for (const seed of ROLE_TEMPLATE_SEEDS) {
    const spec = roleTemplateSpecSchema.parse(seed.spec);
    results.push(await installSeed(companyId, db, actor, seed.key, spec, installedKeys));
  }
  return results;
}

async function installSeed(
  companyId: string,
  db: Db,
  actor: RoleTemplateAuditActor,
  key: string,
  spec: RoleTemplateSpec,
  installedKeys: Set<string>,
): Promise<RoleTemplateSeedResult> {
  const missing = spec.skills.map((skill) => skill.key).filter((skillKey) => !installedKeys.has(skillKey));
  const [liveRow] = await db
    .select()
    .from(roleTemplates)
    .where(and(eq(roleTemplates.companyId, companyId), eq(roleTemplates.key, key), isNull(roleTemplates.deletedAt)))
    .limit(1);

  if (!liveRow) {
    try {
      const template = await insertSeedRow(companyId, db, actor, key, spec, missing);
      return {
        key,
        outcome: missing.length > 0 ? "installed_with_gaps" : "installed",
        templateId: template.id,
        missingSkillKeys: missing,
      };
    } catch (error) {
      // A concurrent install won the insert race; treat the row as present.
      if (!(error instanceof Error && "code" in error && (error as { code?: string }).code === "23505")) {
        throw error;
      }
    }
  }

  const row = liveRow ?? (await findLiveRow(db, companyId, key));
  if (!row) {
    return { key, outcome: "conflict", templateId: null, missingSkillKeys: missing };
  }

  // The only overwrite path: recovery of a row this installer previously
  // parked as gapped, gated on the recorded gap reason.
  const isGapped = row.status === "deprecated" && (row.deprecationReason ?? "").startsWith(GAPPED_REASON_PREFIX);
  if (!isGapped) {
    return { key, outcome: "already_present", templateId: row.id, missingSkillKeys: [] };
  }
  return recoverGappedSeed(companyId, db, actor, row, spec);
}

async function findLiveRow(db: Db, companyId: string, key: string): Promise<RoleTemplate | null> {
  const [row] = await db
    .select()
    .from(roleTemplates)
    .where(and(eq(roleTemplates.companyId, companyId), eq(roleTemplates.key, key), isNull(roleTemplates.deletedAt)))
    .limit(1);
  return row ?? null;
}

async function insertSeedRow(
  companyId: string,
  db: Db,
  actor: RoleTemplateAuditActor,
  key: string,
  spec: RoleTemplateSpec,
  missingSkillKeys: string[],
): Promise<RoleTemplate> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [template] = await tx
      .insert(roleTemplates)
      .values({
        companyId,
        key,
        name: spec.templateName,
        // A gapped seed still installs version 1, but only a resolved registry
        // can make it hireable.
        status: missingSkillKeys.length > 0 ? "deprecated" : "published",
        currentVersion: 1,
        workingSpec: spec,
        deprecationReason: missingSkillKeys.length > 0 ? gappedReason(missingSkillKeys) : null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        publishedAt: now,
        deprecatedAt: missingSkillKeys.length > 0 ? now : null,
      })
      .returning();
    await tx.insert(roleTemplateVersions).values({
      templateId: template.id,
      companyId,
      version: 1,
      spec,
      changelog: "Seed install (design §5.5)",
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(tx as unknown as Db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      action: "role_template.created",
      entityType: "role_template",
      entityId: template.id,
      details: { key, seed: true, withGaps: missingSkillKeys.length > 0 || undefined },
    });
    await logActivity(tx as unknown as Db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      action: "role_template.published",
      entityType: "role_template",
      entityId: template.id,
      details: { key, seed: true, version: 1, withGaps: missingSkillKeys.length > 0 || undefined },
    });
    return template;
  });
}

/**
 * Gapped-seed recovery (design §5.3): re-check the gap state inside one
 * transaction and update the row with a conditional, row-locked
 * compare-and-swap. A concurrent board restore, publish or soft delete makes
 * the CAS match zero rows, so the seed reports a conflict instead of
 * overwriting the changed row.
 */
async function recoverGappedSeed(
  companyId: string,
  db: Db,
  actor: RoleTemplateAuditActor,
  row: RoleTemplate,
  spec: RoleTemplateSpec,
): Promise<RoleTemplateSeedResult> {
  return db.transaction(async (tx) => {
    // Re-check skill resolution inside the same transaction.
    const stillMissing = await missingRoleTemplateSkillKeys(
      tx as unknown as Db,
      companyId,
      spec.skills.map((skill) => skill.key),
    );
    if (stillMissing.length > 0) {
      return { key: row.key, outcome: "already_present", templateId: row.id, missingSkillKeys: stillMissing };
    }

    const [updated] = await tx
      .update(roleTemplates)
      .set({
        workingSpec: spec,
        name: spec.templateName,
        status: "published",
        currentVersion: sql`${roleTemplates.currentVersion} + 1`,
        publishedAt: new Date(),
        deprecatedAt: null,
        deprecationReason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(roleTemplates.id, row.id),
          eq(roleTemplates.companyId, companyId),
          isNull(roleTemplates.deletedAt),
          like(roleTemplates.deprecationReason, `${GAPPED_REASON_PREFIX}%`),
        ),
      )
      .returning();
    if (!updated) {
      // The row changed between the read and the CAS: never overwrite it.
      return { key: row.key, outcome: "conflict", templateId: row.id, missingSkillKeys: [] };
    }

    await tx.insert(roleTemplateVersions).values({
      templateId: updated.id,
      companyId,
      version: updated.currentVersion,
      spec,
      changelog: "Seed recovery: missing skills now resolve",
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(tx as unknown as Db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      action: "role_template.published",
      entityType: "role_template",
      entityId: updated.id,
      details: { key: updated.key, seed: true, version: updated.currentVersion, recovery: true },
    });
    return { key: updated.key, outcome: "recovered", templateId: updated.id, missingSkillKeys: [] };
  });
}
