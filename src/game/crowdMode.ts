import type { MapData } from '../map/types';
import type { CrowdStats, Sim } from '../sim/sim';
import type { CrowdSize } from '../sim/crowd';
import { mapFingerprint } from '../sim/campaign';
import { CrowdHud } from '../ui/crowdHud';
import { crowdBestKey, crowdBests } from '../ui/crowdBests';
import { el } from '../ui/dom';

/**
 * Spec 003: everything the browser game does differently on a crowd night, behind one object, so game.ts only
 * asks "is there a crowd?" at a few points. Render and UI only: nothing here feeds back into the sim.
 */

/** Big-kill radio calls for crowd nights: about zombies, the doors and dawn, never people (spec 003 pillar 5). Text only. */
export const CROWD_KILL_LINES: readonly ((n: number) => string)[] = [
  (n) => `${n} down. The doors say thank you.`,
  (n) => `Splash ${n}. Keep them off those doors.`,
  (n) => `${n} in one go. Dawn's getting closer.`,
  (n) => `That's ${n} that won't be knocking.`,
];

const SIZE_WORD: Record<CrowdSize, string> = { big: 'Big', huge: 'Huge' };
const GUN_WORDS: Record<string, string> = { '105': 'one 105', '40': 'one 40 mm round', '25': 'one 25 mm round' };

/** Real frame times, for the dev readout and info().frames. Median and the worst whole second. */
export class FrameStats {
  private times: number[] = [];
  private bins: number[] = [];
  private binT = 0;
  private binN = 0;
  add(ms: number): void {
    if (!(ms > 0) || ms > 1000) return;
    this.times.push(ms);
    if (this.times.length > 1800) this.times.shift();
    this.binT += ms;
    this.binN++;
    if (this.binT >= 1000) {
      this.bins.push((this.binN * 1000) / this.binT);
      if (this.bins.length > 120) this.bins.shift();
      this.binT = 0;
      this.binN = 0;
    }
  }
  get(): { medianFps: number; worst1sFps: number; maxFrameMs: number; frames: number } {
    const s = [...this.times].sort((a, b) => a - b);
    const med = s.length ? s[s.length >> 1] : 0;
    return {
      medianFps: med ? Math.round(10000 / med) / 10 : 0,
      worst1sFps: this.bins.length ? Math.round(Math.min(...this.bins) * 10) / 10 : 0,
      maxFrameMs: s.length ? Math.round(s[s.length - 1] * 10) / 10 : 0,
      frames: s.length,
    };
  }
}

export class CrowdMode {
  readonly hud: CrowdHud;
  readonly frames = new FrameStats();
  private fpsEl: HTMLDivElement | null = null;
  private fpsT = 0;

  constructor(parent: HTMLElement, private sim: Sim, showFps: boolean) {
    this.hud = new CrowdHud(parent);
    if (showFps) this.fpsEl = el('div', 'crowd-fps', '', parent);
  }

  get size(): CrowdSize {
    return this.sim.mission.crowd!.size;
  }

  impact(weapon: string, kills: number, x: number, z: number, now: number): void {
    this.hud.impact(weapon, kills, x, z, now);
  }

  /** Every frame: the real frame time (ms) for the stats, and the HUD. */
  frame(realMs: number, now: number, calm: boolean, screenOf: (x: number, z: number) => { x: number; y: number; visible: boolean }, s: CrowdStats): void {
    this.frames.add(realMs);
    this.hud.update(s, now, calm, screenOf);
    if (this.fpsEl && (this.fpsT -= realMs / 1000) <= 0) {
      this.fpsT = 0.5;
      const f = this.frames.get();
      this.fpsEl.textContent = `${f.medianFps} fps median · worst 1 s ${f.worst1sFps} · max ${f.maxFrameMs} ms`;
    }
  }

  /** The end card (feel: it leads with the people), then score, kills, best shot, best multiplier and the personal best. */
  /** `record`: false for bot, autoplay and practice runs, which never set a personal best. */
  endCard(card: HTMLElement, reason: string, map: MapData, record = true): void {
    const s = this.sim.state().crowd as CrowdStats;
    el('h2', undefined, reason, card);
    const list = el('ul', 'result-stats crowd-result', undefined, card);
    el('li', 'crowd-result-score', `Score ${s.score.toLocaleString('en-AU')}`, list);
    el('li', undefined, `Kills ${s.kills.toLocaleString('en-AU')}`, list);
    // The place is map text: textContent only (el() sets textContent).
    if (s.best) el('li', undefined, `Best shot: ${s.best.kills}, ${GUN_WORDS[s.best.weapon] ?? 'one round'}, ${s.best.place}`, list);
    el('li', undefined, `Best multiplier ×${s.bestMultiplier}`, list);
    el('li', undefined, `Crowd size ${SIZE_WORD[this.size]}`, list);
    const key = crowdBestKey(mapFingerprint(map), this.size);
    if (!record) {
      const b = crowdBests().get(key);
      el('p', 'best', b ? `Best on ${SIZE_WORD[this.size]}: ${b.score.toLocaleString('en-AU')} (this run isn't counted: autoplay)` : "This run isn't counted: autoplay", card);
    } else {
      const r = crowdBests().record(key, { score: s.score, kills: s.kills, shot: s.best?.kills ?? 0 });
      el('p', r.isNew ? 'best new-best' : 'best', r.isNew ? (r.previous ? `NEW BEST · was ${r.previous.score.toLocaleString('en-AU')}` : 'NEW BEST') : `Best on ${SIZE_WORD[this.size]}: ${r.previous!.score.toLocaleString('en-AU')}`, card);
    }
    // No silent downgrade mid-run: if it struggled, say so here, in words, and suggest the next size down.
    const f = this.frames.get();
    if (this.size === 'huge' && f.frames > 300 && (f.medianFps < 40 || f.worst1sFps < 24)) {
      el('p', 'small crowd-slow', 'That ran slowly on this device. Try Big next time: the same streets, fewer at once.', card);
    }
  }

  info(): { frames: ReturnType<FrameStats['get']>; size: CrowdSize } {
    return { frames: this.frames.get(), size: this.size };
  }

  dispose(): void {
    this.hud.dispose();
    this.fpsEl?.remove();
  }
}
