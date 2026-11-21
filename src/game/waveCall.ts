import type { SimEvent } from '../sim/sim';

/** The radio call for a wave: names its kind and the place, and varies the wording call by call. */
export function waveCall(e: Extract<SimEvent, { type: 'wave' }>, n: number): string {
  const cold = e.cold ? `, ${e.cold} of them cold-blooded` : '';
  let lines: string[];
  switch (e.kind) {
    case 'rush':
      lines = [
        `Rushers! ${e.count} fast movers out of ${e.place}. They're lunging, not shambling.`,
        `Fast movers from the ${e.from}: ${e.count} sprinting in near ${e.place}.`,
        `Heads up, a rush: ${e.count} quick ones coming from ${e.place}.`,
      ];
      break;
    case 'cold':
      lines = [
        `Cold wave: ${e.count} from ${e.place}${cold}. Thermal will struggle; try night vision.`,
        `${e.count} coming from ${e.place}, and they're running cold: ${e.cold} won't glow on thermal.`,
        `Cold-blooded wave from the ${e.from}, near ${e.place}: ${e.count} contacts${cold}.`,
      ];
      break;
    case 'big':
      lines = [
        `Big one, Spooky: ${e.count} coming in from ${e.place}${cold}. Time for the 105.`,
        `That lull is over. Big wave from the ${e.from}: ${e.count} near ${e.place}${cold}.`,
        `Large group on the move near ${e.place}: ${e.count} contacts${cold}. Make every round count.`,
      ];
      break;
    default:
      lines = [
        `New contacts: ${e.count} coming in from ${e.place}${cold}.`,
        `${e.count} more heading your way from ${e.place}${cold}.`,
        `Movement near ${e.place}: ${e.count} contacts${cold}.`,
        `Here they come: ${e.count} from the ${e.from}, near ${e.place}${cold}.`,
      ];
  }
  return lines[n % lines.length];
}
