import type { MapData, V2 } from './types';
import { dist } from './geom';
import { MinHeap } from '../util/heap';

/**
 * The road network as a graph: junctions and bends are nodes, road segments are edges.
 * Survivors follow it; the mission generator uses it to measure distances "by road".
 */
export interface Edge {
  to: number;
  w: number;
  road: number;
}

export interface RoadGraph {
  nodes: V2[];
  adj: Edge[][];
  /** Connected-piece id per node. */
  comp: Int32Array;
  /** Id of the largest connected piece (isolated fragments are common in real map data). */
  mainComp: number;
  mainCompShare: number;
}

export function buildRoadGraph(map: MapData): RoadGraph {
  const index = new Map<string, number>();
  const nodes: V2[] = [];
  const adj: Edge[][] = [];
  const nodeOf = (p: V2): number => {
    const k = `${Math.round(p.x * 2)},${Math.round(p.z * 2)}`; // join points within 0.5 m
    let i = index.get(k);
    if (i === undefined) {
      i = nodes.length;
      index.set(k, i);
      nodes.push({ x: p.x, z: p.z });
      adj.push([]);
    }
    return i;
  };
  map.roads.forEach((r, ri) => {
    for (let i = 1; i < r.pts.length; i++) {
      const a = nodeOf(r.pts[i - 1]);
      const b = nodeOf(r.pts[i]);
      if (a === b) continue;
      const w = dist(nodes[a], nodes[b]);
      adj[a].push({ to: b, w, road: ri });
      adj[b].push({ to: a, w, road: ri });
    }
  });

  const comp = new Int32Array(nodes.length).fill(-1);
  const sizes: number[] = [];
  for (let s = 0; s < nodes.length; s++) {
    if (comp[s] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const u = stack.pop()!;
      size++;
      for (const e of adj[u]) {
        if (comp[e.to] === -1) {
          comp[e.to] = id;
          stack.push(e.to);
        }
      }
    }
    sizes.push(size);
  }
  let mainComp = -1;
  let best = 0;
  sizes.forEach((sz, i) => {
    if (sz > best) {
      best = sz;
      mainComp = i;
    }
  });
  return { nodes, adj, comp, mainComp, mainCompShare: nodes.length ? best / nodes.length : 0 };
}

/** Nearest node on the main connected network, or -1 if none within maxDist. */
export function nearestNode(g: RoadGraph, p: V2, maxDist = Infinity): number {
  let best = -1;
  let bd = maxDist;
  for (let i = 0; i < g.nodes.length; i++) {
    if (g.comp[i] !== g.mainComp) continue;
    const d = dist(g.nodes[i], p);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/** Shortest road distance from `src` to every node. */
export function dijkstra(g: RoadGraph, src: number): { d: Float64Array; prev: Int32Array } {
  const d = new Float64Array(g.nodes.length).fill(Infinity);
  const prev = new Int32Array(g.nodes.length).fill(-1);
  const heap = new MinHeap();
  d[src] = 0;
  heap.push(src, 0);
  while (heap.size) {
    const u = heap.pop()!;
    for (const e of g.adj[u]) {
      const nd = d[u] + e.w;
      if (nd < d[e.to]) {
        d[e.to] = nd;
        prev[e.to] = u;
        heap.push(e.to, nd);
      }
    }
  }
  return { d, prev };
}

export function pathFromPrev(prev: Int32Array, target: number): number[] {
  const path: number[] = [];
  for (let u = target; u !== -1; u = prev[u]) path.push(u);
  return path.reverse();
}

/** Names of the roads a node path travels along, in order, without repeats. */
export function roadNamesAlong(g: RoadGraph, map: MapData, path: number[]): string[] {
  const names: string[] = [];
  for (let i = 1; i < path.length; i++) {
    const e = g.adj[path[i - 1]].find((x) => x.to === path[i]);
    const n = e ? map.roads[e.road].name : undefined;
    if (n && names[names.length - 1] !== n && !names.includes(n)) names.push(n);
  }
  return names;
}
