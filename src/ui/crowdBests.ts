import type { KeyValueStore } from './bests';

/**
 * Spec 003: personal bests on crowd nights, per map and crowd size (scores across sizes don't compare). Keyed by
 * the map's fingerprint, never a typed place name (the privacy rule, as in the campaign store). Stored only in
 * this browser; a missing, blocked or corrupt store is simply empty.
 */
export interface CrowdBest {
  score: number;
  kills: number;
  /** Biggest single round. */
  shot: number;
}

const KEY = 'spooky.crowdBests';
const MAX_ENTRIES = 100;

export const crowdBestKey = (mapFingerprint: string, size: string): string => `${mapFingerprint}|${size}`;

function valid(v: unknown): v is CrowdBest {
  const x = v as CrowdBest;
  return !!x && typeof x === 'object' && [x.score, x.kills, x.shot].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

export class CrowdBests {
  private cache: Record<string, CrowdBest> | null = null;
  constructor(private store: KeyValueStore | null) {}

  private load(): Record<string, CrowdBest> {
    if (this.cache) return this.cache;
    let raw: unknown = null;
    try {
      raw = JSON.parse(this.store?.getItem(KEY) ?? 'null');
    } catch {
      /* blocked or corrupt: start fresh */
    }
    const out: Record<string, CrowdBest> = {};
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (valid(v)) out[k] = { score: v.score, kills: v.kills, shot: v.shot };
    return (this.cache = out);
  }

  get(key: string): CrowdBest | null {
    return this.load()[key] ?? null;
  }

  /** A finished run (won or lost: either way you get a score). New best = a higher score. */
  record(key: string, r: CrowdBest): { isNew: boolean; previous: CrowdBest | null } {
    const all = this.load();
    const previous = all[key] ?? null;
    if (previous && r.score <= previous.score) return { isNew: false, previous };
    delete all[key];
    all[key] = { score: r.score, kills: r.kills, shot: r.shot };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[k];
    try {
      this.store?.setItem(KEY, JSON.stringify(all));
    } catch {
      /* full or blocked: keep it for this session */
    }
    return { isNew: true, previous };
  }
}

let shared: CrowdBests | null = null;
export function crowdBests(): CrowdBests {
  if (!shared) {
    let store: KeyValueStore | null = null;
    try {
      store = typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      store = null;
    }
    shared = new CrowdBests(store);
  }
  return shared;
}
