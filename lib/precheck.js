// Pre-check badge (docs/interfaces.md §4): what the firmware will make of the loads hung on one output.
// Mirrors functions/profet.cpp: inrush window = inrushTime ms from turn-on, inrush limit applies inside it,
// currentLimit after it; the sense reading saturates at 4095 counts.

/** Saturation current of a Profet sense channel: raw 4095 → 4095·3.3·kILIS/(1200·4095) A. */
export function saturationA(kILIS) {
  return (4095 * 3.3 * kILIS) / (1200 * 4095);
}

/** Firmware noise floor per Profet (docs/interfaces.md §2); interpolated by kILIS for unknown parts. */
export function noiseFloorA(kILIS) {
  if (kILIS >= 35000) return 1.0;
  if (kILIS >= 22950) return 0.5;
  return 0.2;
}

const f1 = (x) => (Math.round(x * 10) / 10).toString();

// Summed model current at time t (ms) across loads, each with its own tableMs.
function sumAt(loads, t) {
  let s = 0;
  for (const l of loads) {
    const k = Math.floor(t / (l.tableMs || 1));
    const tab = l.table ?? [];
    if (l.loopMs && tab.length) s += tab[k % tab.length];
    else s += k < tab.length ? tab[k] : l.steadyA;
  }
  return s;
}

/**
 * @param {object[]} loads  rendered bank load objects on this output (docs/interfaces.md §5)
 * @param {{currentLimit?:number, inrushCurrentLimit?:number, inrushTime?:number, openLoadLimit?:number,
 *          fOpenLoadLimit?:number, pwmEnabled?:boolean, enabled?:boolean}} outputConfig
 * @param {number} kILIS  22950 | 5950 | 35000
 * @returns {{level:'info'|'warn', text:string}[]}
 */
export function precheck(loads, outputConfig = {}, kILIS = 22950) {
  const out = [];
  const info = (text) => out.push({ level: 'info', text });
  const warn = (text) => out.push({ level: 'warn', text });
  if (!loads || loads.length === 0) return out;

  const sat = saturationA(kILIS);
  const limit = outputConfig.currentLimit ?? Infinity;
  const inrushLimit = outputConfig.inrushCurrentLimit ?? limit;
  const inrushTime = outputConfig.inrushTime ?? 0;
  const openFloor = outputConfig.openLoadLimit ?? outputConfig.fOpenLoadLimit ?? 0;

  // Horizon covers every table plus the end of the inrush window.
  const tableEnd = Math.max(...loads.map((l) => (l.table?.length ?? 0) * (l.tableMs || 1)));
  const step = Math.min(...loads.map((l) => l.tableMs || 1));
  let peak = 0;
  let peakInWindow = 0;
  let peakAfterWindow = 0;
  const horizon = Math.max(tableEnd, inrushTime) + step;
  for (let t = 0; t <= horizon; t += step) {
    const i = sumAt(loads, t);
    peak = Math.max(peak, i);
    if (t < inrushTime) peakInWindow = Math.max(peakInWindow, i);
    else peakAfterWindow = Math.max(peakAfterWindow, i);
  }
  const steady = loads.reduce((s, l) => s + (l.steadyA ?? 0), 0);
  const seen = (i) => Math.min(i, sat);                 // what the firmware can measure

  // Inrush window.
  if (inrushTime > 0) {
    if (inrushLimit > sat) {
      info(`inrush limit ${f1(inrushLimit)} A is above the ${f1(sat)} A sense saturation: it can never trip here; the steady limit does all the work after ${inrushTime} ms`);
    } else if (seen(peakInWindow) > inrushLimit) {
      warn(`predicted peak ${f1(peakInWindow)} A exceeds the inrush limit ${f1(inrushLimit)} A: trips at turn-on`);
    }
  }
  // Steady / after the inrush window.
  if (seen(steady) > limit) {
    warn(`steady ${f1(steady)} A exceeds the current limit ${f1(limit)} A`);
  } else if (seen(peakAfterWindow) > limit) {
    warn(`still ${f1(peakAfterWindow)} A after the ${inrushTime} ms inrush window, above the ${f1(limit)} A limit: trips once the window closes`);
  } else if (Number.isFinite(limit) && steady > 0.9 * limit) {
    info(`steady ${f1(steady)} A is within 10 % of the ${f1(limit)} A limit`);
  }
  // Saturation.
  if (steady > sat) warn(`steady ${f1(steady)} A is above the ${f1(sat)} A sense saturation: reads ${f1(sat)} A`);
  else if (peak > sat) info(`peak ${f1(peak)} A reads ${f1(sat)} A here (sense saturates), not ${f1(peak)} A`);
  // Open-load floor and firmware noise floor.
  if (openFloor > 0 && steady < openFloor) warn(`steady ${f1(steady)} A is below the open-load floor ${f1(openFloor)} A: reports OpenLoad`);
  const nf = noiseFloorA(kILIS);
  if (steady < nf) info(`steady ${steady.toFixed(2)} A is below the ${nf} A firmware noise floor: reads 0 A`);
  // PWM on something that cannot take it.
  if (outputConfig.pwmEnabled && loads.some((l) => l.pwm?.pwmable === false)) warn('PWM is enabled but a load on this output is not PWM-able');
  return out;
}
