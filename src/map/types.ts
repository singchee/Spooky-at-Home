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
}
