import type { OverpassJson } from '../map/overpass';

/**
 * Places remembered on this device (BACKLOG 3.12), so scouting the same place again is instant.
 *
 * After a successful download, the raw OpenStreetMap answer is kept in this browser (IndexedDB),
 * found again by a fingerprint of the words typed (never the words themselves) or by the place's
 * rounded coordinates. The name kept is the neighbourhood label, not an address. Entries
 * expire after 30 days, and only a few places are kept (least recently used go first).
 *
 * Privacy: saved places stay in this browser. Nothing here is ever sent anywhere or logged.
 * Every storage call is wrapped: if the browser refuses storage (a private window, full disk,
 * blocked site data) the game simply downloads the place as usual.
 */

/** A small async key-value store. IndexedDB in the browser; a fake in tests. */
export interface PlaceStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface PlaceCacheOptions {
  now?: () => number;
  maxPlaces?: number;
  maxBytes?: number;
  maxAgeMs?: number;
}

/** What is known about a saved place without loading its map. */
export interface SavedPlaceInfo {
  id: string;
  label: string;
  lat: number;
  lon: number;
  /** When it was downloaded (ms since 1970). */
  savedAt: number;
  /** When it was last loaded from this device; the least recently used is dropped first. */
  usedAt: number;
  /** Size of the stored map data, in bytes (as text). */
  bytes: number;
  /** Fingerprints (queryKey) of the searches that found it. The words typed are never stored. */
  queries: string[];
}

export interface SavedPlace extends SavedPlaceInfo {
  json: OverpassJson;
}

export const MAX_PLACES = 5;
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** Most searches a single place remembers (different spellings of the same place). */
const MAX_QUERIES = 8;

const INDEX_KEY = 'index';
const placeKey = (id: string) => `place:${id}`;

/** "  Gundagai,   NSW " and "gundagai, nsw" are the same search. */
export function normaliseQuery(q: string): string {
  return q
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,]+|[\s,.]+$/g, '');
}

/**
 * A fingerprint of a search, so a repeat search can be matched without keeping what was typed
 * (which may be a home address). 53-bit cyrb53 hash of the normalised text, as hex.
 */
export function queryKey(q: string): string {
  const str = normaliseQuery(q);
  if (!str) return '';
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `q${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)}`;
}

/** Coordinates rounded to 4 decimals (about 11 m): the same spot found twice gets the same id. */
export function placeId(lat: number, lon: number): string {
  const r = (v: number) => (Math.round(v * 1e4) / 1e4).toFixed(4);
  return `${r(lat)},${r(lon)}`;
}

/** "just now", "5 minutes ago", "3 days ago". */
export function timeAgo(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function validInfo(x: unknown): x is SavedPlaceInfo {
  const i = x as SavedPlaceInfo;
  return (
    !!i && typeof i === 'object' && typeof i.id === 'string' && typeof i.label === 'string' &&
    isNum(i.lat) && isNum(i.lon) && isNum(i.savedAt) && isNum(i.usedAt) && isNum(i.bytes) &&
    Array.isArray(i.queries) && i.queries.every((q) => typeof q === 'string')
  );
}

export class PlaceCache {
  private readonly now: () => number;
  private readonly maxPlaces: number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;

  constructor(private readonly store: PlaceStore | null, o: PlaceCacheOptions = {}) {
    this.now = o.now ?? Date.now;
    this.maxPlaces = o.maxPlaces ?? MAX_PLACES;
    this.maxBytes = o.maxBytes ?? MAX_BYTES;
    this.maxAgeMs = o.maxAgeMs ?? MAX_AGE_MS;
  }

  private async readIndex(): Promise<SavedPlaceInfo[]> {
    if (!this.store) return [];
    const raw = await this.store.get(INDEX_KEY);
    return Array.isArray(raw) ? raw.filter(validInfo) : [];
  }

  private async writeIndex(list: SavedPlaceInfo[]): Promise<void> {
    await this.store?.set(INDEX_KEY, list);
  }

  private expired(i: SavedPlaceInfo): boolean {
    const age = this.now() - i.savedAt;
    return age > this.maxAgeMs || age < -60_000; // a clock set far back can't keep a place forever
  }

  /** Every saved place that hasn't expired, most recently used first. Never throws. */
  async list(): Promise<SavedPlaceInfo[]> {
    try {
      return (await this.readIndex()).filter((i) => !this.expired(i)).sort((a, b) => b.usedAt - a.usedAt);
    } catch {
      return [];
    }
  }

  /** A saved place found by what was typed. Null if none, expired, unreadable, or storage is unavailable. */
  findByQuery(query: string): Promise<SavedPlace | null> {
    const q = queryKey(query);
    return q ? this.find((i) => i.queries.includes(q)) : Promise.resolve(null);
  }

  /**
   * A saved place at these coordinates (rounded to about 11 m). With `query`, that search is
   * remembered for the place too, so next time it is found without asking the geocoder.
   */
  findByCoords(lat: number, lon: number, query?: string): Promise<SavedPlace | null> {
    const id = placeId(lat, lon);
    return this.find((i) => i.id === id, query ? queryKey(query) : '');
  }

  private async find(match: (i: SavedPlaceInfo) => boolean, addQuery = ''): Promise<SavedPlace | null> {
    if (!this.store) return null;
    try {
      const index = await this.readIndex();
      const info = index.find(match);
      if (!info) return null;
      if (this.expired(info)) {
        await this.drop(info.id);
        return null;
      }
      const json = parseStored(await this.store.get(placeKey(info.id)));
      if (!json) {
        await this.drop(info.id); // corrupt or missing: forget it and download afresh
        return null;
      }
      const queries = addQuery && !info.queries.includes(addQuery) ? [addQuery, ...info.queries].slice(0, MAX_QUERIES) : info.queries;
      const used = { ...info, queries, usedAt: this.now() };
      // Bump it to most recently used. A search belongs to one place only.
      const rest = (i: SavedPlaceInfo) => (addQuery ? { ...i, queries: i.queries.filter((x) => x !== addQuery) } : i);
      await this.writeIndex(index.map((i) => (i.id === info.id ? used : rest(i)))).catch(() => undefined);
      return { ...used, json };
    } catch {
      return null;
    }
  }

  /**
   * Keeps a freshly downloaded place. Returns whether it was saved (false when storage is
   * unavailable or the place alone is bigger than the cap). Never throws.
   */
  async save(query: string, place: { lat: number; lon: number; label: string }, json: OverpassJson): Promise<boolean> {
    if (!this.store) return false;
    try {
      const text = JSON.stringify(json);
      if (text.length > this.maxBytes) return false;
      const id = placeId(place.lat, place.lon);
      const now = this.now();
      const index = await this.readIndex();
      const old = index.find((i) => i.id === id);
      const q = queryKey(query);
      const queries = [q, ...(old?.queries ?? []).filter((x) => x !== q)].filter(Boolean).slice(0, MAX_QUERIES);
      const info: SavedPlaceInfo = { id, label: place.label, lat: place.lat, lon: place.lon, savedAt: now, usedAt: now, bytes: text.length, queries };
      // A search now belongs to this place only.
      let next = [info, ...index.filter((i) => i.id !== id).map((i) => ({ ...i, queries: i.queries.filter((x) => x !== q) }))];
      const gone = next.filter((i) => this.expired(i));
      next = next.filter((i) => !this.expired(i)).sort((a, b) => (a.id === id ? -1 : b.id === id ? 1 : b.usedAt - a.usedAt));
      // Least recently used out, until within both caps (the new place is the most recent).
      while (next.length > this.maxPlaces || next.reduce((s, i) => s + i.bytes, 0) > this.maxBytes) gone.push(next.pop()!);
      await this.store.set(placeKey(id), text);
      await this.writeIndex(next);
      for (const g of gone) if (g.id !== id) await this.store.delete(placeKey(g.id)).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets one place. Returns whether storage accepted it. */
  async forget(id: string): Promise<boolean> {
    try {
      await this.drop(id);
      return true;
    } catch {
      return false;
    }
  }

  /** Forgets every saved place. */
  async forgetAll(): Promise<boolean> {
    if (!this.store) return true;
    try {
      await this.store.clear();
      return true;
    } catch {
      return false;
    }
  }

  private async drop(id: string): Promise<void> {
    if (!this.store) return;
    const index = await this.readIndex();
    await this.writeIndex(index.filter((i) => i.id !== id));
    await this.store.delete(placeKey(id));
  }
}

/** The stored text back to Overpass JSON, or null if it isn't a usable answer. */
function parseStored(v: unknown): OverpassJson | null {
  if (typeof v !== 'string') return null;
  try {
    const j = JSON.parse(v) as OverpassJson;
    return j && typeof j === 'object' && Array.isArray(j.elements) ? j : null;
  } catch {
    return null;
  }
}

// ---------- IndexedDB in the browser ----------

const DB_NAME = 'spooky-places';
const STORE = 'kv';
/** A browser that never answers (some locked-down profiles) must not hold up scouting. */
const IDB_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('storage timed out')), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

/** IndexedDB as a PlaceStore. Every call can reject; PlaceCache catches. */
export function indexedDbStore(idb: IDBFactory): PlaceStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= withTimeout(
      new Promise<IDBDatabase>((res, rej) => {
        const req = idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        req.onblocked = () => rej(new Error('storage blocked'));
      }),
      IDB_TIMEOUT_MS,
    ).catch((e) => {
      db = null; // try again next time
      throw e;
    }));
  const run = <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    withTimeout(
      open().then(
        (d) =>
          new Promise<T>((res, rej) => {
            const tx = d.transaction(STORE, mode);
            const req = f(tx.objectStore(STORE));
            tx.oncomplete = () => res(req.result);
            tx.onerror = () => rej(tx.error ?? req.error);
            tx.onabort = () => rej(tx.error ?? new Error('storage aborted'));
          }),
      ),
      IDB_TIMEOUT_MS,
    );
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)).then(() => undefined),
    delete: (k) => run('readwrite', (s) => s.delete(k)).then(() => undefined),
    clear: () => run('readwrite', (s) => s.clear()).then(() => undefined),
  };
}

let shared: PlaceCache | null = null;
/** The saved places in this browser (no saving at all when IndexedDB isn't available). */
export function placeCache(): PlaceCache {
  if (!shared) {
    let store: PlaceStore | null = null;
    try {
      if (typeof indexedDB !== 'undefined' && indexedDB) store = indexedDbStore(indexedDB);
    } catch {
      store = null; // touching indexedDB can throw when site data is blocked
    }
    shared = new PlaceCache(store);
  }
  return shared;
}
