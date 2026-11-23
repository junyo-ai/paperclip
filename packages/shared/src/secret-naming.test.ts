import { describe, expect, it } from "vitest";
import { GITHUB_TOKEN_SECRET_NAMES } from "./constants.js";
import { githubTokenSecretNameHint, looksLikeGithubTokenValue } from "./secret-naming.js";

describe("looksLikeGithubTokenValue", () => {
  it("detects real GitHub token shapes", () => {
    expect(looksLikeGithubTokenValue("ghp_16CharClassicTokenToken")).toBe(true);
    expect(looksLikeGithubTokenValue("gho_16CharOauthTokenToken")).toBe(true);
    expect(looksLikeGithubTokenValue("github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyzabc0")).toBe(true);
  });

  it("ignores non-GitHub values and short input", () => {
    expect(looksLikeGithubTokenValue("sk-proj-abcdefghijklmnop")).toBe(false);
    expect(looksLikeGithubTokenValue("password123")).toBe(false);
    expect(looksLikeGithubTokenValue("ghp_short")).toBe(false);
    expect(looksLikeGithubTokenValue("")).toBe(false);
    expect(looksLikeGithubTokenValue(null)).toBe(false);
  });
});

describe("githubTokenSecretNameHint", () => {
  it("stays quiet for canonical names exactly as typed", () => {
    for (const name of GITHUB_TOKEN_SECRET_NAMES) {
      expect(githubTokenSecretNameHint({ name, value: "ghp_16CharClassicTokenToken" })).toBeNull();
    }
  });

  it("warns on a lowercase canonical name because lookup is exact", () => {
    const hint = githubTokenSecretNameHint({ name: "github_token" });
    expect(hint?.reason).toBe("name_matches");
    expect(hint?.canonicalName).toBe("GITHUB_TOKEN");
  });

  it("stays quiet for GitHub OAuth and webhook credential names", () => {
    expect(githubTokenSecretNameHint({ name: "GITHUB_CLIENT_ID", value: "Iv1.abc123def456" })).toBeNull();
    expect(githubTokenSecretNameHint({ name: "GITHUB_CLIENT_SECRET", value: "abc123def4567890" })).toBeNull();
    expect(githubTokenSecretNameHint({ name: "dev/github/oauth/clientsecret", value: "abc123def4567890" })).toBeNull();
    expect(githubTokenSecretNameHint({ name: "GITHUB_WEBHOOK_SECRET", value: "abc123def4567890" })).toBeNull();
  });

  it("still warns when an OAuth-named secret actually holds a token", () => {
    const hint = githubTokenSecretNameHint({ name: "GITHUB_CLIENT_ID", value: "ghp_16CharClassicTokenToken" });
    expect(hint?.reason).toBe("value_matches");
    expect(hint?.canonicalName).toBe("GITHUB_TOKEN");
  });

  it("warns on GitHub-like names that are not canonical", () => {
    const hint = githubTokenSecretNameHint({ name: "GITHUB_PAT" });
    expect(hint).not.toBeNull();
    expect(hint?.code).toBe("github_token_secret_name");
    expect(hint?.reason).toBe("name_matches");
    expect(hint?.canonicalName).toBe("GITHUB_TOKEN");
    expect(hint?.message).toContain("GITHUB_PAT");
    expect(hint?.message).toContain("GITHUB_TOKEN");
  });

  it("warns on gh-prefixed names", () => {
    expect(githubTokenSecretNameHint({ name: "GH_PAT" })?.reason).toBe("name_matches");
  });

  it("warns on near-miss typos of a canonical name", () => {
    const hint = githubTokenSecretNameHint({ name: "GITHUB_TOKEN_BACKUP" });
    expect(hint).not.toBeNull();
    const typo = githubTokenSecretNameHint({ name: "GITHUB_TOKE" });
    expect(typo?.canonicalName).toBe("GITHUB_TOKEN");
  });

  it("warns on token-shaped values under a neutral name", () => {
    const hint = githubTokenSecretNameHint({ name: "deploy_pat", value: "ghp_16CharClassicTokenToken" });
    expect(hint?.reason).toBe("value_matches");
    expect(hint?.canonicalName).toBe("GITHUB_TOKEN");
  });

  it("stays quiet for unrelated secrets", () => {
    expect(githubTokenSecretNameHint({ name: "STRIPE_API_KEY", value: "sk_live_abcdefghijklmnop" })).toBeNull();
    expect(githubTokenSecretNameHint({ name: "SLACK_BOT_TOKEN" })).toBeNull();
  });
});
