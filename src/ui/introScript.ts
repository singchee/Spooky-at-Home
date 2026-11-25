/**
 * "The Late Bulletin" (docs/story/intro.md): the 44 s intro's script and timeline as plain data,
 * with no DOM or WebGL, so tests can hold it against the script. The player is src/ui/intro.ts.
 *
 * Every time is in seconds from the start of the intro. Caption text is exactly the spoken text.
 */

export type Speaker = 'PRUETT' | 'COMMANDER QUILL' | 'GROUND';
/** How a line is heard: from the TV's speaker, in the room, or over the radio. */
export type Voice = 'tv' | 'room' | 'radio';

export interface IntroLine {
  /** public/audio/voice/<id>.mp3 */
  id: string;
  speaker: Speaker;
  voice: Voice;
  text: string;
  start: number;
  /** Measured length of the recording (s). */
  length: number;
}

export const INTRO_LINES: readonly IntroLine[] = [
  { id: 'intro-news-1', speaker: 'PRUETT', voice: 'tv', text: 'Good evening. Reports tonight of the dead walking in suburbs across the city.', start: 0.6, length: 4.91 },
  { id: 'intro-news-2', speaker: 'PRUETT', voice: 'tv', text: "Stay indoors, lock your doors, and please don't approach them.", start: 5.8, length: 4.44 },
  { id: 'intro-news-3', speaker: 'PRUETT', voice: 'tv', text: 'The council confirms bin night goes ahead as normal. And now, the weather—', start: 10.5, length: 4.68 },
  { id: 'intro-cmd-1', speaker: 'COMMANDER QUILL', voice: 'room', text: "Right. That's enough news.", start: 15.6, length: 2.35 },
  { id: 'intro-cmd-2', speaker: 'COMMANDER QUILL', voice: 'room', text: "You're taking Spooky up tonight.", start: 18.3, length: 2.12 },
  { id: 'intro-cmd-3', speaker: 'COMMANDER QUILL', voice: 'room', text: 'Ground teams are out on the streets. Keep them safe, and get the survivors home.', start: 20.7, length: 4.91 },
  { id: 'intro-cmd-4', speaker: 'COMMANDER QUILL', voice: 'room', text: 'Three guns, small to very large. Mind the friendlies.', start: 25.9, length: 4.28 },
  { id: 'intro-cmd-5', speaker: 'COMMANDER QUILL', voice: 'room', text: 'Thermal finds the warm ones. Night vision finds the rest.', start: 30.5, length: 3.79 },
  { id: 'intro-cmd-6', speaker: 'COMMANDER QUILL', voice: 'room', text: 'Questions? Good. Ground will talk you in.', start: 34.6, length: 3.55 },
  { id: 'intro-ground', speaker: 'GROUND', voice: 'radio', text: "Spooky, Ground. Kettle's on. Let's get them home.", start: 38.7, length: 3.47 },
];

/** Captioned sound cues (shown in brackets). */
export const INTRO_CUES = [
  { text: '[TV muted]', start: 15.2, length: 0.4 },
  { text: '[radio click]', start: 38.4, length: 0.3 },
] as const;

/** The TV is muted here (Pruett is cut off on "weather—"). */
export const MUTE_AT = 15.2;
/** The radio squelch before Ground's line. */
export const SQUELCH_AT = 38.4;
/** The intro ends (dissolves into the front page). */
export const INTRO_END = 44;
/** A caption stays up this long after its line ends (unless the next one starts). */
export const CAPTION_HOLD = 0.6;

/** The five shots (docs/story/intro.md, shot list). */
export const SHOTS = [
  { id: 'bulletin', start: 0, end: 10.5 },
  { id: 'pullback', start: 10.5, end: 15.6 },
  { id: 'order', start: 15.6, end: 38.2 },
  { id: 'radio', start: 38.2, end: 42.2 },
  { id: 'title', start: 42.2, end: INTRO_END },
] as const;
export type ShotId = (typeof SHOTS)[number]['id'];

export const shotAt = (t: number): ShotId => (SHOTS.find((s) => t < s.end) ?? SHOTS[SHOTS.length - 1]).id;

/** Beats inside the shots (the picture follows the words). */
export const BEAT = {
  fadeUp: 0.8,
  /** The 5 s dolly back through the bezel. */
  dollyStart: 10.5,
  dollyEnd: 15.5,
  /** Quill raises the remote, then turns to the camera. */
  remoteUp: 14.6,
  turnStart: 15.9,
  turnEnd: 17.5,
  /** Line 6: the map table lights its friendly markers and safehouses. */
  markers: 21.2,
  /** Line 7: the three gun monitors light up, one after another. */
  guns: [26.3, 26.9, 27.5],
  /** Line 8: "Night vision finds the rest": the second feed crossfades to night vision over 1 s. */
  night: 32.4,
  nightFade: 1,
  /** Line 9: she puts the mug down. */
  mugDown: 35.6,
  /** Dissolve to the night sky. */
  sky: 38.2,
  dissolve: 0.8,
  /** Reduced motion: slides dissolve into each other over this long. */
  slideDissolve: 0.7,
  title: 42.2,
  fadeOut: 43.3,
} as const;

/** Every change on a screen is a crossfade at least this long (photosensitivity, docs/QUALITY.md). */
export const MIN_CROSSFADE = 0.5;

export const TICKER = [
  'STAY INDOORS',
  'LOCK YOUR DOORS',
  'DO NOT APPROACH',
  'BIN NIGHT GOES AHEAD AS NORMAL',
  'RESIDENTS\' COMMITTEE "DISAPPOINTED"',
] as const;
export const tickerText = (): string => `${TICKER.join(' · ')} · `;
/** The ticker never moves faster than this on screen (CSS px per second). */
export const TICKER_MAX_PX_S = 60;

export const LOWER_THIRD = { name: 'BARNABY PRUETT', place: 'LIVE: SUBURBS ACROSS THE CITY' } as const;
export const CHANNEL_BUG = 'LATE';

export interface Caption {
  speaker: Speaker | null;
  text: string;
}

/** Lines and cues in order: each caption shows from its start until it's done or the next one starts. */
export const CAPTIONS: readonly (Caption & { start: number; end: number })[] = (() => {
  const all = [
    ...INTRO_LINES.map((l) => ({ speaker: l.speaker as Speaker | null, text: l.text, start: l.start, end: l.start + l.length + CAPTION_HOLD })),
    ...INTRO_CUES.map((c) => ({ speaker: null, text: c.text as string, start: c.start, end: c.start + c.length + CAPTION_HOLD })),
  ].sort((a, b) => a.start - b.start);
  return all.map((c, i) => ({ ...c, end: Math.min(c.end, all[i + 1]?.start ?? INTRO_END) }));
})();

/** The caption on screen at time t (null: none). */
export function captionAt(t: number): Caption | null {
  const c = CAPTIONS.find((x) => t >= x.start && t < x.end);
  return c ? { speaker: c.speaker, text: c.text } : null;
}

/**
 * Reduced motion / reduce flicker: no camera moves. The intro becomes a slideshow of these key
 * frames (same audio, same captions), each dissolving into the next.
 */
export const SLIDES = [
  { id: 'bulletin', at: 0 },
  { id: 'room', at: BEAT.dollyStart },
  { id: 'quill', at: 15.6 },
  { id: 'mug', at: BEAT.mugDown },
  { id: 'sky', at: BEAT.sky },
] as const;
export type SlideId = (typeof SLIDES)[number]['id'];
export function slideAt(t: number): SlideId {
  let id: SlideId = SLIDES[0].id;
  for (const s of SLIDES) if (t >= s.at) id = s.id;
  return id;
}

/** Smooth 0..1 between a and b. */
export function ramp(t: number, a: number, b: number): number {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

/** Ease-out (decelerating) 0..1 between a and b: the dolly. */
export function easeOut(t: number, a: number, b: number): number {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return 1 - (1 - x) ** 3;
}

/** Is someone speaking at t (and who)? Drives the talking heads and the radio waveform. */
export function speakingAt(t: number): IntroLine | null {
  return INTRO_LINES.find((l) => t >= l.start && t < l.start + l.length) ?? null;
}

/** CSS matrix3d mapping a w×h box onto the quad p0 (top-left), p1 (top-right), p2 (bottom-right), p3 (bottom-left). */
export function quadMatrix(w: number, h: number, p: [number, number][]): string {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let g = 0;
  let hh = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den;
    hh = (dx1 * sy - sx * dy1) / den;
  }
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + hh * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + hh * y3;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, x0, y0, 0, 1];
  return `matrix3d(${m.map((v) => +v.toPrecision(9)).join(',')})`;
}
