// Render a one-CANBoard scene through server/renode.js generateResc (car.resc.hbs + canboard_v2.resc.hbs),
// start a monitor-only Renode on the CANBoard test ports (monitor 1244, bridge 7787), `include` the generated
// script over telnet like the server does, and check: no include errors, cyclic frames, nv image written,
// module reset through the generated reset_<id> macro.
//   node renode/test/cb_template.mjs [--keep]
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generateResc } from '../../server/renode.js'

// Firmware: CB_ELF, else $SIM_FW_DIR/canboard_v2.elf (default ../CoffeeDingoFW/build next to this repo)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FW_DIR = process.env.SIM_FW_DIR || path.resolve(ROOT, '../CoffeeDingoFW/build')
const ELF = process.env.CB_ELF || path.join(FW_DIR, 'canboard_v2.elf')
const outDir = path.resolve('renode/test/cb_gen')
const nvDir = path.join(outDir, 'nv')
fs.rmSync(outDir, { recursive: true, force: true })
const scene = { name: 'cb_template', modules: [{ id: 'CB-T1', kind: 'canboard', baseId: 0x640 }] }
const r = generateResc(scene, { canboard: ELF }, { outDir, nvDir, bridgePort: 7787, monitorPort: 1244, bankPort: 7800, hub: 'vehicle' })
console.log(`rendered ${r.path}; modules ${r.modules.join(',')}; skipped ${JSON.stringify(r.skipped)}`)

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
const NL = String.fromCharCode(10)
const p = spawn('bash', ['renode/test/cb_start.sh', '-'], { stdio: 'ignore' })
if (await new Promise((res) => p.on('exit', res)) !== 0) { console.error('cb_start.sh failed'); process.exit(1) }

const mon = net.connect(1244, '127.0.0.1')
await new Promise((res) => mon.once('connect', res))
let mbuf = ''
mon.on('data', (d) => { mbuf += d.toString('latin1') })
mon.on('error', () => {})   // Renode drops the socket on quit
const send = (c) => mon.write(c + NL)
const errorsIn = (s) => s.split(NL).filter((l) => /error|exception|could not|does not lay/i.test(l))
await sleep(500); mbuf = ''
send(`include @${r.path.split(path.sep).join('/')}`)
await sleep(25000)
const ie = errorsIn(mbuf)
console.log(`${ie.length ? 'FAIL' : 'PASS'}  include of the generated .resc${ie.length ? ': ' + ie.join(' | ') : ': no errors'}`)
send('start'); await sleep(5000)

const seen = new Map()
const br = net.connect(7787, '127.0.0.1')
let rest = ''
br.on('data', (d) => {
  rest += d.toString('latin1'); const ls = rest.split('\r'); rest = ls.pop()
  for (const l of ls) if (l[0] === 't') { const id = parseInt(l.slice(1, 4), 16); seen.set(id, (seen.get(id) || 0) + 1) }
})
await sleep(3000)
const n = seen.get(0x642) || 0
const nv = path.join(nvDir, 'CB-T1.bin')
console.log(`${n > 5 ? 'PASS' : 'FAIL'}  template boot: 0x642 x${n} in 3 s, ids ${[...seen.keys()].map((x) => '0x' + x.toString(16)).join(' ')}; nv ${fs.existsSync(nv) ? fs.statSync(nv).size + ' B' : 'missing'}`)

// module reset through the generated macro (what server/renode.js reset() runs)
mbuf = ''; seen.clear()
send('pause'); await sleep(500)
send('runMacro $reset_CB_T1'); await sleep(4000)
send('start'); await sleep(5000)
const me = errorsIn(mbuf)
const nr = seen.get(0x642) || 0
console.log(`${nr > 5 && !me.length ? 'PASS' : 'FAIL'}  reset macro: 0x642 x${nr} in 5 s after runMacro $reset_CB_T1${me.length ? '; ' + me.join(' | ') : ''}`)
br.destroy()
if (!process.argv.includes('--keep')) send('quit')
await sleep(500); mon.destroy()
process.exit(n > 5 && nr > 5 && !ie.length && !me.length ? 0 : 1)
