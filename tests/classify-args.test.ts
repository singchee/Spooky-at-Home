import { describe, it, expect } from 'vitest';
import { parseArgs } from '../tools/classify-change';

describe('classify-change parseArgs', () => {
  it('defaults to origin/main and HEAD', () => {
    expect(parseArgs([])).toEqual({ base: 'origin/main', head: 'HEAD' });
  });
  it('accepts a bare positional base', () => {
    expect(parseArgs(['origin/feat/x']).base).toBe('origin/feat/x');
  });
  it('accepts --base <ref> and --base=<ref>', () => {
    expect(parseArgs(['--base', 'origin/feat/phase-3']).base).toBe('origin/feat/phase-3');
    expect(parseArgs(['--base=origin/feat/phase-3']).base).toBe('origin/feat/phase-3');
  });
  it('accepts --head in both forms', () => {
    expect(parseArgs(['--head', 'feat/a'])).toEqual({ base: 'origin/main', head: 'feat/a' });
    expect(parseArgs(['--base=b', '--head=h'])).toEqual({ base: 'b', head: 'h' });
  });
  it('rejects missing values, unknown options, duplicates', () => {
    expect(() => parseArgs(['--base'])).toThrow(/needs a ref/);
    expect(() => parseArgs(['--base', '--head', 'x'])).toThrow(/needs a ref/);
    expect(() => parseArgs(['--base='])).toThrow(/non-empty/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
    expect(() => parseArgs(['a', 'b'])).toThrow(/too many/);
    expect(() => parseArgs(['a', '--base', 'b'])).toThrow(/once/);
  });
});
