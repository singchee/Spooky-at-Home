import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Hard rules 1 and 2 (CLAUDE.md), checked on the source text: the simulation and the map pipeline
// run headless, so they never import three.js or touch the DOM, and mission logic never uses unseeded
// randomness or the clock. src/sim also never depends on the browser layers (spec 001 §1: `betterRun`
// lives in src/sim, not src/ui/bests.ts).

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(f) ? [p] : [];
  });
}

/** Source with comments removed, so a word like "window" in a comment doesn't count. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const importsOf = (src: string) => [...src.matchAll(/(?:import|export)[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);

const DOM = /\b(document|window|localStorage|sessionStorage|navigator|HTMLElement|requestAnimationFrame|AudioContext)\b/;

describe('layering (hard rules 1 and 2)', () => {
  const sim = files('src/sim');
  const map = files('src/map');

  it('src/sim and src/map import neither three nor the DOM nor use Math.random, and src/sim has no Date', () => {
    expect(sim.length).toBeGreaterThan(3);
    expect(map.length).toBeGreaterThan(3);
    for (const f of [...sim, ...map]) {
      const src = code(f);
      for (const m of importsOf(src)) {
        expect(m === 'three' || m.startsWith('three/'), `${f} imports ${m}`).toBe(false);
        expect(/(^|\/)(ui|game|render|world|audio)(\/|$)/.test(m), `${f} imports ${m} (a browser layer)`).toBe(false);
      }
      expect(DOM.exec(src)?.[0] ?? null, `${f} touches the DOM`).toBeNull();
    }
    for (const f of map) expect(/Math\.random\s*\(/.test(code(f)), `${f} uses Math.random`).toBe(false);
    for (const f of sim) {
      const src = code(f);
      expect(/Math\.random\s*\(/.test(src), `${f} uses Math.random`).toBe(false);
      expect(/\bDate\b/.test(src), `${f} reads the clock (Date)`).toBe(false);
      expect(/\bperformance\s*\.\s*now\b/.test(src), `${f} reads the clock (performance.now)`).toBe(false);
    }
  });

  it('src/map does not depend on src/sim', () => {
    for (const f of map) for (const m of importsOf(code(f))) expect(/(^|\/)sim(\/|$)/.test(m), `${f} imports ${m}`).toBe(false);
  });

  it('the scanner itself catches what it should (so a pass means something)', () => {
    expect(importsOf(`import * as THREE from 'three';\nimport { x } from '../ui/bests';`)).toEqual(['three', '../ui/bests']);
    expect(DOM.test(code('src/main.ts'))).toBe(true);
    expect(code('src/sim/missions.ts')).not.toMatch(/only planned inside this window/);
  });
});
