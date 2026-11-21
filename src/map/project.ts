import type { V2 } from './types';

/**
 * Converts latitude/longitude to metres on a flat grid centred on `origin`.
 * A simple equirectangular approximation: error is well under 1% across the
 * ~1-2 km squares this game uses, which is invisible at gunship altitude.
 */
export interface LatLon {
  lat: number;
  lon: number;
}

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON_EQUATOR = 111320;

export function toLocal(origin: LatLon, lat: number, lon: number): V2 {
  const kx = M_PER_DEG_LON_EQUATOR * Math.cos((origin.lat * Math.PI) / 180);
  return { x: (lon - origin.lon) * kx, z: -(lat - origin.lat) * M_PER_DEG_LAT };
}

export function bboxAround(origin: LatLon, halfMetres: number): { south: number; west: number; north: number; east: number } {
  const dLat = halfMetres / M_PER_DEG_LAT;
  const dLon = halfMetres / (M_PER_DEG_LON_EQUATOR * Math.cos((origin.lat * Math.PI) / 180));
  return { south: origin.lat - dLat, west: origin.lon - dLon, north: origin.lat + dLat, east: origin.lon + dLon };
}
