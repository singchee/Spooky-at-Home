import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('style.css', () => {
  it('has balanced braces and no leftover merge markers (a lost brace once swallowed the whole landing page style)', () => {
    const css = readFileSync('src/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(css).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
  });
});
