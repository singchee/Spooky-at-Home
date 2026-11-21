import { describe, expect, it } from 'vitest';
import { classify, type ChangeFacts } from '../tools/classify-change';

const base: ChangeFacts = {
  branch: 'fix/escort-route', files: [{ status: 'M', path: 'src/game/missions.ts' }],
  depsBase: { three: '0.187.0' }, depsHead: { three: '0.187.0' },
  testCountBase: 10, testCountHead: 11, addedLines: ['+  const x = rng();'],
};
const run = (over: Partial<ChangeFacts>) => classify({ ...base, ...over }).cls;

describe('classify', () => {
  it('a bug fix with a new test is class A', () => expect(run({})).toBe('A'));
  it('a new feature is class B', () => expect(run({ branch: 'feat/night-vision' })).toBe('B'));
  it('touching the crew rules is class C', () => {
    expect(run({ files: [{ status: 'M', path: '.claude/skills/build/SKILL.md' }] })).toBe('C');
    expect(run({ files: [{ status: 'M', path: 'docs/AUTONOMY.md' }] })).toBe('C');
  });
  it('fewer tests, skipped tests or deleted test files are class C', () => {
    expect(run({ testCountHead: 9 })).toBe('C');
    expect(run({ addedLines: ['+  it.skip("flaky", () => {})'] })).toBe('C');
    expect(run({ files: [{ status: 'D', path: 'tests/old.test.ts' }] })).toBe('C');
  });
  it('dependency patch bump is B, new dependency or major bump is C', () => {
    expect(run({ depsHead: { three: '0.187.1' } })).toBe('B');
    expect(run({ depsHead: { three: '1.0.0' } })).toBe('C');
    expect(run({ depsHead: { three: '0.187.0', lodash: '4.0.0' } })).toBe('C');
  });
  it('a new external host is C; allowed map hosts are fine', () => {
    expect(run({ addedLines: ['+ fetch("https://tracker.example.com/x")'] })).toBe('C');
    expect(run({ addedLines: ['+ fetch("https://nominatim.openstreetmap.org/search")'] })).toBe('A');
  });
  it('possible secrets are C', () => {
    expect(run({ addedLines: ['+ const apiKey = "sk-abcdef1234567890"'] })).toBe('C');
  });
  it('docs-only changes are A', () => {
    expect(run({ branch: 'docs/typo', files: [{ status: 'M', path: 'README.md' }] })).toBe('A');
  });
});
