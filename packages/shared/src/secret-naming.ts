import { GITHUB_TOKEN_SECRET_NAMES, type GithubTokenSecretName } from "./constants.js";

/**
 * GitHub-token secret-name contract helper.
 *
 * Workspace checkout and the GitHub providers only read company secrets whose
 * *name* is one of GITHUB_TOKEN / GH_TOKEN / PAPERCLIP_GITHUB_TOKEN (or whose
 * secret is explicitly bound to an agent/project `env.<name>` path). A token
 * stored under any other name silently resolves to nothing and the run then
 * reports "No GitHub credential is configured", which reads as if no secret
 * exists. This helper detects likely mismatches at creation time so the
 * operator sees the problem while they can still fix the name.
 */

export type GithubTokenSecretNameHintReason = "name_matches" | "value_matches";

export type GithubTokenSecretNameHint = {
  code: "github_token_secret_name";
  /** Which signal flagged the secret: its name, or the token value's shape. */
  reason: GithubTokenSecretNameHintReason;
  /** The canonical name this secret should be stored under. */
  canonicalName: GithubTokenSecretName;
  /** Operator-facing single-sentence explanation; safe to show inline. */
  message: string;
};

/** Prefix shapes of real GitHub tokens (classic PAT, OAuth/user, app, and fine-grained). */
const GITHUB_TOKEN_VALUE_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "github_pat_"] as const;

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  const previous = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) previous[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

/**
 * True when the value's shape looks like a GitHub token. Prefix-only: the value
 * itself is never returned or logged by callers.
 */
export function looksLikeGithubTokenValue(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (trimmed.length < 10) return false;
  return GITHUB_TOKEN_VALUE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function canonicalNameFor(normalizedName: string): GithubTokenSecretName {
  // A near-match (typo of a canonical name) wins over the default suggestion.
  const threshold = Math.max(normalizedName.length, 4) >= 8 ? 2 : 1;
  let best: { name: GithubTokenSecretName; distance: number } | null = null;
  for (const candidate of GITHUB_TOKEN_SECRET_NAMES) {
    const distance = editDistance(normalizedName, candidate);
    if (distance > 0 && distance <= threshold && (!best || distance < best.distance)) {
      best = { name: candidate, distance };
    }
  }
  return best?.name ?? GITHUB_TOKEN_SECRET_NAMES[0];
}

function matchesGithubTokenNameShape(normalizedName: string): boolean {
  if (normalizedName.includes("GITHUB")) return true;
  return /^GH([_-]|$)/.test(normalizedName);
}

/**
 * Return a warning hint when a company secret looks like it is meant to carry a
 * GitHub token but its name is outside the canonical set. Returns null when the
 * name is canonical or carries no GitHub signal — non-GitHub secrets must stay
 * quiet.
 */
export function githubTokenSecretNameHint(input: {
  name: string;
  value?: string | null;
}): GithubTokenSecretNameHint | null {
  const name = input.name.trim();
  const normalizedName = name.toUpperCase();
  if ((GITHUB_TOKEN_SECRET_NAMES as readonly string[]).includes(normalizedName)) return null;

  const nameMatches = matchesGithubTokenNameShape(normalizedName);
  const valueMatches = looksLikeGithubTokenValue(input.value);
  if (!nameMatches && !valueMatches) return null;

  const canonicalName = canonicalNameFor(normalizedName);
  const canonicalList = GITHUB_TOKEN_SECRET_NAMES.join(", ");
  const message = nameMatches
    ? `Secrets named "${name}" are not read as GitHub credentials — only ${canonicalList} are (or bind this secret to env.${canonicalName} on the agent or project). Rename it to ${canonicalName} to use it automatically.`
    : `This value looks like a GitHub token, but the secret name "${name}" is not one Paperclip reads for GitHub credentials (${canonicalList}). Rename it to ${canonicalName}, or bind it to env.${canonicalName}.`;
  return { code: "github_token_secret_name", reason: nameMatches ? "name_matches" : "value_matches", canonicalName, message };
}
