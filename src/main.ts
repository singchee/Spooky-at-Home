import * as THREE from 'three';
import './style.css';
import { makeSampleTown } from './map/sample';
import type { MapData } from './map/types';
import { createSim } from './sim/setup';
import type { MissionType } from './sim/missions';
import { Game } from './game/game';
import { showMenu, type MenuChoice } from './ui/menu';
import { el } from './ui/dom';
import type { SensorId } from './render/sensors';

// Colours in this game are sensor values, not display colours: switch off colour conversion.
THREE.ColorManagement.enabled = false;

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
let game: Game | null = null;
let closeMenu: (() => void) | null = null;
let last: MenuChoice | null = null;

declare global {
  interface Window {
    __spooky?: { ready: boolean; state: () => unknown; info: () => unknown; setSensor: (s: SensorId) => void; error?: string };
  }
}
window.__spooky = { ready: false, state: () => game?.sim.state() ?? null, info: () => game?.info() ?? null, setSensor: (s) => game?.setSensor(s) };

function play(choice: MenuChoice, opts: { bot?: boolean; skipBriefing?: boolean; sensor?: SensorId } = {}): void {
  last = choice;
  closeMenu?.();
  closeMenu = null;
  game?.dispose();
  game = null;
  let r: ReturnType<typeof createSim>;
  try {
    r = createSim(choice.map, { type: choice.type, difficulty: choice.difficulty, seed: choice.seed });
  } catch (e) {
    r = { ok: false, reason: `Couldn't build a mission on this map (${(e as Error).message}).` };
  }
  if (!r.ok) {
    window.__spooky!.error = r.reason;
    menu(r.reason);
    return;
  }
  game = new Game(app, choice.map, r.sim, {
    ...opts,
    onRetry: () => play(choice, opts),
    onNext: () => play({ ...choice, seed: choice.seed + 1 }, opts),
    onMenu: () => menu(),
  });
  window.__spooky!.ready = true;
  window.__spooky!.error = undefined;
}

function menu(message?: string): void {
  game?.dispose();
  game = null;
  window.__spooky!.ready = false;
  closeMenu?.();
  const close = showMenu(app, (c) => play(c), last ?? undefined);
  let toast: HTMLDivElement | null = null;
  if (message) {
    toast = el('div', 'toast', message, app);
    setTimeout(() => toast?.remove(), 8000);
  }
  closeMenu = () => {
    close();
    toast?.remove();
  };
}

function clampInt(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && v !== null ? Math.max(lo, Math.min(hi, n)) : dflt;
}

// URL parameters let testers and the crew skip the menu, e.g.
// ?map=sample&type=escort&difficulty=2&seed=7&autostart=1&bot=1&sensor=night
if (params.get('autostart') === '1') {
  const map: MapData = makeSampleTown();
  play(
    {
      map,
      type: (['clear', 'escort', 'defend', 'auto'].includes(params.get('type') ?? '') ? params.get('type') : 'escort') as MissionType | 'auto',
      difficulty: clampInt(params.get('difficulty'), 1, 5, 2),
      seed: clampInt(params.get('seed'), 1, 1e9, 1),
    },
    { bot: params.get('bot') === '1', skipBriefing: params.get('brief') !== '1', sensor: params.get('sensor') === 'night' ? 'night' : undefined },
  );
} else {
  menu();
}
