// Battery node: V = Voc − Ri·ΣI; with the alternator running it regulates altV through its own,
// much lower source resistance.

export const BATTERY_DEFAULTS = { vocV: 12.6, riOhm: 0.015, altV: 14.2 };
export const ALT_RI_OHM = 0.002;      // regulated alternator output droops ~2 mV/A at the load
export const CRANK_A = 150;           // starter draw during crank, added to ΣI by the caller

/**
 * @param {number} voc     open-circuit battery voltage (V)
 * @param {number} riOhm   battery internal resistance (Ω)
 * @param {number} totalA  sum of all load currents (A), crank pulse included
 * @param {number} [altV]  alternator set point (V)
 * @param {boolean} [altOn] engine running
 * @returns {number} bus voltage (V), never below 0
 */
export function V(voc = BATTERY_DEFAULTS.vocV, riOhm = BATTERY_DEFAULTS.riOhm, totalA = 0, altV = BATTERY_DEFAULTS.altV, altOn = false) {
  const i = Math.max(0, totalA);
  const v = altOn ? altV - ALT_RI_OHM * i : voc - riOhm * i;
  return Math.max(0, v);
}
