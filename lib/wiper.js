// Wiper motor mechanics (the load bank only models its current). A crank turns while the motor has
// power AND either the RUN relay is closed or the park switch is still open: the park circuit carries it
// to the park position before it stops, like a real wiper. SPEED picks the fast winding.
// Angle is the crank, 0..360°; the blade sweeps out on 0..180 and back on 180..360. Park = near 0°.

export const PARK_WINDOW_DEG = 12;

export const isParked = (angleDeg) => {
  const a = ((angleDeg % 360) + 360) % 360;
  return a < PARK_WINDOW_DEG || a > 360 - PARK_WINDOW_DEG;
};

/**
 * One step. `dtS` is vehicle (virtual) seconds since the last step.
 * @returns {{angleDeg:number, moving:boolean, park:boolean}}
 */
export function stepWiper(angleDeg, { powered, run, speed, dtS, slowRps = 0.7, fastRps = 1.2 }) {
  let a = ((angleDeg % 360) + 360) % 360;
  const parked = isParked(a);
  const moving = !!powered && (!!run || !parked) && dtS > 0;
  if (moving) {
    const next = a + 360 * (run && speed ? fastRps : slowRps) * dtS;
    // parking: the park switch closes in its window; the blade comes to rest at 0
    if (!run && (next >= 360 || isParked(next))) a = 0;
    else a = next % 360;
  }
  return { angleDeg: a, moving, park: isParked(a) };
}
