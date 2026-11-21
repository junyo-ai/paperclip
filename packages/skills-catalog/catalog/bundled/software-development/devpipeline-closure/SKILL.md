---
name: devpipeline-closure
description: Run the development loop to closure — design → branch → implement → commit/push → PR → review → CI green → merge → post-hoc report, with hard red lines on staging, commit trailers, evidence-backed progress claims, and blocked-work escalation.
key: paperclipai/bundled/software-development/devpipeline-closure
recommendedForRoles:
  - engineer
tags:
  - development-process
  - git
  - pull-requests
  - delivery
---

# Development Pipeline Closure

Every task runs the same loop to a closed, verifiable end state. The loop is
not done when the code is written — it is done when the PR is merged, CI is
green, and review threads are resolved.

## The loop

```
design/issue → branch → implement → commit/push → PR → review loop
    → CI green → merge (report after the fact) → post-hoc report
```

- Start from the design or issue. If neither exists and the change is not
  trivial, write one before branching.
- One branch per task, cut from the agreed base branch.
- Implement, then commit and push in small single-intent commits.
- Open the PR, enter the review loop (see the `review-loop` skill for round
  discipline).
- Merge only when the closure condition holds: **PR merged-ready = CI green +
  review threads resolved to zero.** When the condition is met and policy
  allows, merge directly and report after the fact instead of waiting for a
  human to click.
- Finish with a post-hoc report: what shipped (PR link, merge hash), what was
  verified, and anything deferred.

## Hard red lines (must)

These are non-negotiable. Violating any of them invalidates the run:

1. **Never `git add -A` or `git add .`.** Stage files explicitly, one by one.
   Blanket staging sweeps in unrelated or sensitive files.
2. **No co-author or "Generated with ..." trailers on commits.** Commits carry
   their message and nothing else.
3. **Progress claims need on-disk evidence.** A claim of progress must cite
   an artifact — a file path, produced bytes, or a commit SHA. "The process is
   still running" is not progress.
4. **When blocked, stop and report.** If an environment problem or a design
   conflict stalls you for more than an hour, stop, report the exact blocking
   point, and propose a minimal unblock. Do not work around it, do not hack
   past it.

## Closure definition

A task is complete when all three hold:

- The PR is merged.
- CI is green on the merged result.
- Review threads are resolved to zero.

Anything less is in progress, not done. Post-hoc reporting closes the loop:
report the merge, the evidence, and the leftovers — briefly, after the merge.

## Anti-patterns

- Declaring a task done with an open PR or a failing check.
- Staging with `git add .` "just this once" because the tree looked clean.
- Reporting "still working on it" for hours with no diff, file, or commit to
  point at.
- Hacking around a broken environment (disabling checks, editing generated
  files, mocking the blocker away) instead of reporting it.
