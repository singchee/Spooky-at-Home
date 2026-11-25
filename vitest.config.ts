import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Builder agents keep their own copies of the repo under .claude/worktrees; never test those here.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**', 'maps/private/**', 'reports/**'],
    // Many tests play whole missions or build whole maps. With several builder teams sharing the machine
    // (load average 20+ on 4 cores) the 5 s default timed out tests whose assertions pass. A time limit is
    // not an assertion; speed budgets live in their own tests (e.g. sim.test.ts "budget (QUALITY §2)").
    testTimeout: 30_000,
  },
});
