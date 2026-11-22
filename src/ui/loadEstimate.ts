import { formatClock } from './loadProgress';

/**
 * "Usually about 1–3 min · 0:42 so far" (BACKLOG 3.26): an honest estimate of how long
 * OpenStreetMap takes to start answering, shown while the server prepares the area.
 *
 * Based on this device's own past waits for each server (the last few successful map
 * downloads), kept in localStorage only: never sent anywhere, wrapped in try/catch, cleared by
 * "Forget all saved places". With too little history, a fixed default from measurements
 * (DEFAULT_ESTIMATE). Overpass's /api/status is not used: it reports free slots, not how long
 * the queue is, and kumi's status page itself took over a minute to answer when busy.
 */

export interface LoadSample {
  host: string;
  /** From asking that server to its first byte. */
  waitMs: number;
  /** When (ms since 1970). */
  at: number;
}

export interface Estimate {
  lowMs: number;
  highMs: number;
  /** How many of this device's past loads it's based on (0: the default). */
  samples: number;
}

/** Measured (BACKLOG 3.20–3.23): seconds when the servers are quiet, minutes when they're busy. */
export const DEFAULT_ESTIMATE: Estimate = { lowMs: 60_000, highMs: 180_000, samples: 0 };
/** Past loads kept per server. */
export const KEEP_PER_HOST = 10;
/** Fewer than this for a server: use the default. */
export const MIN_SAMPLES = 3;
/** One freak wait can't stretch the estimate past this. */
const MAX_SAMPLE_MS = 10 * 60_000;
const KEY = 'spooky-load-times';

/** Nearest-rank percentile of sorted values. */
function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/**
 * The likely range for `host`: the middle of this device's last waits for it (20th to 80th
 * percentile, so one freak wait in either direction doesn't move it), else the default.
 */
export function estimateFor(history: LoadSample[], host: string): Estimate {
  const waits = history
    .filter((s) => s.host === host && Number.isFinite(s.waitMs) && s.waitMs >= 0)
    .slice(-KEEP_PER_HOST)
    .map((s) => Math.min(s.waitMs, MAX_SAMPLE_MS))
    .sort((a, b) => a - b);
  if (waits.length < MIN_SAMPLES) return DEFAULT_ESTIMATE;
  const lowMs = pct(waits, 0.2);
  // A range, not a point: at least 10 s or half the low end wide.
  const highMs = Math.max(pct(waits, 0.8), lowMs + Math.max(10_000, lowMs / 2));
  return { lowMs, highMs, samples: waits.length };
}

const round = (ms: number, unit: number, f: (x: number) => number) => f(ms / unit) * unit;

/** The range as the player reads it: "10–30 s", "40 s–2 min", "1–3 min". */
export function rangeText(e: Estimate): string {
  const lo = e.lowMs < 60_000 ? round(e.lowMs, 5_000, Math.floor) : round(e.lowMs, 60_000, Math.floor);
  let hi = e.highMs < 60_000 ? round(e.highMs, 5_000, Math.ceil) : round(e.highMs, 60_000, Math.ceil);
  if (hi <= lo) hi = lo + (lo < 60_000 ? 5_000 : 60_000);
  const part = (ms: number) => (ms < 60_000 ? `${Math.max(0, ms / 1000)} s` : `${ms / 60_000} min`);
  if (lo < 60_000 && hi < 60_000) return `${lo / 1000}–${hi / 1000} s`;
  if (lo >= 60_000) return `${lo / 60_000}–${hi / 60_000} min`;
  return `${part(lo)}–${part(hi)}`;
}

export interface EstimateLine {
  text: string;
  /** How far the bar fills: toward the high end of the estimate, never past 0.9 while waiting. */
  fraction: number;
  over: boolean;
  spoken: string;
}

/** What to show after `waitedMs` of waiting, given the estimate. Steps of 10% when `steps`. */
export function estimateLine(e: Estimate, waitedMs: number, steps = false): EstimateLine {
  const over = waitedMs > e.highMs;
  let fraction = Math.min(0.9, (0.9 * Math.max(0, waitedMs)) / e.highMs);
  if (steps) fraction = Math.floor(fraction * 10) / 10;
  const so = `${formatClock(waitedMs)} so far`;
  const range = rangeText(e);
  const where = e.samples ? ` on this device (last ${e.samples} loads)` : '';
  const said = range.replace('–', ' to ').replace(/ s\b/g, ' seconds').replace(/ min\b/g, ' minutes');
  return over
    ? { text: `Taking longer than usual · ${so}`, fraction: 0.9, over, spoken: `Taking longer than usual: usually ${said}${where}.` }
    : { text: `Usually about ${range}${where} · ${so}`, fraction, over, spoken: `Usually about ${said}${where}.` };
}

// ---------- this device's history (localStorage only) ----------

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // touching localStorage throws when site data is blocked
  }
}

/** The past waits kept on this device. Never throws; empty when storage is unavailable or odd. */
export function loadHistory(s: Storage | null = store()): LoadSample[] {
  try {
    const raw = JSON.parse(s?.getItem(KEY) ?? '[]');
    return Array.isArray(raw)
      ? raw.filter((x): x is LoadSample => !!x && typeof x.host === 'string' && Number.isFinite(x.waitMs) && Number.isFinite(x.at))
      : [];
  } catch {
    return [];
  }
}

/** Remembers one successful wait (the last KEEP_PER_HOST per server). Never throws. */
export function recordWait(host: string, waitMs: number, at = Date.now(), s: Storage | null = store()): void {
  if (!s || !Number.isFinite(waitMs) || waitMs < 0) return;
  try {
    const all = [...loadHistory(s), { host, waitMs: Math.round(waitMs), at }];
    const kept = all.filter((x, i) => all.slice(i + 1).filter((y) => y.host === x.host).length < KEEP_PER_HOST);
    s.setItem(KEY, JSON.stringify(kept.slice(-4 * KEEP_PER_HOST)));
  } catch {
    // full or blocked: the estimate just stays on the default
  }
}

/** "Forget all saved places" forgets these too. Never throws. */
export function forgetWaits(s: Storage | null = store()): void {
  try {
    s?.removeItem(KEY);
  } catch {
    // nothing to do
  }
}
