import type { MapData } from '../map/types';
import type { RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import { MISSION_TEMPLATES, mapFeatures, templateAnchors, type TemplateId } from '../map/recon';
import { generateMission, type Mission, type MissionOptions, type MissionResult, type MissionType } from './missions';
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
/** Calls held back for each later night, so its own classic and a classic substitute always get a try. */
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
 * limit, the safehouse and home (to the metre) and how many people there are. Text isn't in it.
 */
export function missionFingerprint(m: Mission): string {
  const at = (p?: { x: number; z: number }) => (p ? [r1(p.x), r1(p.z)] : null);
  return fnv(
    JSON.stringify([m.type, m.template ?? '', m.anchor?.id ?? '', m.seed, m.difficulty, m.timeLimit, at(m.safehouse?.centre), at(m.home?.centre), m.survivors.length]),
  );
}

/** A short hash of the map's shape (never its name, which can hold a house number). */
export function mapFingerprint(map: MapData): string {
  const p = map.roads[0]?.pts[0];
  return fnv(JSON.stringify([map.half, map.buildings.length, map.roads.length, mapFeatures(map).length, p ? [r1(p.x), r1(p.z)] : null]));
}

/** Where a campaign is kept on the device: the campaign seed plus the map's shape (S alone isn't unique). */
export function placeKey(S: number, map: MapData): string {
  return `${S}:${mapFingerprint(map)}`;
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
    let found: NightPlan | null = null;
    let ownReason: string | null = null;
    let lastReason: string | null = null;
    search: for (const [template, substitute] of candidates) {
      const t = MISSION_TEMPLATES[template];
      const places: (string | undefined)[] = t.anchors.length
        ? templateAnchors(map, template, seed)
            .filter((f) => !usedAnchors.has(f.id))
            .slice(0, PLACES_PER_TEMPLATE)
            .map((f) => f.id)
        : [undefined];
      for (const anchor of places) {
        if (calls >= MAX_GENERATOR_CALLS - reserve) break search;
        const options: MissionOptions = { type: t.base, difficulty: d, seed, template, ...(anchor !== undefined ? { anchor } : {}) };
        calls++;
        const r = generate(map, g, grid, options);
        if (r.ok) {
          found = {
            night, level, difficulty: d, seed, template, substitute,
            ...(anchor !== undefined ? { anchorId: anchor } : {}),
            options, mission: r.mission, fp: missionFingerprint(r.mission), hadCold: hadCold(r.mission),
          };
          break search;
        }
        lastReason = r.reason;
        if (!t.anchors.length && t.base === NIGHT_BASE[night]) ownReason = r.reason;
      }
    }
    if (!found) {
      const reason = ownReason ?? lastReason ?? 'There is no room to plan a campaign on this map.';
      return { ok: false, S, level, night, reason, calls };
    }
    done.push(found);
  }
  return { ok: true, S, level, nights: done as [NightPlan, NightPlan, NightPlan], calls };
}
