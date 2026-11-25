/**
 * Every word of the briefing walk-through ("Hello, home", BACKLOG 3.7), in one place so the story
 * writer can polish it without touching the camera code.
 *
 * Ground is talking to Spooky (the gunship). Darkly comic, never cruel, and always true (hard rule 9):
 * every number and name in a caption comes from the facts passed in, which come from the mission
 * itself (see tourStops in briefingTour.ts, and the checks in tests/briefingTour.test.ts). Jokes are
 * attitude, never facts. Keep lines short: each is on screen for about three seconds.
 *
 * Names come from OpenStreetMap and are untrusted: the view puts these strings on screen with
 * textContent only.
 */

/** Longest place name in a caption (longer OpenStreetMap names are cut with an ellipsis). */
export const NAME_MAX = 32;
export const clipName = (s: string): string => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s);

const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** 1500 → "1,500". */
export const thousands = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** A distance as said on the radio: 1000 → "1 km", 1500 → "1.5 km", 350 → "350 m". */
export const metres = (n: number): string => (n >= 1000 ? `${Number((n / 1000).toFixed(1))} km` : `${thousands(n)} m`);

/** Asides for a horde stop with nothing else to say. Attitude, not intel. */
const HORDE_ASIDES = ['Not here for the view.', 'Former neighbours, current problem.', 'Shambling, mostly.', 'They never did mow that lawn.'];
/** The cold-blooded line, varied so a long list of hordes doesn't read like a form. True per the intel (PLAN §5a). */
const COLD_LINES: ((n: number) => string)[] = [
  (n) => `${n} of them run cold: night vision finds those.`,
  (n) => `${n} cold-blooded, the same temperature as the grass.`,
  (n) => `${n} running cold. Thermal struggles; night vision doesn't.`,
];

export const TOUR_TEXT = {
  /** Establishing shot. `landmarks`: up to two public places in the model, most important first. */
  area: (f: { across: number; landmarks: string[] }): string => {
    const [a, b] = f.landmarks.map(clipName);
    if (a && b) return `Spooky, Ground. Tonight's patch: ${a}, ${b} and about ${thousands(f.across)} m of streets.`;
    if (a) return `Spooky, Ground. Tonight's patch: about ${thousands(f.across)} m of streets around ${a}.`;
    return `Spooky, Ground. Tonight's patch: about ${thousands(f.across)} m of streets. Lovely area. Shame about the neighbours.`;
  },
  /** Defend: the building to hold, and for how long ("3:45"). */
  safehouse: (f: { name: string; hold: string }): string => `${cap(clipName(f.name))} is the safehouse. Hold it for ${f.hold}. The dead know the address.`,
  /** Escort: where they're going. */
  home: (f: { street: string; need: number; n: number }): string => `Home: a house on ${clipName(f.street)}. Get at least ${f.need} of the ${f.n} through the door.`,
  /** Escort: where they start, and when they set off (seconds after the mission starts). */
  survivors: (f: { n: number; place: string; delay: number }): string => `${f.n} survivors holed up at ${clipName(f.place)}. They head out ${f.delay} s after you start.`,
  /** Clear: friendlies sheltering in place. */
  friendlies: (f: { n: number; place: string }): string => `${f.n} friendlies sheltering near ${clipName(f.place)}. Blue pin. Not a target.`,
  /** Defend: stragglers walking in. */
  stragglers: (f: { n: number; street: string }): string => `${f.n} stragglers walking in along ${clipName(f.street)}. Friendly, slow, not a target.`,
  /** One horde group (hordes at the same place share a stop, as they share a label). `k` picks the aside. */
  horde: (f: { hordes: number; count: number; cold: number; place: string; k: number }): string => {
    const what = f.hordes > 1 ? `${f.hordes} hordes at ${clipName(f.place)}, ${f.count} in all.` : `Horde of ${f.count} at ${clipName(f.place)}.`;
    if (f.cold) return `${what} ${COLD_LINES[f.k % COLD_LINES.length](f.cold)}`;
    return `${what} ${HORDE_ASIDES[f.k % HORDE_ASIDES.length]}`;
  },
  /**
   * Defend: one likely wave direction, with the places the sim names when a wave spawns there.
   * `first`: also say when the first wave comes (seconds after the start).
   */
  waves: (f: { compass: string; places: string[]; first: number | null }): string => {
    const where = f.places.length ? `, around ${list(f.places.map(clipName))}` : '';
    const when = f.first !== null ? ` First one ${f.first} s after you start.` : ' They never knock.';
    return `Waves come from the ${f.compass}${where}.${when}`;
  },
  /** Escort: the walk home, traced along the road. `via`: street names, in order. */
  route: (f: { length: number; via: string[] }): string =>
    `The walk home: about ${thousands(f.length)} m by road${f.via.length ? `, via ${list(f.via.map(clipName))}` : ''}. Ambushes form ahead of them.`,
  /** The gunship's orbit. `direction`: as seen from above. */
  orbit: (f: { place: string; direction: 'anticlockwise' | 'clockwise'; radius: number; altitude: number }): string =>
    `You orbit over ${clipName(f.place)}: ${f.direction}, ${metres(f.radius)} out, ${thousands(f.altitude)} m up. Ground out.`,

  /** Controls and their screen-reader names. */
  ui: {
    region: 'Walk-through of the mission area',
    skip: 'Skip tour',
    skipKeys: 'Space or Enter skips',
    replay: 'Replay tour',
    back: 'Back',
    next: 'Next',
    whole: 'Whole area',
    step: (i: number, n: number) => `${i} / ${n}`,
    listLabel: 'Stops on the walk-through',
  },
};
