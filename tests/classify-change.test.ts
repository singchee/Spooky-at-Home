import { describe, expect, it } from 'vitest';
import { classify, type ChangeFacts } from '../tools/classify-change';

const base: ChangeFacts = {
  branch: 'fix/escort-route', files: [{ status: 'M', path: 'src/game/missions.ts' }],
  depsBase: { three: '0.187.0' }, depsHead: { three: '0.187.0' },
  testCountBase: 10, testCountHead: 11, addedLines: [{ path: 'src/game/missions.ts', text: 'const x = rng();' }],
};
const run = (over: Partial<ChangeFacts>) => classify({ ...base, ...over }).cls;
const add = (path: string, text: string) => ({ addedLines: [{ path, text }] });

describe('classify', () => {
  it('a bug fix with a new test is class A', () => expect(run({})).toBe('A'));
  it('a new feature is class B', () => expect(run({ branch: 'feat/night-vision' })).toBe('B'));
  it('touching the crew rules is class C', () => {
    expect(run({ files: [{ status: 'M', path: '.claude/skills/build/SKILL.md' }] })).toBe('C');
    expect(run({ files: [{ status: 'M', path: 'docs/AUTONOMY.md' }] })).toBe('C');
  });
  it('fewer tests, skipped tests or deleted test files are class C', () => {
    expect(run({ testCountHead: 9 })).toBe('C');
    expect(run(add('tests/foo.test.ts', 'it.skip("flaky", () => {})'))).toBe('C');
    expect(run({ files: [{ status: 'D', path: 'tests/old.test.ts' }] })).toBe('C');
  });
  it('dependency patch bump is B, new dependency or major bump is C', () => {
    expect(run({ depsHead: { three: '0.187.1' } })).toBe('B');
    expect(run({ depsHead: { three: '1.0.0' } })).toBe('C');
    expect(run({ depsHead: { three: '0.187.0', lodash: '4.0.0' } })).toBe('C');
  });
  it('a new external host is C; allowed map hosts are fine', () => {
    expect(run(add('src/net.ts', 'fetch("https://tracker.example.com/x")'))).toBe('C');
    expect(run(add('src/net.ts', 'fetch("https://nominatim.openstreetmap.org/search")'))).toBe('A');
    expect(run(add('docs/notes.md', 'see https://overpass-turbo.eu'))).toBe('A');
    expect(run(add('package-lock.json', '"resolved": "https://registry.npmjs.org/x"'))).toBe('A');
  });
  it('possible secrets are C', () => {
    expect(run(add('src/cfg.ts', 'const apiKey = "sk-abcdef1234567890"'))).toBe('C');
    expect(run(add('docs/setup.md', 'token: "abcdefgh12345678"'))).toBe('C');
  });
  it('Math.random in game code is at least B', () => {
    expect(run(add('src/game/x.ts', 'const r = Math.random();'))).toBe('B');
  });
  it('changing the classifier or its tests is C', () => {
    expect(run({ files: [{ status: 'M', path: 'tests/classify-change.test.ts' }] })).toBe('C');
  });
  it('docs-only changes are A', () => {
    expect(run({ branch: 'docs/typo', files: [{ status: 'M', path: 'README.md' }] })).toBe('A');
  });
});
