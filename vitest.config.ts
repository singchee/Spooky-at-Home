import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Builder agents keep their own copies of the repo under .claude/worktrees; never test those here.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
