import { MUSIC, SFX, VOICE_LINES, voiceAsset } from './assets';
import type { ScoreMode } from './music';
import { BED_IDS, trackIds } from './recorded';

/**
 * The gun reports and the impact boom. Small files (about 270 kB together), heard on every shot.
 * Owner playtest 2: while they were still loading, the 40 mm played its thin generated stand-in (a
 * click) and its hit was nearly silent. They used to wait behind all 22 voice lines and the music,
 * about a minute on a slow machine, so they now load straight after the first radio line.
 */
export const GUN_IDS: readonly string[] = [SFX.fire25, SFX.fire40, SFX.fire105, SFX.explosion];

/**
 * The order the recorded files are asked for when sound starts, batch by batch: the radio squelch
 * and first line, the guns, the rest of the voice (a voice line has no stand-in, only its caption),
 * this screen's music, the alarm and the aircraft bed, then the stings.
 */
export function loadPlan(scene: ScoreMode): string[][] {
  return [
    [SFX.squelch, voiceAsset('cleared-hot')],
    [...GUN_IDS],
    VOICE_LINES.map(voiceAsset),
    trackIds(scene),
    [SFX.alarm, ...BED_IDS],
    [MUSIC.stingWin, MUSIC.stingLose],
  ];
}

/**
 * On a screen change, these batches jump the queue, in this order. Each jump goes to the front, so
 * the last batch ends up first: guns, then voice still waiting, then this screen's music.
 */
export function sceneJumps(scene: ScoreMode): string[][] {
  return [trackIds(scene), VOICE_LINES.map(voiceAsset), [...GUN_IDS]];
}
