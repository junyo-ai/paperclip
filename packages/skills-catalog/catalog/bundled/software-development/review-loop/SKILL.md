---
name: review-loop
description: Drive PR review rounds with discipline — cap at 3 rounds, count unresolved threads via the API before each round, close out on low-priority leftovers, trigger @coderabbitai review manually on non-default bases, and fall back (Copilot/codex) when the review service is down.
key: paperclipai/bundled/software-development/review-loop
recommendedForRoles:
  - engineer
tags:
  - code-review
  - pull-requests
  - github
  - process
---

# PR Review Loop

Review is a bounded loop, not an open-ended cycle. Each round costs a full
CI-and-review pass, so spend rounds deliberately and know when to stop.

## Round budget: at most 3

- Round 1 is the review on the PR as opened (or the first manually triggered
  review).
- Each further round only happens if unresolved feedback remains.
- Never trigger round after round hoping for a different outcome. After the
  third round, address what is addressable and escalate the rest in a comment.

## Before every round: count unresolved threads

- Query the PR's unresolved review threads via the API
  (`GET /repos/{owner}/{repo}/pulls/{number}/comments`, then the review
  threads endpoint) before triggering anything.
- **Zero unresolved threads = no new round — but only after the initial
  review has completed.** A new PR has zero threads because nothing reviewed
  it yet: if no review has run, trigger the first one; if a review is in
  progress, wait for its result before deciding to close out.
- Track rounds by `original_commit_id` on review comments: comments sharing an
  `original_commit_id` belong to the same round, so you can tell round 2
  feedback from re-asserted round 1 feedback.

## Last-round rule

- If the only remaining comments are low-priority (nits, optional cleanups,
  style preferences with no functional impact), fix them and close out. Do
  not trigger another review round to re-verify nit fixes.
- Reply on every thread you address with "fixed in `<commit-sha>`", then
  resolve the thread explicitly (the `resolveReviewThread` GraphQL mutation
  or the PR UI). A reply alone does not resolve a thread.
- Re-query the unresolved count after resolving. If a thread only the
  reviewer can resolve, ask them to resolve it; do not claim closure while
  any thread is unresolved.

## Manual trigger mode

- On non-default base branches, automated reviewers do not pick the PR up by
  themselves. Trigger manually with a PR comment: `@coderabbitai review`.
- Trigger once per round, after pushing the fixes for that round. Repeated
  triggers for the same SHA waste quota and add noise.

## Quota discipline and fallback

- Do not re-trigger a review that is already running on the current head.
- If the review service is unavailable (errors, timeouts, quota exhausted),
  do not stall the PR: fall back along the escalation path — Copilot review,
  codex, or a named human reviewer — and say in the PR which fallback ran and
  why.

## Closure

The loop ends when unresolved threads are zero and CI is green. Then apply
the merge policy from the `devpipeline-closure` skill: merge and report after
the fact.

## Anti-patterns

- Triggering a fresh review round when the API already reports zero
  unresolved threads.
- Spending a round on pure nits, then another round to confirm the nits.
- Silent fixes without thread replies, leaving the thread count looking open.
- Letting a PR sit for hours because the review bot is down, when a fallback
  reviewer was one comment away.
