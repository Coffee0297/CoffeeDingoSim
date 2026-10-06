// ProfetLoadBank smoke test: starts its own headless Renode (monitor :1298, bank :7899), includes
// renode/test/bank_compile.resc, plays a 55 W halogen on out1 and checks the model, the ADC feed,
// DSEL re-feed, PWM on-phase scaling, faults, vbatt and the wake pulse. Kills only the Renode it started.
//   node renode/test/bank_probe.mjs            (from the CoffeeDingoSim root)
// Env: RENODE / RENODE_EXE (executable), RENODE_DIR, MON_PORT (1298), BANK_PORT (7899), KEEP=1 (leave Renode running)
// Without RENODE / RENODE_EXE the executable is located like the server does it (RENODE_DIR, else cache/renode,
// downloaded there on first use on Windows).
import net from 'node:net'
import { spawn } from 'node:child_process'
import { ensureRenode } from '../../server/renode.js'

const RENODE = process.env.RENODE ?? await ensureRenode()
const MON = Number(process.env.MON_PORT ?? 1298)
const BANK = Number(process.env.BANK_PORT ?? 7899)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\xff[\xfb-\xfe]./gs, '').replace(/\r/g, '')

let failures = 0
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}

// ---- Renode ------------------------------------------------------------------------------------
const renode = spawn(RENODE, ['--disable-gui', '--plain', '-P', String(MON)], { cwd: process.cwd(), windowsHide: true })
console.log(`renode pid ${renode.pid}`)
let log = ''
renode.stdout.on('data', (d) => { log += d.toString() })
renode.stderr.on('data', (d) => { log += d.toString() })
const done = (code) => {
  if (!process.env.KEEP) { try { process.kill(renode.pid) } catch {} }
  process.exit(code)
}
for (let i = 0; i < 60 && !log.includes('Monitor available'); i++) await sleep(500)
if (!log.includes('Monitor available')) { console.error('renode did not come up\n' + log); done(2) }

// ---- monitor -----------------------------------------------------------------------------------
const mon = net.connect(MON, '127.0.0.1')
let mbuf = ''
mon.on('data', (d) => { mbuf += d.toString('latin1') })
mon.on('error', () => {})
await new Promise((r) => mon.once('connect', r))
await sleep(500)
async function cmd (c, timeout = 30000) {
  mbuf = ''
  mon.write(c + '\n')
  const t0 = Date.now()
  // reply is complete when a fresh prompt "(name) " ends the buffer
  while (Date.now() - t0 < timeout) {
    await sleep(20)
    const s = strip(mbuf)
    if (/\([\w-]+\) $/.test(s) && s.split('\n').length > 1) break
  }
  const out = strip(mbuf).split('\n').slice(1, -1).join('\n').trim()
  return out
}
const num = (s) => {
  const h = s.match(/0x[0-9a-f]+/i)
  return h ? Number(h[0]) : Number((s.match(/-?[0-9]+(\.[0-9]+)?(E[-+]?[0-9]+)?/i) ?? ['NaN'])[0])
}

const inc = await cmd('include @renode/test/bank_compile.resc', 120000)
if (/error/i.test(inc)) { console.error(inc); done(2) }
check(log.includes('ProfetLoadBank: NDJSON on 127.0.0.1:' + BANK), 'model compiled, bank listening', `:${BANK}`)

// ---- bank NDJSON client --------------------------------------------------------------------------
const msgs = []
const bank = net.connect(BANK, '127.0.0.1')
let bbuf = ''
bank.on('data', (d) => {
  bbuf += d.toString('utf8')
  let k
  while ((k = bbuf.indexOf('\n')) >= 0) {
    const line = bbuf.slice(0, k); bbuf = bbuf.slice(k + 1)
    if (line.trim()) msgs.push(JSON.parse(line))
  }
})
bank.on('error', () => {})
await new Promise((r) => bank.once('connect', r))
const send = (o) => bank.write(JSON.stringify(o) + '\n')
await sleep(300)
const hello = msgs.find((m) => m.type === 'hello')
check(hello?.machine === 'BANKTEST' && hello.board === 'pdm' && hello.outputs === 8, 'hello on connect', JSON.stringify(hello))
send({ type: 'list' })
await sleep(200)
check(msgs.some((m) => m.type === 'machines' && m.items.some((x) => x.machine === 'BANKTEST')), 'list -> machines')

// 55 W halogen: cold filament ~10x steady, tau ~25 ms; steady 3.99 A at 13.8 V; table 1 ms x 300
const table = Array.from({ length: 300 }, (_, k) => +(3.99 + 36 * Math.exp(-k / 25)).toFixed(3))
const halogen = { id: 'h1', ratedA: 3.99, vExp: 0.55, tableMs: 1, table, steadyA: 3.99, coolDownMs: 1500,
  ripple: { hz: 0, pct: 0 }, stallA: 0, shortA: 999, pwm: { onPhaseExp: 0.45 }, fault: null }
send({ type: 'scene', machine: 'BANKTEST', vbattV: 13.8, noisePct: 0, outputs: {
  1: { loads: [halogen] },
  3: { loads: [{ id: 'a', steadyA: 2.0, vExp: 0 }] },
  4: { loads: [{ id: 'b', steadyA: 5.0, vExp: 0 }] } } })
await sleep(200)
check(!msgs.some((m) => m.type === 'error'), 'scene accepted', JSON.stringify(msgs.filter((m) => m.type === 'error')))

// ---- inrush on out1 ----------------------------------------------------------------------------
await cmd('emulation RunFor "0:0:0.01"')
await cmd('sysbus.gpioPortB OnGPIO 10 true')
const samples = []
let tMs = 0
for (const step of [2, 5, 10, 20, 30, 50, 80, 100]) {
  await cmd(`emulation RunFor "0:0:${(step / 1000).toFixed(3)}"`)
  tMs += step
  samples.push([tMs, num(await cmd('sysbus.loadBank Current 1'))])
}
console.log('  out1 current after PB10 high (ms, A):', samples.map(([t, a]) => `${t}:${a.toFixed(2)}`).join('  '))
check(samples[0][1] > 30, 'inrush starts near the cold peak', `${samples[0][1].toFixed(2)} A @ ${samples[0][0]} ms`)
check(samples.every((s, k) => k === 0 || s[1] <= samples[k - 1][1] + 1e-9), 'inrush decays monotonically')
const last = samples[samples.length - 1][1]
check(Math.abs(last - 3.99) < 0.05, 'settles at 3.99 A (55 W / 13.8 V)', `${last.toFixed(3)} A @ ${tMs} ms`)

const traces = msgs.filter((m) => m.type === 'trace' && m.machine === 'BANKTEST')
console.log('  traces:', traces.map((t) => `t=${t.t} i1=${t.i[0]} on1=${t.on[0]} duty1=${t.duty[0]}`).join(' | '))
check(traces.length >= 2, '10 Hz trace stream', `${traces.length} traces over ${(tMs + 10) / 1000} s virtual`)
check(traces.some((t) => t.on[0] === 1 && t.i[0] > 3.9 && t.i[0] < 6), 'trace shows out1 on, decaying toward 4 A')

// ---- ADC channel 0 holds the raw IS counts ------------------------------------------------------
const rawExpect = Math.round(last * 1200 * 4095 / (3.3 * 22950))
const rawBank = num(await cmd('sysbus.loadBank Raw 1'))
async function convert (ch) {
  await cmd('sysbus WriteDoubleWord 0x4001202C 0x0')          // SQR1: L = 0 (one conversion)
  await cmd(`sysbus WriteDoubleWord 0x40012034 ${ch}`)       // SQR3: SQ1 = ch
  // STM32_ADC latches the sample when the conversion starts and DR shows the previous one until the
  // next start: convert twice and read the second result
  for (let k = 0; k < 2; k++) {
    await cmd('sysbus WriteDoubleWord 0x40012008 0x40000001')  // CR2: ADON | SWSTART
    await cmd('emulation RunFor "0:0:0.001"')
  }
  return num(await cmd('sysbus ReadDoubleWord 0x4001204C'))   // DR
}
const dr0 = await convert(0)
check(rawBank === rawExpect && dr0 === rawExpect, 'ADC1 IN0 = I*1200*4095/(3.3*22950)', `expected ${rawExpect}, bank ${rawBank}, ADC DR ${dr0}`)

// ---- DSEL: out3 (2 A) / out4 (5 A) share IN13 --------------------------------------------------
await cmd('sysbus.loadBank OnGPIO 2 true')
await cmd('sysbus.loadBank OnGPIO 3 true')
await cmd('emulation RunFor "0:0:0.005"')
const r3 = Math.round(2 * 1200 * 4095 / (3.3 * 5950))
const r4 = Math.round(5 * 1200 * 4095 / (3.3 * 5950))
const dLow = await convert(13)
await cmd('sysbus.gpioPortB OnGPIO 14 true')                 // DSEL high -> CH2 = out4, re-fed in the callback
const dHigh = await convert(13)
check(dLow === r3 && dHigh === r4, 'DSEL selects out3 (low) / out4 (high) on IN13', `low ${dLow} (want ${r3}), high ${dHigh} (want ${r4})`)

// ---- battery, VREFINT ----------------------------------------------------------------------------
const vb = await convert(3)
check(vb === Math.round(13.8 * 4.7 / 51.7 / 3.3 * 4095), 'BattVolt IN3 at 13.8 V', `${vb}`)
send({ type: 'vbatt', machine: '*', v: 12.0 })
await cmd('emulation RunFor "0:0:0.002"')
const vb12 = await convert(3)
const i12 = num(await cmd('sysbus.loadBank Current 1'))
check(vb12 === Math.round(12 * 4.7 / 51.7 / 3.3 * 4095) && Math.abs(i12 - 3.99 * Math.pow(12 / 13.8, 0.55)) < 0.02,
  'vbatt 12 V: IN3 and (V/13.8)^vExp', `IN3 ${vb12}, out1 ${i12.toFixed(3)} A`)
check(await convert(17) === 1500, 'VREFINT IN17 = 1500')
send({ type: 'vbatt', machine: '*', v: 13.8 })

// ---- PWM on-phase: TIM3 50 % with IN low --------------------------------------------------------
await cmd('sysbus.gpioPortB OnGPIO 10 false')
await cmd('sysbus WriteDoubleWord 0x4000042C 9999')          // ARR
await cmd('sysbus WriteDoubleWord 0x40000434 5000')          // CCR1
await cmd('sysbus WriteDoubleWord 0x40000400 1')             // CR1.CEN
await cmd('emulation RunFor "0:0:0.11"')
const ipwm = num(await cmd('sysbus.loadBank Current 1'))
const want = 3.99 * Math.pow(2, 0.45)
const tr = msgs.filter((m) => m.type === 'trace').at(-1)
check(Math.abs(ipwm - want) < 0.03 && tr.duty[0] === 50 && tr.on[0] === 1, 'PWM 50 %: on-phase i*(1/d)^0.45, duty from TIM3',
  `${ipwm.toFixed(3)} A (want ${want.toFixed(3)}), trace duty ${tr.duty[0]}`)
await cmd('sysbus WriteDoubleWord 0x40000434 0')             // pwmDisableChannel -> CCR1 = 0 -> off
await cmd('emulation RunFor "0:0:0.002"')
check(num(await cmd('sysbus.loadBank Current 1')) === 0, 'CCR1 = 0 turns the output off')

// ---- faults ----------------------------------------------------------------------------------------
await cmd('sysbus.gpioPortB OnGPIO 10 true')
send({ type: 'fault', machine: 'BANKTEST', out: 1, load: 'h1', kind: 'short', atMs: 0 })
await cmd('emulation RunFor "0:0:0.003"')
const ishort = num(await cmd('sysbus.loadBank Current 1'))
check(ishort === 63, 'short clamps to the BTS7002 saturation (63 A)', `${ishort}`)
await cmd('sysbus.loadBank Fault 1 "open" 0')
await cmd('emulation RunFor "0:0:0.002"')
check(num(await cmd('sysbus.loadBank Current 1')) === 0, 'monitor Fault open -> 0 A')
await cmd('sysbus.loadBank Fault 1 "wrongpart" 0')
await cmd('emulation RunFor "0:0:0.002"')
check(Math.abs(num(await cmd('sysbus.loadBank Current 1')) - 7.98) < 0.02, 'wrongpart x2')
await cmd('sysbus.loadBank Fault 1 "clear" 0')

// ---- DI drive, wake pulse, temp, dump --------------------------------------------------------------
send({ type: 'gpio', machine: 'BANKTEST', pin: 'DI1', value: 1 })
await cmd('emulation RunFor "0:0:0.002"')
const pa = num(await cmd('sysbus ReadDoubleWord 0x40020010'))  // GPIOA IDR
check(((pa >> 10) & 1) === 1, 'gpio DI1 drives PA10 (GPIOA IDR bit 10)', `IDR 0x${pa.toString(16)}`)
const pb0 = num(await cmd('sysbus ReadDoubleWord 0x40020410')) // GPIOB IDR
await cmd('sysbus.loadBank WakePulse')
await cmd('emulation RunFor "0:0:0.002"')
const pb1 = num(await cmd('sysbus ReadDoubleWord 0x40020410'))
check(msgs.some((m) => m.type === 'event' && m.what === 'wake-pulse') && ((pb0 ^ pb1) >> 8 & 1) === 1,
  'WakePulse toggles PB8 and emits event', `IDR ${pb0.toString(16)} -> ${pb1.toString(16)}`)
send({ type: 'temp', machine: 'BANKTEST', c: 85 })
await sleep(200)
check(/no MCP9808/.test(log), 'temp without an MCP9808 logs a warning')
const dump = await cmd('sysbus.loadBank Dump')
console.log('  Dump:', dump.slice(0, 400))
check(dump.includes('"machine":"BANKTEST"'), 'Dump returns JSON state')

// ---- CANBoard bank on a second machine, same listener ---------------------------------------------
const inc2 = await cmd('include @renode/test/bank_canboard.resc', 120000)
if (/error/i.test(inc2)) { console.error(inc2); done(2) }
await sleep(300)
check(msgs.some((m) => m.type === 'hello' && m.machine === 'CBTEST' && m.board === 'canboard' && m.inputs === 8 && m.analog === 5 && m.digitalOut === 4),
  'second bank announces itself to the connected client')
send({ type: 'adc', machine: 'CB-NOPE', ch: 1, mV: 1 })
await sleep(200)
check(msgs.some((m) => m.type === 'error' && /CB-NOPE/.test(m.msg)), 'unknown machine -> error message')
send({ type: 'adc', machine: 'CBTEST', ch: 1, mV: 1500 })
send({ type: 'adc', machine: 'CBTEST', ch: 5, mV: 4000 })
send({ type: 'gpio', machine: 'CBTEST', pin: 'DI3', value: 1 })
await sleep(200)
await cmd('sysbus.gpioPortA OnGPIO 15 true')                 // DO1 high
await cmd('emulation RunFor "0:0:0.11"')
const a1 = num(await cmd('sysbus.adc1 GetADCValue 1'))
const a5 = num(await cmd('sysbus.adc2 GetADCValue 1'))
const mvPin = (mv) => Math.round(Math.round(mv * 10000 / 14700 / 3300 * 4095) * 3300 / 4095)
check(a1 === mvPin(1500) && a5 === mvPin(4000), 'CANBoard AI1 -> ADC1 IN1, AI5 -> ADC2 IN1 (pin mV after 4k7/10k)',
  `${a1} / ${a5} mV, want ${mvPin(1500)} / ${mvPin(4000)}`)
const pa2 = num(await cmd('sysbus ReadDoubleWord 0x40020010'))
check(((pa2 >> 7) & 1) === 1, 'CANBoard DI3 drives PA7', `IDR 0x${pa2.toString(16)}`)
const cbt = msgs.filter((m) => m.type === 'trace' && m.machine === 'CBTEST').at(-1)
check(cbt && cbt.do[0] === 1 && cbt.di[2] === 1 && cbt.mV[0] === 1500, 'CANBoard trace do/di/mV', JSON.stringify(cbt))
send({ type: 'vbatt', machine: '*', v: 13.1 })
await sleep(200)
await cmd('mach set "BANKTEST"')
check(/"vbattV":13\.1/.test(await cmd('sysbus.loadBank Dump')), 'vbatt "*" reaches every machine')

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
mon.write('quit\n')
await sleep(500)
done(failures ? 1 : 0)
