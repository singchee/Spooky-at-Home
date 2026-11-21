/**
 * The game's own map format. Everything is in metres on a flat local grid:
 * x = east, z = south (so north is -z, matching three.js conventions), origin at map centre.
 * Real OpenStreetMap data and the built-in sample town are both converted into this.
 */
export interface V2 {
  x: number;
  z: number;
}

export type AreaKind = 'park' | 'wood' | 'water';

export interface Building {
  id: string;
  pts: V2[];
  height: number;
  kind: string;
  name?: string;
}

export interface Road {
  id: string;
  pts: V2[];
  kind: string;
  width: number;
  name?: string;
}

export interface Area {
  id: string;
  pts: V2[];
  kind: AreaKind;
  name?: string;
}

export interface Poi {
  id: string;
  p: V2;
  kind: string;
  name?: string;
}

export interface MapData {
  name: string;
  /** Half the width of the playable square, in metres. */
  half: number;
  buildings: Building[];
  roads: Road[];
  areas: Area[];
  pois: Poi[];
  attribution: string;
  /**
   * Recon data (phase 2). Optional: maps saved before phase 2 don't have it, and the game
   * falls back to `pois` and `areas` (see `mapFeatures` in recon.ts).
   */
  features?: Feature[];
  busRoutes?: BusRoute[];
  /** Individually mapped trees (natural=tree). */
  trees?: V2[];
  /** Mapped street lamps (highway=street_lamp). */
  lamps?: V2[];
}

/**
 * Places the recon step and mission templates care about. A feature is a point (`p`, the
 * centre) and, when the map has its outline, the outline too (`pts`).
 * Child-focused categories (school, kindergarten, playground) are recorded for recon only;
 * missions never put children in the scene (PLAN §9 guardrails).
 */
export type FeatureCategory =
  | 'school'
  | 'kindergarten'
  | 'sports_centre'
  | 'stadium'
  | 'pitch'
  | 'tennis'
  | 'swimming_pool'
  | 'playground'
  | 'park'
  | 'forest'
  | 'supermarket'
  | 'mall'
  | 'parking'
  | 'hospital'
  | 'police'
  | 'fire_station'
  | 'train_station'
  | 'bus_station';

export const FEATURE_CATEGORIES: readonly FeatureCategory[] = [
  'school', 'kindergarten', 'sports_centre', 'stadium', 'pitch', 'tennis', 'swimming_pool', 'playground', 'park', 'forest',
  'supermarket', 'mall', 'parking', 'hospital', 'police', 'fire_station', 'train_station', 'bus_station',
];

export interface Feature {
  id: string;
  category: FeatureCategory;
  name?: string;
  p: V2;
  pts?: V2[];
}

/** A bus route, as the parts of its path that fall inside the map. */
export interface BusRoute {
  id: string;
  ref?: string;
  name?: string;
  lines: V2[][];
}

