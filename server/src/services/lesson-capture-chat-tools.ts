import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  agents,
  companyMemberships,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  joinFrontmatterBlock,
  splitFrontmatterBlock,
  stringifyFrontmatter,
} from "@paperclipai/shared";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { companySkillService } from "./company-skills.js";
import type {
  ToolGatewayDescriptor,
  ToolGatewaySession,
} from "./tool-gateway.js";

/**
 * Chat-side wiring for the conversational lesson capture loop (issue #19).
 * The agent proposes; only a confirmed, company-admin sponsored call writes.
 * Lessons land in one managed skill per domain (`lessons-<domain>`) so the
 * normal skill delivery path (agent assignment -> pinned version staging ->
 * harness progressive disclosure) picks them up on later runs.
 *
 * The sponsor resolution below mirrors role-template-chat-tools (issue #13);
 * it is deliberately not shared with that module.
 */

/** Single lowercase path segment: the only surface a domain may control. */
const LESSON_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const LESSON_SKILL_DESCRIPTION_LIMIT = 300;

/** Entries are parsed back line-by-line, so every field must stay single-line. */
const singleLine = (value: string) => !/[\r\n]/.test(value);

const lessonInputSchema = z
  .object({
    domain: z.string().regex(LESSON_DOMAIN_PATTERN, {
      message:
        "Domain must be 1-40 chars of lowercase letters, digits, and dashes (e.g. git, ci, billing)",
    }),
    trigger: z.string().trim().min(3).max(160).refine(singleLine, {
      message: "Trigger must be a single line.",
    }),
    rule: z.string().trim().min(3).max(600).refine(singleLine, {
      message: "Rule must be a single line.",
    }),
    evidence: z.string().trim().min(3).max(600).refine(singleLine, {
      message: "Evidence must be a single line.",
    }),
  })
  .strict();

export type LessonCaptureChatSession = Pick<
  ToolGatewaySession,
  | "companyId"
  | "agentId"
  | "runId"
  | "actorType"
  | "actorId"
  | "responsibleUserId"
  | "identityContextId"
>;

export const LESSON_CAPTURE_CHAT_TOOLS: readonly ToolGatewayDescriptor[] = [
  {
    name: "lesson-capture:propose_lesson",
    displayName: "Propose an operational lesson",
    description:
      "Draft a lesson entry (domain, trigger, rule, evidence) from a pitfall the agent just hit, without storing anything. Returns the rendered markdown entry, the target lessons-<domain> skill, and whether that trigger is already captured. Iterate with the user until the entry is right, show them the preview, and only then — after their explicit confirmation — call record_lesson with the same domain, trigger, rule, and evidence. If the draft reports alreadyCaptured, tell the user the lesson already exists.",
    parametersSchema: z.toJSONSchema(lessonInputSchema, {
      target: "draft-7",
      io: "input",
    }),
    pluginId: "lesson-capture",
    providerType: "paperclip_lesson_capture",
    risk: "read",
    upstreamToolName: "propose_lesson",
  },
  {
    name: "lesson-capture:record_lesson",
    displayName: "Record the confirmed lesson",
    description:
      "Store a lesson entry the user already reviewed and explicitly confirmed. Requires this chat's sponsoring user to be an active company owner or admin; the agent itself can never write lessons. Writing is idempotent per domain + trigger: resubmitting an already-captured trigger returns alreadyCaptured without writing. The entry lands in the company's lessons-<domain> skill, and that skill is assigned to this agent so future runs load it.",
    parametersSchema: z.toJSONSchema(lessonInputSchema, {
      target: "draft-7",
      io: "input",
    }),
    pluginId: "lesson-capture",
    providerType: "paperclip_lesson_capture",
    risk: "write",
    upstreamToolName: "record_lesson",
  },
];

function lessonSkillSlug(domain: string) {
  return `lessons-${domain}`;
}

function lessonSkillKey(companyId: string, domain: string) {
  return `company/${companyId}/lessons-${domain}`;
}

function lessonSkillName(domain: string) {
  return `Lessons: ${domain}`;
}

function truncateDescription(text: string) {
  return text.length <= LESSON_SKILL_DESCRIPTION_LIMIT
    ? text
    : `${text.slice(0, LESSON_SKILL_DESCRIPTION_LIMIT - 1)}…`;
}

/** The description is the always-visible surface under progressive disclosure, so it enumerates triggers. */
function lessonSkillDescription(domain: string, triggers: string[]) {
  return truncateDescription(`Lessons for ${domain}: ${triggers.join(" | ")}`);
}

function normalizeTriggerForCompare(trigger: string) {
  return trigger.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

function lessonEntryHeading(trigger: string, capturedAt: string) {
  return `### ${trigger}（${capturedAt}）`;
}

function renderLessonEntry(
  trigger: string,
  rule: string,
  evidence: string,
  capturedAt: string,
) {
  return [
    lessonEntryHeading(trigger, capturedAt),
    `- **Rule**: ${rule}`,
    `- **Evidence**: ${evidence}`,
  ].join("\n");
}

function renderInitialLessonSkill(
  domain: string,
  trigger: string,
  rule: string,
  evidence: string,
  capturedAt: string,
) {
  return [
    "---",
    stringifyFrontmatter({
      name: lessonSkillName(domain),
      description: lessonSkillDescription(domain, [trigger]),
    }),
    "---",
    "",
    `# ${lessonSkillName(domain)}`,
    "",
    `Operational lessons captured from real incidents in the ${domain} domain. Each entry: trigger, rule, evidence. Load this skill before ${domain} work to avoid known pitfalls.`,
    "",
    "## Lessons",
    "",
    renderLessonEntry(trigger, rule, evidence, capturedAt),
    "",
  ].join("\n");
}

/** Trigger headings are `### <trigger>（date）`; the date never identifies a lesson. */
function lessonTriggers(markdown: string): string[] {
  const { body } = splitFrontmatterBlock(markdown);
  const out: string[] = [];
  for (const match of body.matchAll(/^### (.+)$/gm)) {
    out.push(match[1]!.replace(/[（(][^）)]*[）)]\s*$/, "").trim());
  }
  return out;
}

function hasLessonTrigger(markdown: string, trigger: string) {
  const wanted = normalizeTriggerForCompare(trigger);
  return lessonTriggers(markdown).some(
    (existing) => normalizeTriggerForCompare(existing) === wanted,
  );
}

/** Rewrite only the `description:` frontmatter line, leaving every other byte intact. */
function withLessonSkillDescription(markdown: string, description: string) {
  const block = splitFrontmatterBlock(markdown);
  if (!block.hasFrontmatter) return markdown;
  const line = stringifyFrontmatter({ description });
  const lines = block.frontmatterText.split("\n");
  const descriptionIndex = lines.findIndex((entry) => /^description\s*:/.test(entry));
  if (descriptionIndex >= 0) {
    lines[descriptionIndex] = line;
  } else {
    const nameIndex = lines.findIndex((entry) => /^name\s*:/.test(entry));
    lines.splice(nameIndex >= 0 ? nameIndex + 1 : 0, 0, line);
  }
  return joinFrontmatterBlock({ ...block, frontmatterText: lines.join("\n") });
}

function appendLessonEntry(
  markdown: string,
  domain: string,
  triggers: string[],
  entry: string,
) {
  const block = splitFrontmatterBlock(markdown);
  const nextBody = `${block.body.replace(/\s+$/, "")}\n\n${entry}\n`;
  const next = block.hasFrontmatter
    ? joinFrontmatterBlock({ ...block, body: nextBody })
    : nextBody;
  return withLessonSkillDescription(
    next,
    lessonSkillDescription(domain, triggers),
  );
}

function lessonFingerprint(
  domain: string,
  trigger: string,
  rule: string,
  evidence: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        domain,
        trigger: normalizeTriggerForCompare(trigger),
        rule,
        evidence,
      }),
    )
    .digest("hex");
}

/**
 * The human behind the chat is the only possible confirmer: the acting user
 * when a user drives the session directly, otherwise the run's responsible
 * user. Mirrors role-template-chat-tools, including the rule that a
 * company_default identity snapshot carries no sponsor and purely autonomous
 * agent sessions resolve to no one and are refused.
 */
async function resolveSponsorUserId(
  db: Db,
  session: LessonCaptureChatSession,
): Promise<string | null> {
  if (session.actorType === "user") return session.actorId ?? null;
  if (session.responsibleUserId) return session.responsibleUserId;
  if (session.runId && !session.identityContextId) {
    const [run] = await db
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, session.companyId),
          eq(heartbeatRuns.id, session.runId),
        ),
      );
    return run?.responsibleUserId ?? null;
  }
  return null;
}

async function requireSponsoringCompanyAdmin(
  db: Db,
  session: LessonCaptureChatSession,
): Promise<{ userId: string; agentId: string | null; runId: string | null }> {
  const sponsorUserId = await resolveSponsorUserId(db, session);
  if (!sponsorUserId) {
    throw forbidden(
      "Recording lessons from chat requires a company admin: no verified human sponsors this session",
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
      "Only company owners and admins may confirm recording a lesson from chat",
    );
  }
  return { userId: sponsorUserId, agentId: session.agentId, runId: session.runId };
}

/**
 * A lessons skill only reaches an agent's runs through its desired-skills
 * preference. Add it (unpinned, so later lessons in the same skill ride
 * along) unless the agent already carries an unpinned entry; a stale version
 * pin is cleared so new lessons in the skill are not skipped. The row lock
 * serializes concurrent recordings so no assignment is lost.
 */
async function ensureSkillAssignedToAgent(
  db: Db,
  companyId: string,
  agentId: string | null,
  skillKey: string,
): Promise<boolean> {
  if (!agentId) return false;
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)))
      .for("update");
    if (!agent) return false;
    const adapterConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const entries = readPaperclipSkillSyncPreference(adapterConfig).desiredSkillEntries;
    let changed = false;
    const next = entries.map((entry) => {
      if (entry.key !== skillKey) return entry;
      if (!entry.versionId) return entry;
      changed = true;
      return { key: skillKey, versionId: null };
    });
    if (!entries.some((entry) => entry.key === skillKey)) {
      next.push({ key: skillKey, versionId: null });
      changed = true;
    }
    if (!changed) return true;
    await tx
      .update(agents)
      .set({
        adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, next),
      })
      .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    return true;
  });
}

export async function executeLessonCaptureTool(
  db: Db,
  session: LessonCaptureChatSession,
  name: string,
  parameters: unknown,
) {
  if (name === "propose_lesson") {
    const parsed = lessonInputSchema.safeParse(parameters);
    if (!parsed.success) {
      return {
        valid: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      };
    }
    const { domain, trigger, rule, evidence } = parsed.data;
    const service = companySkillService(db);
    const skillKey = lessonSkillKey(session.companyId, domain);
    const skill = await service.getByKey(session.companyId, skillKey);
    let alreadyCaptured = false;
    if (skill) {
      const file = await service.readFile(session.companyId, skill.id, "SKILL.md");
      if (!file) throw notFound("Lesson skill disappeared while drafting");
      alreadyCaptured = hasLessonTrigger(file.content, trigger);
    }
    return {
      valid: true,
      stored: false,
      domain,
      skill: { key: skillKey, name: lessonSkillName(domain) },
      entry: renderLessonEntry(trigger, rule, evidence, today()),
      fingerprint: lessonFingerprint(domain, trigger, rule, evidence),
      alreadyCaptured,
    };
  }

  if (name === "record_lesson") {
    const sponsor = await requireSponsoringCompanyAdmin(db, session);
    const parsed = lessonInputSchema.safeParse(parameters);
    if (!parsed.success) {
      throw unprocessable("Invalid lesson record request", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const { domain, trigger, rule, evidence } = parsed.data;
    const actor = {
      type: "user" as const,
      userId: sponsor.userId,
      agentId: sponsor.agentId,
    };
    const service = companySkillService(db);
    const skillKey = lessonSkillKey(session.companyId, domain);
    let skill = await service.getByKey(session.companyId, skillKey);
    let recorded = false;
    let versionId: string | null = null;
    if (!skill) {
      skill = await service.createLocalSkill(
        session.companyId,
        {
          slug: lessonSkillSlug(domain),
          name: lessonSkillName(domain),
          description: lessonSkillDescription(domain, [trigger]),
          markdown: renderInitialLessonSkill(domain, trigger, rule, evidence, today()),
        },
        actor,
        { label: `Lesson: ${trigger}` },
      );
      recorded = true;
      versionId = skill.currentVersionId;
    } else {
      const file = await service.readFile(session.companyId, skill.id, "SKILL.md");
      if (!file) throw notFound("Lesson skill disappeared while recording");
      if (!hasLessonTrigger(file.content, trigger)) {
        const entry = renderLessonEntry(trigger, rule, evidence, today());
        const markdown = appendLessonEntry(
          file.content,
          domain,
          [...lessonTriggers(file.content), trigger],
          entry,
        );
        const saved = await service.updateFile(
          session.companyId,
          skill.id,
          "SKILL.md",
          markdown,
          actor,
          {
            expectedVersionId: file.versionId,
            publication: { label: `Lesson: ${trigger}` },
          },
        );
        recorded = true;
        versionId = saved.versionId ?? null;
      }
    }
    const assignedToAgent = await ensureSkillAssignedToAgent(
      db,
      session.companyId,
      session.agentId,
      skillKey,
    );
    return {
      recorded,
      alreadyCaptured: !recorded,
      skill: { id: skill.id, key: skill.key, name: skill.name, versionId },
      assignedToAgent,
    };
  }

  throw unprocessable(`Unknown lesson capture tool: ${name}`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
