// Engine node: Off → Ign → Crank (1 s, 150 A battery dip) → Run. Pure: step() returns a new state.

export const IDLE_RPM = 800;
export const MAX_RPM = 6500;
export const CRANK_RPM = 200;
export const CRANK_MS = 1000;
export const CRANK_DIP_A = 150;
const RPM_TAU_MS = 300;          // throttle → RPM lag of a free-revving engine
const CLT_RUN_C = 95;            // thermostat-controlled running temperature
const CLT_FAN_C = 85;            // a running radiator fan pulls coolant down to this
const CLT_TAU_RUN_MS = 120000;   // warm-up from cold in a few minutes
const CLT_TAU_FAN_MS = 60000;
const CLT_TAU_OFF_MS = 900000;   // a hot block cools to ambient over tens of minutes

/** @typedef {{state:'off'|'ign'|'crank'|'run', throttle:number, rpm:number, cltC:number, oilBar:number,
 *             speedKph:number, gear:number, crankMs:number, fanOn:boolean, ambientC:number,
 *             batteryDipA:number, altOn:boolean}} EngineState */

/** @returns {EngineState} */
export function initialState(overrides = {}) {
  return {
    state: 'off', throttle: 0, rpm: 0, cltC: 20, oilBar: 0, speedKph: 0, gear: 0, crankMs: 0, fanOn: false,
    ambientC: 20, batteryDipA: 0, altOn: false, ...overrides,
  };
}

// First-order approach of x toward target over dt with time constant tau.
const approach = (x, target, dtMs, tauMs) => target + (x - target) * Math.exp(-dtMs / tauMs);

/** Oil pressure from RPM: ~1 bar at idle rising to ~5 bar by 4000 rpm (relief valve caps it). */
export function oilFromRpm(rpm) {
  if (rpm <= 0) return 0;
  return Math.min(5, 0.2 + rpm * 0.001);
}

/**
 * Advance the engine by dtMs.
 * @param {EngineState} state
 * @param {number} dtMs
 * @param {{state?:string, throttle?:number, speedKph?:number, gear?:number, fanOn?:boolean, ambientC?:number}} [inputs]
 * @returns {EngineState}
 */
export function step(state, dtMs, inputs = {}) {
  const s = { ...initialState(), ...state };
  if (inputs.throttle != null) s.throttle = Math.min(100, Math.max(0, inputs.throttle));
  if (inputs.speedKph != null) s.speedKph = Math.max(0, inputs.speedKph);
  if (inputs.gear != null) s.gear = inputs.gear;
  if (inputs.fanOn != null) s.fanOn = !!inputs.fanOn;
  if (inputs.ambientC != null) s.ambientC = inputs.ambientC;

  // State requests. Asking for 'run' from off/ign goes through crank first.
  const req = inputs.state;
  if (req && req !== s.state) {
    if (req === 'crank' || (req === 'run' && s.state !== 'crank')) { s.state = 'crank'; s.crankMs = 0; }
    else if (req === 'off' || req === 'ign') s.state = req;
  }
  if (s.state === 'crank') {
    s.crankMs += dtMs;
    if (s.crankMs >= CRANK_MS) { s.state = 'run'; s.crankMs = 0; }
  }

  // RPM.
  let rpmTarget = 0;
  if (s.state === 'crank') rpmTarget = CRANK_RPM;
  if (s.state === 'run') rpmTarget = IDLE_RPM + (s.throttle / 100) * (MAX_RPM - IDLE_RPM);
  s.rpm = s.state === 'crank' ? CRANK_RPM : approach(s.rpm, rpmTarget, dtMs, RPM_TAU_MS);
  if (s.rpm < 1) s.rpm = 0;

  // Coolant.
  if (s.state === 'run') {
    s.cltC = approach(s.cltC, CLT_RUN_C, dtMs, CLT_TAU_RUN_MS);
    if (s.fanOn && s.cltC > CLT_FAN_C) s.cltC = approach(s.cltC, CLT_FAN_C, dtMs, CLT_TAU_FAN_MS);
  } else {
    s.cltC = approach(s.cltC, s.ambientC, dtMs, CLT_TAU_OFF_MS);
  }

  s.oilBar = s.state === 'run' || s.state === 'crank' ? oilFromRpm(s.rpm) : 0;
  if (s.state !== 'run') s.speedKph = 0;           // the car does not move with the engine stopped
  s.batteryDipA = s.state === 'crank' ? CRANK_DIP_A : 0;
  s.altOn = s.state === 'run';
  return s;
}

/** DBC signal values for SimEngine.dbc (physical units). */
export function signals(state) {
  return {
    RPM: Math.round(state.rpm ?? 0),
    CLT: Math.round((state.cltC ?? 20) * 10) / 10,
    OilP: Math.round((state.oilBar ?? 0) * 100) / 100,
    TPS: state.state === 'off' ? 0 : state.throttle ?? 0,
    Speed: Math.round((state.speedKph ?? 0) * 10) / 10,
    Gear: state.gear ?? 0,
  };
}
