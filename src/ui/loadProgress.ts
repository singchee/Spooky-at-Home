import type { DownloadProgress } from '../map/overpass';

/**
 * The words and numbers of the scouting readout (BACKLOG 3.23), kept apart from the DOM so they
 * can be tested. Honest by rule: a percentage only when the server said how big the answer is
 * and the count still fits inside it; otherwise bytes so far.
 */

/** "640 KB", "2.4 MB" (decimal units, as download managers show them). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1e6) return `${Math.max(n > 0 ? 1 : 0, Math.round(n / 1e3))} KB`;
  return `${(n / 1e6).toFixed(n < 1e8 ? 1 : 0)} MB`;
}

/** A running clock: "0:07", "1:42", "12:03". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A finished duration: "0.4 s", "8 s", "1:42". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 1) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  return formatClock(ms);
}

/**
 * How far along, 0..1, or null when that can't honestly be known: no announced size, or more
 * bytes than announced (a zipped answer announces its zipped size).
 */
export function progressFraction(bytes: number, total: number | null): number | null {
  if (!total || total <= 0 || !Number.isFinite(total) || bytes > total || bytes < 0) return null;
  return bytes / total;
}

export type BarMode = 'waiting' | 'bytes' | 'determinate';

export interface Readout {
  /** The main line under the stages. */
  text: string;
  /** Which server, and why the game moved on if it did. */
  server: string;
  bar: BarMode;
  /** 0..1 when bar is 'determinate'. */
  fraction: number | null;
  /** A short sentence for screen readers (announced now and then, not on every chunk). */
  spoken: string;
}

export const WAITING_TEXT = "OpenStreetMap is preparing your area — this can take a minute or two when it's busy";

/** What to show for a download in progress, after `elapsedMs` on the clock. */
export function readout(p: DownloadProgress, elapsedMs: number, what = 'the map'): Readout {
  const server = p.movedOn ? `${cap(p.movedOn)}, so now asking ${p.host}` : `Asking ${p.host}`;
  const clock = spokenClock(elapsedMs);
  if (p.stage === 'waiting') {
    return { text: WAITING_TEXT, server, bar: 'waiting', fraction: null, spoken: `Waiting for OpenStreetMap to prepare ${what}, ${clock} so far.` };
  }
  const fraction = progressFraction(p.bytes, p.total);
  const text = fraction !== null ? `Downloading… ${formatBytes(p.bytes)} of ${formatBytes(p.total!)}` : `Downloading… ${formatBytes(p.bytes)}`;
  return {
    text,
    server: p.movedOn ? server : `${p.host} is answering`,
    bar: fraction !== null ? 'determinate' : 'bytes',
    fraction,
    spoken: fraction !== null ? `Downloading ${what}, ${Math.floor(fraction * 100)} percent.` : `Downloading ${what}, ${formatBytes(p.bytes).replace('MB', 'megabytes').replace('KB', 'kilobytes')} so far.`,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function spokenClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60);
  return `${m} minute${m === 1 ? '' : 's'} ${s % 60} seconds`;
}

/**
 * For live regions: true when it's time to speak again. A change of stage speaks at once;
 * otherwise at most once every `gapMs`, so a screen reader isn't read every chunk.
 */
export class SpeakThrottle {
  private lastAt = -Infinity;
  private lastKey = '';
  constructor(private readonly gapMs = 15_000) {}
  ready(key: string, nowMs: number): boolean {
    if (key !== this.lastKey || nowMs - this.lastAt >= this.gapMs) {
      this.lastKey = key;
      this.lastAt = nowMs;
      return true;
    }
    return false;
  }
}

/** Where the time went, for the owner (BACKLOG 3.22). */
export interface LoadTiming {
  totalMs: number;
  /** Waiting for OpenStreetMap to start answering. */
  serverMs: number;
  downloadMs: number;
  /** Reading the map and finding missions, on this device. */
  buildMs: number;
  host: string;
}

/** "Loaded in 1:42 (server 1:31, download 8 s, build 2 s) from overpass-api.de". */
export function timingLine(t: LoadTiming): string {
  return `Loaded in ${formatDuration(t.totalMs)} (server ${formatDuration(t.serverMs)}, download ${formatDuration(t.downloadMs)}, build ${formatDuration(t.buildMs)}) from ${t.host}`;
}
