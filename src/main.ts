import * as THREE from 'three';
import './style.css';
import { makeSampleTown } from './map/sample';
import type { MapData } from './map/types';
import { createSim } from './sim/setup';
import type { MissionType } from './sim/missions';
import { Game } from './game/game';
import { showMenu, type MenuChoice } from './ui/menu';
import { showLanding, type LandingChoice } from './ui/landing';
import { startTutorial, trainingDone, type TutorialHandle } from './ui/tutorial';
import { el } from './ui/dom';
import type { SensorId } from './render/sensors';

// Colours in this game are sensor values, not display colours: switch off colour conversion.
THREE.ColorManagement.enabled = false;

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
let game: Game | null = null;
let tutorial: TutorialHandle | null = null;
/** Closes whichever non-game screen is showing (landing page or menu). */
let closeScreen: (() => void) | null = null;
let last: MenuChoice | null = null;
type ScreenName = 'landing' | 'menu' | 'tutorial' | 'game';

declare global {
  interface Window {
    __spooky?: {
      ready: boolean;
      screen?: ScreenName;
      state: () => unknown;
      info: () => unknown;
      setSensor: (s: SensorId) => void;
      tutorialStep?: () => string | null;
      error?: string;
    };
  }
}
window.__spooky = {
  ready: false,
  state: () => game?.sim.state() ?? null,
  info: () => game?.info() ?? null,
  setSensor: (s) => game?.setSensor(s),
  tutorialStep: () => tutorial?.steps.step ?? null,
};

/** Tear down whatever is on screen (game, tutorial, landing or menu). */
function clear(): void {
  closeScreen?.();
  closeScreen = null;
  tutorial?.dispose();
  tutorial = null;
  game?.dispose();
  game = null;
  window.__spooky!.ready = false;
}

function play(choice: MenuChoice, opts: { bot?: boolean; skipBriefing?: boolean; sensor?: SensorId } = {}): void {
  last = choice;
  clear();
  let r: ReturnType<typeof createSim>;
  try {
    r = createSim(choice.map, { type: choice.type, difficulty: choice.difficulty, seed: choice.seed });
  } catch (e) {
    r = { ok: false, reason: `Couldn't build a mission on this map (${(e as Error).message}).` };
  }
  if (!r.ok) {
    window.__spooky!.error = r.reason;
    menu({ message: r.reason });
    return;
  }
  game = new Game(app, choice.map, r.sim, {
    ...opts,
    onRetry: () => play(choice, opts),
    onNext: () => play({ ...choice, seed: choice.seed + 1 }, opts),
    onMenu: () => menu(),
  });
  window.__spooky!.screen = 'game';
  window.__spooky!.ready = true;
  window.__spooky!.error = undefined;
}

function menu(o: { message?: string; focus?: 'address' | 'start'; sample?: boolean } = {}): void {
  clear();
  window.__spooky!.screen = 'menu';
  const preset = o.sample ? { ...(last ?? {}), map: makeSampleTown() } : last ?? undefined;
  const close = showMenu(app, (c) => play(c), preset);
  const back = el('button', 'menu-back', '← Front page', app);
  back.addEventListener('click', () => landing());
  let toast: HTMLDivElement | null = null;
  if (o.message) {
    toast = el('div', 'toast', o.message, app);
    setTimeout(() => toast?.remove(), 8000);
  }
  if (o.focus === 'address') app.querySelector<HTMLInputElement>('.menu input:not([type=file])')?.focus();
  if (o.focus === 'start') app.querySelector<HTMLButtonElement>('.menu button.primary')?.focus();
  closeScreen = () => {
    close();
    back.remove();
    toast?.remove();
  };
}

function landing(notice?: string): void {
  clear();
  window.__spooky!.screen = 'landing';
  closeScreen = showLanding(app, (c: LandingChoice) => {
    if (c === 'scout') menu({ focus: 'address' });
    else if (c === 'sample') menu({ focus: 'start', sample: true });
    else training();
  }, { notice, trained: trainingDone() });
}

function training(): void {
  clear();
  window.__spooky!.screen = 'tutorial';
  try {
    tutorial = startTutorial(app, (to) => {
      if (to === 'restart') training();
      else if (to === 'scout') menu({ focus: 'address' });
      else if (to === 'landing') landing('Training complete. Your street is next.');
      else menu({ sample: true, focus: 'start' });
    });
    game = tutorial.game;
    window.__spooky!.ready = true;
  } catch (e) {
    menu({ message: `Training night couldn't start (${(e as Error).message}).` });
  }
}

function clampInt(v: string | null, lo: number, hi: number, dflt: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && v !== null ? Math.max(lo, Math.min(hi, n)) : dflt;
}

// URL parameters let testers and the crew skip the menu, e.g.
// ?map=sample&type=escort&difficulty=2&seed=7&autostart=1&bot=1&sensor=night
// ?screen=landing|menu|tutorial opens that screen directly.
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
} else if (params.get('screen') === 'menu') {
  menu();
} else if (params.get('screen') === 'tutorial') {
  training();
} else {
  landing();
}
