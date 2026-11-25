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

  it('marks the safehouse clearly and steadily: 14 px or more, a solid outline, nothing animated (owner playtest 1)', () => {
    const css = readFileSync('src/style.css', 'utf8');
    const rules = [...css.matchAll(/(\.hud-safe[\w-]*(?:\s+polygon)?)\s*\{([^}]*)\}/g)].map((m) => ({ sel: m[1], body: m[2] }));
    const sel = (s: string) => rules.find((r) => r.sel === s)?.body ?? '';
    expect(Number(/font-size:\s*(\d+)px/.exec(sel('.hud-safe'))?.[1])).toBeGreaterThanOrEqual(16);
    expect(Number(/font-size:\s*(\d+)px/.exec(sel('.hud-safe-text'))?.[1])).toBeGreaterThanOrEqual(14);
    expect(sel('.hud-safe-outline polygon')).toMatch(/stroke-width:\s*[2-9]/);
    expect(sel('.hud-safe-outline polygon')).not.toMatch(/stroke-dasharray/); // solid
    expect(sel('.hud-safe-outline polygon')).toMatch(/fill:\s*none/); // never dims the reticle under it
    expect(sel('.hud-safe-arrow')).toMatch(/border-left:\s*\d+px solid/);
    for (const r of rules) expect(r.body, r.sel).not.toMatch(/animation|transition/);
    // Our own words only, by textContent: the HUD builds the outline with createElementNS, no innerHTML.
    const hud = readFileSync('src/ui/hud.ts', 'utf8');
    const fn = hud.slice(hud.indexOf('private safehouse('), hud.indexOf('private minimap'));
    expect(fn).toContain('createElementNS');
    expect(fn).not.toMatch(/innerHTML/);
  });
});
