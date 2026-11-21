---
name: fix-bug
description: Fix a bug in Spooky at Home with a strict reproduce-first loop. Use when the user reports a bug, a checker reports a finding, or a test fails unexpectedly.
---

# /fix-bug — reproduce, prove, fix, verify

**No fix without a reproduction.**

1. **Understand:** restate the bug as *steps → expected → actual*. If it came from the user and is ambiguous, ask one question.
2. **Reproduce:** write the smallest failing test that shows it, preferably a unit or headless-simulation test, or a Playwright step if it's visual. Run it and confirm it fails *for the stated reason*.
   - If you can't reproduce it, say so, report what you tried, and stop. Don't guess-fix.
3. **Find the cause:** explain in one or two sentences *why* it happens, not just where. Check whether the same cause appears elsewhere (`Grep`).
4. **Fix:** make the smallest change that removes the cause. Don't refactor nearby code in the same commit.
5. **Verify:** the new test passes, `npm run typecheck && npm test` is green, and the test fails again if you revert the fix (check this mentally or actually).
6. **Independent check:** launch the `code-reviewer` subagent on the fix diff.
7. Commit as `fix: <what the player saw>`, with the cause in the body. Report to the user: the cause, the fix, and the test that now guards it.
