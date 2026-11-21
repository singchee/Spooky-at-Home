/** The three guns. Times in seconds, distances in metres, speeds in m/s. */
export interface WeaponDef {
  id: '25' | '40' | '105';
  name: string;
  /**
   * The gun camera's own lens (vertical field of view, degrees, at 1.8 km slant range), before zoom.
   * Tight enough that a person reads at 25-40 px on a 1080 px screen with the 25 and 40 (docs/STYLE.md).
   */
  fov: number;
  /** Minimum time between shots. */
  interval: number;
  magazine: number;
  reload: number;
  /** Shell speed: sets the delay between firing and impact. */
  speed: number;
  /** Lethal radius; up to 1.5x this, a hit kills half the time. */
  radius: number;
  /** Random miss distance (standard deviation) at the target. */
  spread: number;
  /** How much each blast washes out the night-vision picture (0-1). */
  washout: number;
}

export const WEAPONS: readonly WeaponDef[] = [
  { id: '25', name: '25 MM', fov: 1.6, interval: 1 / 12, magazine: 60, reload: 3, speed: 1100, radius: 3, spread: 1.2, washout: 0.012 },
  { id: '40', name: '40 MM', fov: 2.2, interval: 0.4, magazine: 8, reload: 3.5, speed: 900, radius: 7, spread: 2, washout: 0.06 },
  { id: '105', name: '105 MM', fov: 6, interval: 0, magazine: 1, reload: 4.5, speed: 500, radius: 16, spread: 3, washout: 0.35 },
];

/** A shell kills everything within `radius`, and half the time out to this multiple of it (Sim.updateShells). */
export const KILL_REACH = 1.5;
/** The farthest any shell can kill from where it lands (metres): the 105's lethal radius x KILL_REACH. */
export const MAX_KILL_REACH = Math.max(...WEAPONS.map((w) => w.radius * KILL_REACH));

export const weaponById = (id: string): WeaponDef => WEAPONS.find((w) => w.id === id) ?? WEAPONS[0];
