import type { MapData } from '../map/types';
import { matchMissions, type MissionSuggestion } from '../map/recon';

/**
 * "Other suggestions" (BACKLOG 2.9): every mission this map allows, in the recon ranking order
 * (best first, with the same variety rule as the first three), shown a few at a time. Each click
 * moves on to the next set and wraps round at the end, so the same map and seed always cycle
 * through the same sets in the same order.
 */
export function rankedSuggestions(map: MapData, seed: number, accept?: (s: MissionSuggestion) => boolean): MissionSuggestion[] {
  return matchMissions(map, seed, { count: Infinity, accept });
}

/** How many different sets the list makes (the last one is topped up from the start). */
export function setCount(total: number, size = 3): number {
  return total <= size ? 1 : Math.ceil(total / size);
}

/**
 * Set number `page` (any integer; it wraps). With more than `size` suggestions, consecutive sets
 * never show the same missions in the same order, and every suggestion is shown once per cycle.
 */
export function suggestionSet<T>(list: readonly T[], page: number, size = 3): T[] {
  if (list.length <= size) return list.slice();
  const n = setCount(list.length, size);
  const p = ((page % n) + n) % n;
  return Array.from({ length: size }, (_, i) => list[(p * size + i) % list.length]);
}
