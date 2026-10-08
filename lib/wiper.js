// Wiper motor mechanics (the load bank only models its current). A crank turns while the motor has
// power AND either the RUN relay is closed or the park switch is still open: the park circuit carries it
// to the park position before it stops, like a real wiper. SPEED picks the fast winding.
// Angle is the crank, 0..360°; the blade sweeps out on 0..180 and back on 180..360. Park = near 0°.
//
// park: 'ford' = Ford depressed (concealed) park, as on 1970s Ford two-speed motors: with RUN off the park
// switch reverses the armature, the motor runs BACKWARDS at low speed to 0°, and an eccentric on the crank
// lengthens the linkage so the blades drop below the cowl. The park switch only closes there (concealed).
// RUN on again runs it forward; the eccentric flips back and the blades rise into the normal sweep.

export const PARK_WINDOW_DEG = 12;

export const isParked = (angleDeg) => {
  const a = ((angleDeg % 360) + 360) % 360;
  return a < PARK_WINDOW_DEG || a > 360 - PARK_WINDOW_DEG;
};

/**
 * One step. `dtS` is vehicle (virtual) seconds since the last step.
 * @returns {{angleDeg:number, moving:boolean, park:boolean, concealed:boolean, dir:-1|0|1}}
 */
export function stepWiper(angleDeg, { powered, run, speed, dtS, slowRps = 0.7, fastRps = 1.2, park = 'standard', concealed = false }) {
  let a = ((angleDeg % 360) + 360) % 360;
  if (park === 'ford') return stepFord(a, { powered, run, speed, dtS, slowRps, fastRps, concealed });
  const parked = isParked(a);
  const moving = !!powered && (!!run || !parked) && dtS > 0;
  if (moving) {
    const next = a + 360 * (run && speed ? fastRps : slowRps) * dtS;
    // parking: the park switch closes in its window; the blade comes to rest at 0
    if (!run && (next >= 360 || isParked(next))) a = 0;
    else a = next % 360;
  }
  return { angleDeg: a, moving, park: isParked(a), concealed: false, dir: moving ? 1 : 0 };
}

function stepFord(a, { powered, run, speed, dtS, slowRps, fastRps, concealed }) {
  if (!powered || dtS <= 0) return { angleDeg: a, moving: false, park: concealed, concealed, dir: 0 };
  if (run) {
    a = (a + 360 * (speed ? fastRps : slowRps) * dtS) % 360;
    return { angleDeg: a, moving: true, park: false, concealed: false, dir: 1 };
  }
  if (concealed) return { angleDeg: a, moving: false, park: true, concealed: true, dir: 0 };
  // reverse at low speed until the crank comes back down to 0°: depressed park, switch closes
  const next = a - 360 * slowRps * dtS;
  if (next <= 0) return { angleDeg: 0, moving: true, park: true, concealed: true, dir: -1 };
  return { angleDeg: next, moving: true, park: false, concealed: false, dir: -1 };
}
