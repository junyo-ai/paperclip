import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { companyMemberships, type Db } from "@paperclipai/db";
import {
  ROLE_TEMPLATE_KEY_PATTERN,
  roleTemplateSpecSchema,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import {
  deriveRoleTemplateKey,
  missingRoleTemplateSkillKeys,
  roleTemplateSpecHash,
  roleTemplateStore,
  type RoleTemplateAuditActor,
} from "./role-template-store.js";
import type {
  ToolGatewayDescriptor,
  ToolGatewaySession,
} from "./tool-gateway.js";

/**
 * Chat-side wiring for the conversational role-template builder (issue #13).
 * The agent proposes; only a confirmed, company-admin sponsored call stores.
 * Templates stay company-scoped drafts here — publishing remains a board API.
 */

const draftInputSchema = z
  .object({
    key: z.string().regex(ROLE_TEMPLATE_KEY_PATTERN).optional(),
    spec: roleTemplateSpecSchema,
  })
  .strict();

const createInputSchema = draftInputSchema
  .extend({
    idempotencyKey: z.string().min(1).max(160),
  })
  .strict();

export type RoleTemplateChatSession = Pick<
  ToolGatewaySession,
  "companyId" | "agentId" | "runId" | "actorType" | "actorId" | "responsibleUserId"
>;

export const ROLE_TEMPLATE_CHAT_TOOLS: readonly ToolGatewayDescriptor[] = [
  {
    name: "role-template-builder:draft_role_template",
    displayName: "Draft a role template",
    description:
      "Draft a company role template from the user's description and validate it against the Paperclip template schema without storing anything. Returns either the normalized draft with its key and fingerprint, or the exact issues to fix (and any spec skills missing from the company library). Iterate with the user until the draft is valid, show it to them, and only then — after their explicit confirmation — call create_role_template with the same key and spec.",
    parametersSchema: z.toJSONSchema(draftInputSchema, {
      target: "draft-7",
      io: "input",
    }),
    pluginId: "role-template-builder",
    providerType: "paperclip_role_template",
    risk: "read",
    upstreamToolName: "draft_role_template",
  },
  {
    name: "role-template-builder:create_role_template",
    displayName: "Create the confirmed role template",
    description:
      "Store a role template the user already reviewed and explicitly confirmed. Requires this chat's sponsoring user to be an active company owner or admin; the agent itself can never publish. Reuse the same idempotencyKey for retries of the same confirmation: an identical body replays the stored template, a different body is rejected. Creates a draft only — publishing stays a board action.",
    parametersSchema: z.toJSONSchema(createInputSchema, {
      target: "draft-7",
      io: "input",
    }),
    pluginId: "role-template-builder",
    providerType: "paperclip_role_template",
    risk: "write",
    upstreamToolName: "create_role_template",
  },
];

/**
 * The human behind the chat is the only possible publisher: the acting user
 * when a user drives the session directly, otherwise the run's responsible
 * user. Purely autonomous agent sessions resolve to no one and are refused.
 */
async function requireSponsoringCompanyAdmin(
  db: Db,
  session: RoleTemplateChatSession,
): Promise<RoleTemplateAuditActor> {
  const sponsorUserId =
    session.actorType === "user"
      ? session.actorId ?? null
      : session.responsibleUserId ?? null;
  if (!sponsorUserId) {
    throw forbidden(
      "Creating role templates from chat requires a company admin: no verified human sponsors this session",
    );
  }
  const [membership] = await db
    .select({ membershipRole: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, session.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, sponsorUserId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .limit(1);
  if (
    !membership ||
    (membership.membershipRole !== "owner" && membership.membershipRole !== "admin")
  ) {
    throw forbidden(
      "Only company owners and admins may confirm creating a role template from chat",
    );
  }
  return {
    actorType: "user",
    actorId: sponsorUserId,
    agentId: session.agentId,
    runId: session.runId,
  };
}

export async function executeRoleTemplateTool(
  db: Db,
  session: RoleTemplateChatSession,
  name: string,
  parameters: unknown,
) {
  if (name === "draft_role_template") {
    const parsed = draftInputSchema.safeParse(parameters);
    if (!parsed.success) {
      return {
        valid: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      };
    }
    const spec = parsed.data.spec;
    const key = parsed.data.key ?? deriveRoleTemplateKey(spec.templateName);
    if (!key) {
      return {
        valid: false,
        issues: [
          {
            path: "key",
            message:
              "A template key is required: the template name contains no usable slug (lowercase letters, digits, dashes)",
          },
        ],
      };
    }
    return {
      valid: true,
      stored: false,
      draft: { key, spec },
      fingerprint: roleTemplateSpecHash({ key, spec }),
      missingSkills: await missingRoleTemplateSkillKeys(
        db,
        session.companyId,
        spec.skills.map((skill) => skill.key),
      ),
    };
  }

  if (name === "create_role_template") {
    const actor = await requireSponsoringCompanyAdmin(db, session);
    const parsed = createInputSchema.safeParse(parameters);
    if (!parsed.success) {
      throw unprocessable("Invalid role template creation request", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const { key, spec, idempotencyKey } = parsed.data;
    const { template, replayed } = await roleTemplateStore(db).create(
      session.companyId,
      { key, spec },
      actor,
      { idempotencyKey },
    );
    return {
      created: !replayed,
      replayed,
      template: {
        id: template.id,
        key: template.key,
        name: template.name,
        status: template.status,
      },
    };
  }

  throw unprocessable(`Unknown role template tool: ${name}`);
}
