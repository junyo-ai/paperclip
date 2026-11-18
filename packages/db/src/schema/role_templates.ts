import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { RoleTemplateSpec, RoleTemplateStatus } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * A role template packages a validated hire configuration (persona, skills,
 * defaults) as a versioned, publishable company asset. `workingSpec` is the
 * mutable draft; publish freezes it into an append-only
 * `role_template_versions` row. Hires resolve only against version rows.
 */
export const roleTemplates = pgTable(
  "role_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Company deletion removes templates with the company; ordinary template
    // deletion stays soft so hired agents keep their provenance.
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<RoleTemplateStatus>().notNull().default("draft"),
    // Installer provenance: only rows the seed installer created ("seed") are
    // eligible for gapped-seed recovery; board-authored rows never are.
    origin: text("origin").$type<"manual" | "seed">().notNull().default("manual"),
    currentVersion: integer("current_version").notNull().default(0),
    workingSpec: jsonb("working_spec").$type<RoleTemplateSpec>().notNull(),
    // Free-text reason recorded on deprecation; the "missing-skills: <keys>"
    // form is written by the seed installer and gates gapped-seed recovery.
    deprecationReason: text("deprecation_reason"),
    sourceIssueId: uuid("source_issue_id"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    // Router-reserved columns (design §8): preconfiguration only, nothing
    // reads them in this phase beyond the admin PATCH.
    routerVisible: boolean("router_visible").notNull().default(false),
    dispatchWeight: integer("dispatch_weight").notNull().default(0),
    capabilityTags: text("capability_tags").array().notNull().default([]),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The key is unique per company among live rows, so it can be reused
    // after a soft delete.
    companyKeyLiveIdx: uniqueIndex("role_templates_company_key_live_idx")
      .on(table.companyId, table.key)
      .where(sql`(${table.deletedAt} is null)`),
    companyStatusIdx: index("role_templates_company_status_idx")
      .on(table.companyId, table.status)
      .where(sql`(${table.deletedAt} is null)`),
    capabilityTagsIdx: index("role_templates_capability_tags_idx").using("gin", table.capabilityTags),
  }),
);

/** Immutable spec frozen at publish time; append-only, never updated or deleted. */
export const roleTemplateVersions = pgTable(
  "role_template_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id").notNull().references(() => roleTemplates.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    spec: jsonb("spec").$type<RoleTemplateSpec>().notNull(),
    changelog: text("changelog"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    templateVersionUniqueIdx: uniqueIndex("role_template_versions_template_version_idx").on(
      table.templateId,
      table.version,
    ),
  }),
);

/**
 * Idempotency receipts for template creation: same key + same body replays the
 * original create, a different body with the same key conflicts. Follows the
 * `company_skill_mutation_receipts` convention.
 */
export const roleTemplateCreateReceipts = pgTable(
  "role_template_create_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    templateId: uuid("template_id").notNull().references(() => roleTemplates.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyIdx: uniqueIndex("role_template_create_receipts_key_idx").on(table.companyId, table.key),
  }),
);

export type RoleTemplate = typeof roleTemplates.$inferSelect;
export type RoleTemplateVersion = typeof roleTemplateVersions.$inferSelect;
