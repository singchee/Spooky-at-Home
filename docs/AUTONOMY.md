# Autonomy policy — what the crew decides alone, and what comes to you

*Decision rights for the unattended crew, how it escalates, and the safety nets around it*

**Protected file:** the crew can't change this file. Any change to it is class C.

## 1. The principle

The crew works, checks and merges on its own **when the change is small, proven by tests, and inside decisions you've already made**. Anything about taste, scope, spending, safety or its own rules comes to you.

Deciding what is "minor" is itself a risk: a system grading its own work tends to call things minor. So:
1. **The class comes from fixed rules on the diff** (`tools/classify-change.ts`), not from an agent's opinion.
2. **Agents can raise a class, never lower it.**
3. **When unsure, escalate.**

## 2. Decision classes

| Class | Crew may… | Examples | You hear about it |
|---|---|---|---|
| **A — handle it** | Merge after gates pass | Bug fix with a regression test; refactor with no behaviour change; more tests; docs; performance gains within budget; review nits; balance tweak ≤ 15% that keeps results inside target bands | Listed in the digest |
| **B — handle it, tell you** | Merge after gates pass; **you can veto** within 7 days and it gets reverted | Building a backlog item you already approved (a phase in `PLAN.md`); patch/minor dependency updates; on-screen wording; new map fixtures (public places) | **Highlighted** in the digest |
| **C — ask first** | Open a **draft** PR + an escalation issue, then **work on something else** | Anything about taste, tone or the five pillars; new mission type, weapon, enemy or camera not in the plan; changing a quality gate, budget or balance band; deleting, skipping or loosening a test; **spending money or credits** (ElevenLabs, APIs); new external service, host, connector or dependency; privacy, attribution or licence; moving to the next phase; changes to the crew's own rules (`.claude/`, `CLAUDE.md`, `PLAN.md`, this file, `docs/QUALITY.md`, CI) | Escalation issue + phone notification |
| **D — stop and alert** | Take the safe action listed, then halt all work | `main` broken after a merge → **auto-revert**; a secret committed → remove it and alert (you'll need to rotate the key); spending or loop runaway → stop; privacy leak (real home location committed) → remove and alert | Escalation issue + phone notification, marked URGENT |

**Also escalate (class C) when:**
- Two crew roles disagree and the evidence doesn't settle it.
- A checker says BLOCKED twice on the same item.
- The same item fails its gates after 2 fix rounds.
- A playtest or debrief suggests the game isn't fun. Numbers can't settle that; you can.

## 3. Who approves what (the two-key rule)

A class A or B change merges only when **all** of these hold:
1. The **builder** opened it (main session, via `/build` or `/fix-bug`).
2. An **independent checker** with fresh context passed it (`code-reviewer`, plus the playtest, balance or map checks the change needs).
3. `/preflight` says READY at the current commit, and **GitHub CI is green** on the PR.
4. The rule-based class is A or B, and no agent raised it.

Then the crew squash-merges, so each change is one commit that can be undone with one revert.

## 4. How escalation works

- **Channel:** a GitHub issue labelled `needs-you`, plus a phone notification at the end of the run.
- **Format** (one decision per issue):
  - **Decision needed**, in one sentence
  - **Recommendation**, with the reason
  - **Options**, ranked, each with its cost and risk
  - **What the crew does meanwhile**: always "parks this and continues other work", never "goes ahead by default"
  - **Evidence**: links to reports, the draft PR, screenshots
- **Your answer:** comment on the issue in plain words ("go with option 2", "no", "make it scarier"). The next run reads it, acts on it, and closes the issue.
- **No answer:** the item stays parked. The crew never treats silence as approval.

## 5. Safety nets

| Net | How |
|---|---|
| **Pause switch** | Open any issue with the label `autopilot-paused` (works from the phone app). Every run checks for it first and stops. Close the issue to resume. |
| **Work cap per run** | At most 1 backlog item **or** 3 bug fixes, and at most 2 fix rounds per finding. |
| **Run cap** | 2 scheduled runs a day. Change it in the scheduled task, not in code. |
| **Undo** | Squash merges; `main` CI is checked after every merge and auto-reverted if red. |
| **Digest** | One pinned issue, `Crew digest`, with a comment per run: merged (A), merged and highlighted (B), waiting on you (C), anything stopped (D). |
| **Spot checks** | Weekly `/debrief` picks 2 auto-merged PRs at random for you to look at. Automation makes it easy to lose touch with what's being changed (Bainbridge's "ironies of automation"); a small regular sample keeps you calibrated. |
| **No spending** | The scheduled run has no connectors attached, so it can't spend ElevenLabs credits or call paid APIs even by mistake. |

## 6. What remains risky after these nets

- **Taste drift:** a run of class B features, each fine on its own, can move the game somewhere you don't want. The highlighted digest and veto window are the only defence, so skim the digest weekly.
- **Shared blind spots:** checkers and builder are the same underlying model, so they can miss the same kind of bug. Escaped bugs found by you are tracked in `/debrief` so the checklists improve.
- **The classifier's gaps:** it catches what it has rules for. A harmful change that triggers no rule is class A. Its rules can only grow through class C changes, which you approve.
