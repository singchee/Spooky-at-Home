import { describe, expect, it } from 'vitest';
import { DEFAULT_ESTIMATE, KEEP_PER_HOST, estimateFor, estimateLine, forgetWaits, loadHistory, rangeText, recordWait, type LoadSample } from '../src/ui/loadEstimate';

// BACKLOG 3.26: "Usually about 1–3 min · 0:42 so far", from this device's own past waits.

const A = 'overpass-api.de';
const K = 'overpass.kumi.systems';
const s = (host: string, sec: number, i = 0): LoadSample => ({ host, waitMs: sec * 1000, at: 1_800_000_000_000 + i });

class MemStorage implements Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(k: string) { return this.data.get(k) ?? null; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  removeItem(k: string) { this.data.delete(k); }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

describe('estimate', () => {
  it('no history: the measured default, said as "usually about 1–3 min"', () => {
    expect(estimateFor([], A)).toEqual(DEFAULT_ESTIMATE);
    expect(estimateFor([s(A, 10), s(A, 12)], A)).toEqual(DEFAULT_ESTIMATE); // two loads aren't enough
    expect(estimateLine(DEFAULT_ESTIMATE, 42_000).text).toBe('Usually about 1–3 min · 0:42 so far');
  });

  it('per server: one server\'s history says nothing about the other', () => {
    const h = [s(A, 8), s(A, 12), s(A, 10), s(A, 9), s(K, 150), s(K, 170), s(K, 160)];
    const a = estimateFor(h, A);
    const k = estimateFor(h, K);
    expect(a.samples).toBe(4);
    expect(a.highMs).toBeLessThan(30_000);
    expect(k.lowMs).toBeGreaterThan(120_000);
    expect(rangeText(a)).toBe('5–20 s');
    expect(rangeText(k)).toBe('2–4 min');
    expect(estimateLine(a, 5_000).text).toBe('Usually about 5–20 s on this device (last 4 loads) · 0:05 so far');
  });

  it('one freak wait does not move it; old loads drop off', () => {
    const steady = [20, 22, 25, 21, 24, 23, 26, 22, 25].map((x, i) => s(A, x, i));
    const withFreak = [...steady, s(A, 600, 99)];
    expect(estimateFor(withFreak, A).highMs).toBeLessThan(40_000);
    const withQuick = [...steady, s(A, 0.5, 99)];
    expect(estimateFor(withQuick, A).lowMs).toBeGreaterThanOrEqual(20_000);
    // Only the last KEEP_PER_HOST count: ten slow loads after ten quick ones give a slow estimate.
    const shifted = [...Array.from({ length: 10 }, (_, i) => s(A, 5, i)), ...Array.from({ length: 10 }, (_, i) => s(A, 120, 50 + i))];
    expect(estimateFor(shifted, A).lowMs).toBe(120_000);
    // Nonsense is ignored.
    expect(estimateFor([s(A, NaN), s(A, -5), s(A, 10)], A)).toEqual(DEFAULT_ESTIMATE);
  });

  it('the bar fills toward the estimate but never past 90%; then "taking longer than usual"', () => {
    const e = DEFAULT_ESTIMATE;
    expect(estimateLine(e, 0).fraction).toBe(0);
    expect(estimateLine(e, 90_000).fraction).toBeCloseTo(0.45);
    expect(estimateLine(e, 179_000).fraction).toBeLessThanOrEqual(0.9);
    const over = estimateLine(e, 220_000);
    expect(over).toMatchObject({ over: true, fraction: 0.9, text: 'Taking longer than usual · 3:40 so far' });
    expect(over.spoken).toBe('Taking longer than usual: usually 1 to 3 minutes.');
    // Reduced motion: whole 10% steps.
    expect(estimateLine(e, 100_000, true).fraction).toBe(0.5);
    expect(estimateLine(e, 50_000, true).fraction).toBe(0.2);
    // Never a percentage on screen.
    expect(estimateLine(e, 90_000).text).not.toMatch(/%/);
    // The one clock on screen counts from pressing Scout; the maths uses the server wait.
    expect(estimateLine(e, 40_000, false, 42_000)).toMatchObject({ text: 'Usually about 1–3 min · 0:42 so far', fraction: 0.2 });
  });

  it('ranges read naturally, and screen readers hear them in words', () => {
    expect(rangeText({ lowMs: 12_000, highMs: 28_000, samples: 3 })).toBe('10–30 s');
    expect(rangeText({ lowMs: 45_000, highMs: 75_000, samples: 3 })).toBe('45 s–2 min');
    expect(rangeText({ lowMs: 60_000, highMs: 60_000, samples: 3 })).toBe('1–2 min');
    expect(estimateLine({ lowMs: 45_000, highMs: 75_000, samples: 5 }, 1_000).spoken).toBe('Usually about 45 seconds to 2 minutes on this device (last 5 loads).');
  });
});

describe('this device\'s history', () => {
  it('kept per server (last 10), read back, and forgotten by "Forget all saved places"', () => {
    const st = new MemStorage();
    for (let i = 0; i < 14; i++) recordWait(A, 1000 * (i + 1), i, st);
    recordWait(K, 90_000, 99, st);
    const h = loadHistory(st);
    expect(h.filter((x) => x.host === A).map((x) => x.waitMs)).toEqual(Array.from({ length: KEEP_PER_HOST }, (_, i) => 1000 * (i + 5)));
    expect(h.filter((x) => x.host === K)).toHaveLength(1);
    forgetWaits(st);
    expect(loadHistory(st)).toEqual([]);
  });

  it('never throws: blocked, full or garbled storage just means the default', () => {
    const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('denied'); } } as unknown as Storage;
    expect(() => recordWait(A, 1000, 0, blocked)).not.toThrow();
    expect(loadHistory(blocked)).toEqual([]);
    expect(() => forgetWaits(blocked)).not.toThrow();
    const odd = new MemStorage();
    odd.setItem('spooky-load-times', '{not json');
    expect(loadHistory(odd)).toEqual([]);
    odd.setItem('spooky-load-times', JSON.stringify([{ host: A, waitMs: 'x' }, null, s(A, 3)]));
    expect(loadHistory(odd)).toHaveLength(1);
    expect(loadHistory(null)).toEqual([]);
  });
});
