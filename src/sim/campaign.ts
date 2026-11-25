import type { MapData } from '../map/types';
import type { RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import { MISSION_TEMPLATES, mapFeatures, templateAnchors, type TemplateId } from '../map/recon';
import { generateMission, type Mission, type MissionOptions, type MissionResult, type MissionType } from './missions';
import { rank, scoreInput, type Grade, type Score } from './score';
import type { SimState } from './sim';
import { hashString } from '../util/rng';

/**
 * Three Nights (spec 001, docs/story/campaign.md): three linked sorties over one map, clear → escort → hold,
 * each a little harder than the last. Pure and deterministic: no DOM, no storage, no clock. The same
 * map + campaign seed S + level B always plans the same three missions, so a replayed night is the
 * identical mission ("Same streets, same dead").
 */
export type Night = 1 | 2 | 3;
export const NIGHTS: readonly Night[] = [1, 2, 3];
/** Campaign difficulty: Gentle, Standard, Hard. */
export type Level = 1 | 2 | 3;
export const LEVELS: readonly Level[] = [1, 2, 3];

/** The mission type each night is built for. */
export const NIGHT_BASE: Record<Night, MissionType> = { 1: 'clear', 2: 'escort', 3: 'defend' };

/** Templates in order of preference (campaign.md §3). The last one is always the classic, which needs no place. */
export const NIGHT_PREFERENCES: Record<Night, readonly TemplateId[]> = {
  1: ['clear-tennis', 'clear-park', 'forest-sweep', 'classic-clear'],
  2: ['escort-shops', 'escort-station', 'classic-escort'],
  3: ['hold-sports', 'hold-landmark', 'classic-defend'],
};

/**
 * When none of a night's own templates can be built (campaign.md §5). Night two only ever falls back to
 * clear missions (two sheltering friendlies keep "people are still stuck out there" true); night three to
 * clears too (its lines never mention holding). An anchored template an earlier night already used is
 * skipped ("the unused clear templates"); classic templates need no place and are always allowed.
 */
export const NIGHT_SUBSTITUTES: Record<Night, readonly TemplateId[]> = {
  1: ['classic-escort', 'classic-defend'],
  2: ['forest-sweep', 'clear-park', 'clear-tennis', 'classic-clear'],
  3: ['classic-clear', 'clear-tennis', 'clear-park', 'forest-sweep'],
};

/** Places tried per anchored template before moving on. */
export const PLACES_PER_TEMPLATE = 3;
/** A whole plan never calls the mission generator more than this (spec 001 §5: pinned by a counter). */
export const MAX_GENERATOR_CALLS = 30;
/**
 * Calls held back for each later night, so its own classic and a classic substitute always get a try. Within
 * a night, once the calls left only cover its untried classic templates, its anchored ones are skipped.
 */
const RESERVE_PER_NIGHT = 2;

/** Night n runs at difficulty B + n − 1: it always rises and never passes 5. */
export function nightDifficulty(level: Level, night: Night): number {
  return Math.min(5, level + night - 1);
}

/** Night n's mission seed. B is not in it (campaign.md §2): the difficulty already is. */
export function nightSeed(S: number, night: Night): number {
  return hashString(`campaign|${S}|${night}`);
}

export interface NightPlan {
  night: Night;
  level: Level;
  difficulty: number;
  seed: number;
  /** The template the planner used (classic templates included, though their Mission has no `template`). */
  template: TemplateId;
  /** True when the night's own templates all failed and this is one of its substitutes. */
  substitute: boolean;
  /** The recon feature the mission is built around, for anchored templates. */
  anchorId?: string;
  /** Exactly what to pass to createSim / generateMission to fly (or replay) this night. */
  options: MissionOptions;
  mission: Mission;
  /** missionFingerprint(mission): detects a map that changed under a saved campaign. */
  fp: string;
  /** This night has cold-blooded contacts (for `first-cold`). */
  hadCold: boolean;
}

export type CampaignPlan =
  | { ok: true; S: number; level: Level; nights: [NightPlan, NightPlan, NightPlan]; calls: number }
  /** A campaign is three nights or none. `reason` is the generator's own words for the night that failed. */
  | { ok: false; S: number; level: Level; night: Night; reason: string; calls: number };

export type Generator = (map: MapData, g: RoadGraph, grid: WalkGrid, opts: MissionOptions) => MissionResult;

const fnv = (s: string) => hashString(s).toString(16).padStart(8, '0');
const r1 = (v: number) => Math.round(v);

/**
 * A short hash of what makes a mission the same mission: type, template, anchor, seed, difficulty, time
 * limit; where things are, to the metre (safehouse, home, every horde with its size and cold count, every
 * survivor's start); and the wave kinds in order. Text isn't in it.
 */
export function missionFingerprint(m: Mission): string {
  const at = (p?: { x: number; z: number }) => (p ? [r1(p.x), r1(p.z)] : null);
  return fnv(
    JSON.stringify([
      m.type, m.template ?? '', m.anchor?.id ?? '', m.seed, m.difficulty, m.timeLimit, at(m.safehouse?.centre), at(m.home?.centre),
      m.hordes.map((h) => [at(h.centre), h.count, h.cold]), m.survivors.map((v) => at(v.start)), m.waves?.kinds ?? null,
    ]),
  );
}

/** A short hash of the map's shape (never its name, which can hold a house number). */
export function mapFingerprint(map: MapData): string {
  const p = map.roads[0]?.pts[0];
  return fnv(JSON.stringify([map.half, map.buildings.length, map.roads.length, mapFeatures(map).length, p ? [r1(p.x), r1(p.z)] : null]));
}

/**
 * Where a campaign is kept on the device: the campaign seed plus the map's shape (S alone isn't unique).
 * S is hashed, so any seed (1e21, Infinity, a long typed number) gives a valid key.
 */
export function placeKey(S: number, map: MapData): string {
  return `${fnv(`seed|${String(S)}`)}:${mapFingerprint(map)}`;
}

/**
 * Rule 9: a night built around a place really happens there. An anchored clear has a horde labelled with
 * its place (for a forest sweep, one with cold-blooded zombies, as `forest-open` and the briefing say);
 * an anchored escort or hold uses the place itself as its safehouse. Classic templates have no place.
 */
export function placeIsTrue(template: TemplateId, m: Mission): boolean {
  const t = MISSION_TEMPLATES[template];
  if (!t.anchors.length) return true;
  const a = m.anchor;
  if (!a || m.type !== t.base) return false;
  if (t.base !== 'clear') return m.safehouse?.name === a.name;
  const here = m.hordes.filter((h) => h.label === a.name);
  return template === 'forest-sweep' ? here.some((h) => h.cold > 0) : here.length > 0;
}

export function hadCold(m: Mission): boolean {
  return m.hordes.some((h) => h.cold > 0) || (m.waves?.coldShare ?? 0) > 0;
}

/**
 * Resolves all three nights up front (campaign.md §5), or says why there's no campaign here.
 * For each night: its preference list, then its substitutes. An anchored template tries up to three of its
 * places, best first, skipping any place an earlier night used; a classic template needs none. The first
 * mission that builds is the night. At most MAX_GENERATOR_CALLS calls in all.
 */
export function planCampaign(
  map: MapData,
  g: RoadGraph,
  grid: WalkGrid,
  S: number,
  level: Level,
  opts: { generate?: Generator } = {},
): CampaignPlan {
  const generate = opts.generate ?? generateMission;
  let calls = 0;
  if (!LEVELS.includes(level)) return { ok: false, S, level, night: 1, reason: 'Pick Gentle, Standard or Hard.', calls };
  const done: NightPlan[] = [];
  for (const night of NIGHTS) {
    const d = nightDifficulty(level, night);
    const seed = nightSeed(S, night);
    const reserve = RESERVE_PER_NIGHT * (NIGHTS.length - night);
    const usedTemplates = new Set(done.map((x) => x.template));
    const usedAnchors = new Set(done.flatMap((x) => (x.anchorId ? [x.anchorId] : [])));
    const candidates: [TemplateId, boolean][] = [
      ...NIGHT_PREFERENCES[night].map((id): [TemplateId, boolean] => [id, false]),
      ...NIGHT_SUBSTITUTES[night]
        .filter((id) => !MISSION_TEMPLATES[id].anchors.length || !usedTemplates.has(id))
        .map((id): [TemplateId, boolean] => [id, true]),
    ];
    const attempts = candidates.flatMap(([template, substitute]) => {
      const t = MISSION_TEMPLATES[template];
      const places: (string | undefined)[] = t.anchors.length
        ? templateAnchors(map, template, seed)
            .filter((f) => !usedAnchors.has(f.id))
            .slice(0, PLACES_PER_TEMPLATE)
            .map((f) => f.id)
        : [undefined];
      return places.map((anchor) => ({ template, substitute, anchor }));
    });
    let found: NightPlan | null = null;
    let ownReason: string | null = null;
    let lastReason: string | null = null;
    for (let i = 0; i < attempts.length && !found; i++) {
      const { template, substitute, anchor } = attempts[i];
      const t = MISSION_TEMPLATES[template];
      const left = MAX_GENERATOR_CALLS - reserve - calls;
      if (left <= 0) break;
      // Never let places starve the night's classic templates (its own first): skip to them when the calls left only cover them.
      const classicsLeft = attempts.slice(i).filter((a) => a.anchor === undefined).length;
      if (anchor !== undefined && left <= classicsLeft) continue;
      const options: MissionOptions = { type: t.base, difficulty: d, seed, template, ...(anchor !== undefined ? { anchor } : {}) };
      calls++;
      const r = generate(map, g, grid, options);
      if (!r.ok) {
        lastReason = r.reason;
        if (!t.anchors.length && t.base === NIGHT_BASE[night]) ownReason = r.reason;
        continue;
      }
      if (!placeIsTrue(template, r.mission)) {
        lastReason = `The hordes can't gather at ${r.mission.anchor?.name ?? 'that place'} here, so "${t.name}" wouldn't be true.`;
        continue;
      }
      found = {
        night, level, difficulty: d, seed, template, substitute,
        ...(anchor !== undefined ? { anchorId: anchor } : {}),
        options, mission: r.mission, fp: missionFingerprint(r.mission), hadCold: hadCold(r.mission),
      };
    }
    if (!found) {
      const reason = ownReason ?? lastReason ?? 'There is no room to plan a campaign on this map.';
      return { ok: false, S, level, night, reason, calls };
    }
    done.push(found);
  }
  return { ok: true, S, level, nights: done as [NightPlan, NightPlan, NightPlan], calls };
}

// ---------------------------------------------------------------------------------------
// The record of a campaign: numbers only (spec 001 §2). Names for the text come from the
// re-planned nights, which are identical by determinism, so the device holds no street names.
// ---------------------------------------------------------------------------------------

/** What's kept from a won run. */
export interface RunNumbers {
  grade: Grade;
  /** Seconds the run took. */
  time: number;
  survivorsTotal: number;
  /** As scored: escort and defend, made it in; clear, still alive. */
  survivorsSaved: number;
  friendlyHits: number;
  kills: number;
  /** Defend: the safehouse, 0..1 (1 for other missions). */
  integrity: number;
}
export interface Run extends RunNumbers {
  won: boolean;
}
export interface NightRecord {
  /** missionFingerprint of the night these numbers belong to. */
  fp: string;
  /** Finished runs, won or lost. 0 = never flown (gates the night opener line). Leaving a night isn't a try. */
  tries: number;
  /** The best won run. Absent until the night is won. */
  best?: RunNumbers;
}
/** One campaign at one level on one map. */
export interface CampaignRecord {
  nights: [NightRecord | null, NightRecord | null, NightRecord | null];
}

export function emptyRecord(): CampaignRecord {
  return { nights: [null, null, null] };
}

/** The numbers of a finished run, as the grade saw them. */
export function runFrom(m: Mission, s: SimState, score: Score): Run {
  const i = scoreInput(m, s);
  return {
    won: s.phase === 'won', grade: score.grade, time: s.t, survivorsTotal: s.survivorsTotal, survivorsSaved: i.survivorsSaved,
    friendlyHits: s.friendlyHits, kills: s.kills, integrity: s.integrity,
  };
}

/** Is `a` a better run than `b`? A higher grade wins; on the same grade, a clearly faster time. A tie keeps the old run. */
export function betterRun(a: RunNumbers, b: RunNumbers | null | undefined): boolean {
  if (!b) return true;
  if (rank(a.grade) !== rank(b.grade)) return rank(a.grade) < rank(b.grade);
  return a.time < b.time - 0.5;
}

/** Night n can be flown: it's night one, or the night before it has been won. */
export function nightOpen(r: CampaignRecord, night: Night): boolean {
  return night === 1 || !!r.nights[night - 2]?.best;
}

/** The first night not yet won, or null when all three are. */
export function firstUnwon(r: CampaignRecord): Night | null {
  return NIGHTS.find((n) => !r.nights[n - 1]?.best) ?? null;
}

const numbers = (x: RunNumbers): RunNumbers => ({
  grade: x.grade, time: x.time, survivorsTotal: x.survivorsTotal, survivorsSaved: x.survivorsSaved,
  friendlyHits: x.friendlyHits, kills: x.kills, integrity: x.integrity,
});

/** The record with night n and every later night cleared. */
function resetFrom(r: CampaignRecord, night: Night): CampaignRecord {
  return { nights: r.nights.map((x, i) => (i >= night - 1 ? null : x)) as CampaignRecord['nights'] };
}

/**
 * Checks a saved record against the re-planned nights. A night whose fingerprint doesn't match (the map
 * changed since) is reset, with every night after it. `reset` names the first night reset, or null.
 */
export function reconcile(plan: readonly Pick<NightPlan, 'night' | 'fp'>[], r: CampaignRecord): { record: CampaignRecord; reset: Night | null } {
  for (const x of plan) {
    const saved = r.nights[x.night - 1];
    if (saved && saved.fp !== x.fp) return { record: resetFrom(r, x.night), reset: x.night };
  }
  return { record: r, reset: null };
}

/**
 * Records a finished run of night n (pure: returns a new record). Every finished run is a try; only a
 * won run can be the best, and a loss never removes a win. A night that isn't open records nothing.
 */
export function applyRun(r: CampaignRecord, night: Night, fp: string, run: Run): { record: CampaignRecord; isNewBest: boolean; previous: RunNumbers | null } {
  if (!nightOpen(r, night)) return { record: r, isNewBest: false, previous: r.nights[night - 1]?.best ?? null };
  const base = r.nights[night - 1] && r.nights[night - 1]!.fp !== fp ? resetFrom(r, night) : r;
  const was = base.nights[night - 1];
  const previous = was?.best ?? null;
  const isNewBest = run.won && betterRun(run, previous);
  const next: NightRecord = { fp, tries: (was?.tries ?? 0) + 1 };
  const best = isNewBest ? numbers(run) : previous;
  if (best) next.best = best;
  const nights = [...base.nights] as CampaignRecord['nights'];
  nights[night - 1] = next;
  return { record: { nights }, isNewBest, previous };
}
