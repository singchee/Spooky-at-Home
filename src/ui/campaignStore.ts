import type { KeyValueStore } from './bests';
import {
  applyRun, emptyRecord, reconcile, type CampaignRecord, type Level, type Night, type NightPlan, type NightRecord, type Run, type RunNumbers,
} from '../sim/campaign';
import { GRADES } from '../sim/score';

/**
 * Three Nights progress, stored only in this browser (spec 001 §2 and §5). Never sent anywhere.
 * - Numbers only: per night `{ fp, tries, best? }`. No place or street names, no coordinates, no map.name;
 *   the text is rebuilt from the re-planned nights, which are identical by determinism.
 * - Keyed by place (`placeKey(S, map)`: the campaign seed plus the map's shape), then by difficulty: changing
 *   difficulty starts a separate campaign, and Forget clears every difficulty for the place.
 * - Every storage access is in try/catch. Blocked, full or corrupt storage never throws: progress is kept in
 *   memory for the session and `warning` says so.
 */
export const CAMPAIGN_KEY = 'spooky.campaign.v1';
const VERSION = 1;
/** Places kept at most; the least recently updated go first. */
export const MAX_PLACES = 20;
/** A stored value longer than this is not ours (or is broken): start fresh. */
const MAX_STORED_CHARS = 100_000;
export const NOT_KEPT = "This browser won't keep campaign progress.";

interface PlaceEntry {
  /** When this place was last written (ms since 1970), to trim the oldest. */
  updated: number;
  levels: Partial<Record<Level, CampaignRecord>>;
}

const PLACE_KEY = /^-?\d{1,16}:[0-9a-f]{8}$/;
const FP = /^[0-9a-f]{8}$/;
const BEST_KEYS = ['grade', 'time', 'survivorsTotal', 'survivorsSaved', 'friendlyHits', 'kills', 'integrity'] as const;
const NIGHT_KEYS = ['fp', 'tries', 'best'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const num = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

function validBest(b: unknown): b is RunNumbers {
  if (!isObj(b) || Object.keys(b).some((k) => !(BEST_KEYS as readonly string[]).includes(k))) return false;
  return (
    GRADES.includes(b.grade as never) && num(b.time, 86_400) && int(b.survivorsTotal, 1000) && int(b.survivorsSaved, 1000) &&
    (b.survivorsSaved as number) <= (b.survivorsTotal as number) && int(b.friendlyHits, 1000) && int(b.kills, 1_000_000) && num(b.integrity, 1)
  );
}

function validNight(n: unknown): n is NightRecord | null {
  if (n === null) return true;
  if (!isObj(n) || Object.keys(n).some((k) => !NIGHT_KEYS.includes(k))) return false;
  if (typeof n.fp !== 'string' || !FP.test(n.fp) || !int(n.tries, 1_000_000)) return false;
  return n.best === undefined || validBest(n.best);
}

function validRecord(r: unknown): r is CampaignRecord {
  return isObj(r) && Object.keys(r).length === 1 && Array.isArray(r.nights) && r.nights.length === 3 && r.nights.every(validNight);
}

function validPlace(p: unknown): p is PlaceEntry {
  if (!isObj(p) || !num(p.updated, Number.MAX_SAFE_INTEGER) || !isObj(p.levels)) return false;
  return Object.entries(p.levels).every(([k, r]) => ['1', '2', '3'].includes(k) && validRecord(r));
}

/** A deep copy with only the fields we keep, so nothing else can ride along into storage. */
function clean(r: CampaignRecord): CampaignRecord {
  return {
    nights: r.nights.map((n) => {
      if (!n) return null;
      const out: NightRecord = { fp: n.fp, tries: n.tries };
      if (n.best) out.best = Object.fromEntries(BEST_KEYS.map((k) => [k, n.best![k]])) as unknown as RunNumbers;
      return out;
    }) as CampaignRecord['nights'],
  };
}

export class CampaignStore {
  private cache: Record<string, PlaceEntry> | null = null;
  /** False once storage is missing or has refused a read or a write: progress is kept for this session only. */
  private persistent: boolean;

  constructor(
    private store: KeyValueStore | null,
    private now: () => number = () => Date.now(),
  ) {
    this.persistent = store !== null;
  }

  /** One line for the campaign screen when progress won't survive this session, else null. */
  get warning(): string | null {
    return this.persistent ? null : NOT_KEPT;
  }

  private load(): Record<string, PlaceEntry> {
    if (this.cache) return this.cache;
    let raw: unknown = null;
    try {
      const text = this.store?.getItem(CAMPAIGN_KEY) ?? null;
      if (text !== null && text.length <= MAX_STORED_CHARS) raw = JSON.parse(text);
    } catch (e) {
      // A corrupt value starts fresh; a read that throws means the browser won't keep anything.
      if (!(e instanceof SyntaxError)) this.persistent = false;
    }
    const out: Record<string, PlaceEntry> = {};
    if (isObj(raw) && raw.v === VERSION && isObj(raw.places)) {
      for (const [k, p] of Object.entries(raw.places)) {
        if (PLACE_KEY.test(k) && validPlace(p)) out[k] = { updated: p.updated, levels: Object.fromEntries(Object.entries(p.levels).map(([b, r]) => [b, clean(r!)])) };
      }
    }
    this.cache = out;
    return out;
  }

  private save(): void {
    const all = this.load();
    const keys = Object.keys(all).sort((a, b) => all[a].updated - all[b].updated);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PLACES))) delete all[k];
    try {
      this.store?.setItem(CAMPAIGN_KEY, JSON.stringify({ v: VERSION, places: all }));
    } catch {
      this.persistent = false; // storage full or blocked: keep it for this session
    }
  }

  /** The record for this place and difficulty (a copy); an empty one when there is none. */
  get(place: string, level: Level): CampaignRecord {
    const r = this.load()[place]?.levels[level];
    return r ? clean(r) : emptyRecord();
  }

  /** Difficulties with a record for this place (for "Continue Three Nights"). */
  levels(place: string): Level[] {
    const p = this.load()[place];
    return p ? ([1, 2, 3] as Level[]).filter((b) => p.levels[b]) : [];
  }

  put(place: string, level: Level, r: CampaignRecord): void {
    if (!PLACE_KEY.test(place)) return;
    const all = this.load();
    const entry = all[place] ?? { updated: 0, levels: {} };
    entry.levels[level] = clean(r);
    entry.updated = this.now();
    delete all[place]; // re-insert, so the newest come last
    all[place] = entry;
    this.save();
  }

  /**
   * Opens a campaign against its re-planned nights. A night whose fingerprint no longer matches (the map
   * changed) is reset with every night after it, and the reset is saved; `reset` names the first such night.
   */
  open(place: string, level: Level, nights: readonly Pick<NightPlan, 'night' | 'fp'>[]): { record: CampaignRecord; reset: Night | null } {
    const r = reconcile(nights, this.get(place, level));
    if (r.reset) this.put(place, level, r.record);
    return { record: clean(r.record), reset: r.reset };
  }

  /** Records a finished run of a night (see applyRun) and saves it. */
  record(place: string, level: Level, night: Night, fp: string, run: Run): ReturnType<typeof applyRun> {
    const before = this.get(place, level);
    const r = applyRun(before, night, fp, run);
    if (r.record !== before) this.put(place, level, r.record);
    return r;
  }

  /** "Forget this campaign": every difficulty for this place. */
  forget(place: string): void {
    const all = this.load();
    if (!(place in all)) return;
    delete all[place];
    this.save();
  }
}

function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage when it's blocked
  }
}

let shared: CampaignStore | null = null;
/** The campaign records for this browser. */
export function campaignStore(): CampaignStore {
  shared ??= new CampaignStore(browserStore());
  return shared;
}
