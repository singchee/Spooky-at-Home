import { GRADES, rank, type Grade } from '../sim/score';

/**
 * Personal bests: the best grade (then fastest time) per map, mission and difficulty.
 * Stored only in this browser (localStorage, wrapped in try/catch). Never sent anywhere.
 */
export interface BestRecord {
  grade: Grade;
  /** Seconds. */
  time: number;
}

/** The bit of Storage this needs, so tests can pass a fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const KEY = 'spooky.bests';
/** Oldest entries are dropped beyond this, so the store can't grow without limit. */
const MAX_ENTRIES = 300;

/**
 * Which mission a best belongs to: a recon template built around a real place (e.g. 'forest-sweep'),
 * or the plain mission type. Classic templates ('classic-escort') are the plain type.
 */
export function missionKind(template: string | undefined, type: string): string {
  return template && !template.startsWith('classic-') ? template : type;
}

export function bestKey(mapName: string, kind: string, difficulty: number): string {
  return `${mapName}|${kind}|${difficulty}`;
}

/** Is `a` better than `b`? A higher grade wins; on the same grade, the faster time. */
export function isBetter(a: BestRecord, b: BestRecord | null): boolean {
  if (!b) return true;
  if (rank(a.grade) !== rank(b.grade)) return rank(a.grade) < rank(b.grade);
  return a.time < b.time - 0.5;
}

export function formatTime(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Best: A 3:12" */
export function formatBest(b: BestRecord): string {
  return `Best: ${b.grade} ${formatTime(b.time)}`;
}

function valid(r: unknown): r is BestRecord {
  const x = r as BestRecord;
  return !!x && typeof x === 'object' && GRADES.includes(x.grade) && typeof x.time === 'number' && Number.isFinite(x.time) && x.time >= 0;
}

export class Bests {
  private cache: Record<string, BestRecord> | null = null;
  constructor(private store: KeyValueStore | null) {}

  private load(): Record<string, BestRecord> {
    if (this.cache) return this.cache;
    let raw: unknown = null;
    try {
      raw = JSON.parse(this.store?.getItem(KEY) ?? 'null');
    } catch {
      /* blocked storage or a corrupt value: start fresh */
    }
    const out: Record<string, BestRecord> = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (valid(v)) out[k] = { grade: v.grade, time: v.time };
    }
    this.cache = out;
    return out;
  }

  get(key: string): BestRecord | null {
    return this.load()[key] ?? null;
  }

  /** Records a finished, won mission. Returns whether it is a new best, and the best before it. */
  record(key: string, r: BestRecord): { isNew: boolean; previous: BestRecord | null; best: BestRecord } {
    const all = this.load();
    const previous = all[key] ?? null;
    if (!isBetter(r, previous)) return { isNew: false, previous, best: previous! };
    delete all[key]; // re-insert so the newest entries come last (oldest are trimmed first)
    all[key] = { grade: r.grade, time: Math.round(r.time * 10) / 10 };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete all[k];
    try {
      this.store?.setItem(KEY, JSON.stringify(all));
    } catch {
      /* storage full or blocked: keep it for this session */
    }
    return { isNew: true, previous, best: all[key] };
  }
}

function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage when it's blocked
  }
}

let shared: Bests | null = null;
/** The bests for this browser. */
export function bests(): Bests {
  shared ??= new Bests(browserStore());
  return shared;
}
