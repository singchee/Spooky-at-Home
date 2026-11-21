/** The three guns. Times in seconds, distances in metres, speeds in m/s. */
export interface WeaponDef {
  id: '25' | '40' | '105';
  name: string;
  /** Camera field of view, degrees. */
  fov: number;
  /** Minimum time between shots. */
  interval: number;
  /** Rounds per magazine; Infinity means the gun never runs dry and never reloads (see isUnlimited). */
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
  // The 25 mm is belt-fed and unlimited (owner, 3.11: "60 25mm bullets is meanness").
  { id: '25', name: '25 MM', fov: 5, interval: 1 / 12, magazine: Infinity, reload: 0, speed: 1100, radius: 3, spread: 1.2, washout: 0.012 },
  { id: '40', name: '40 MM', fov: 10, interval: 0.4, magazine: 8, reload: 3.5, speed: 900, radius: 7, spread: 2, washout: 0.06 },
  { id: '105', name: '105 MM', fov: 22, interval: 0, magazine: 1, reload: 4.5, speed: 500, radius: 16, spread: 3, washout: 0.35 },
];

/** A shell kills everything within `radius`, and half the time out to this multiple of it (Sim.updateShells). */
export const KILL_REACH = 1.5;
/** The farthest any shell can kill from where it lands (metres): the 105's lethal radius x KILL_REACH. */
export const MAX_KILL_REACH = Math.max(...WEAPONS.map((w) => w.radius * KILL_REACH));

/** True for a gun with no magazine to empty: it only waits its firing interval between rounds. */
export const isUnlimited = (w: Pick<WeaponDef, 'magazine'>): boolean => !Number.isFinite(w.magazine);

export const weaponById = (id: string): WeaponDef => WEAPONS.find((w) => w.id === id) ?? WEAPONS[0];
