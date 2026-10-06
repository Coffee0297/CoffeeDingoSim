// End-to-end CANBoard bring-up check. Starts its OWN Renode via cb_start.sh
// (monitor :1244, SLCAN bridge :7787, PID in renode/test/cb_renode.pid) and verifies:
//   a) boots without hang (cyclic traffic, PC moving)
//   b) cyclic frames from the default base 0x640 (0x642.. on the hub)
//   c) Version request on 0x641 -> reply on 0x640: boardId 2, 5.5.107
//   d) analog input mV fed through the load bank shows up in CANBoardMsg0/Msg1 (DBC CANBoard_0.5.1)
//   e) base id 0x660 written + burned persists across `machine Reset` AND a fresh Renode start (nv file)
// Run from the repo root:  node renode/test/cb_probe.mjs [--keep]   (--keep leaves Renode running)
// Env: CB_ELF to override the firmware (passed as $elf).
import net from 'node:net'
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const MON = 1244, BRIDGE = 7787
const NV = 'renode/test/nv/CB-01.bin'
const keep = process.argv.includes('--keep')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hex = (b) => [...b].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('')
const results = []
const check = (name, ok, evidence) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${evidence}`) }

async function startRenode () {
  // cb_start.sh blocks until the monitor is up; stdio ignored so the detached Renode does not hold our pipes
  const p = spawn('bash', ['renode/test/cb_start.sh'], { stdio: 'ignore' })
  const code = await new Promise((r) => p.on('exit', r))
  if (code !== 0) throw new Error('cb_start.sh failed')
  console.log('renode up, pid', fs.readFileSync('renode/test/cb_renode.pid', 'utf8').trim())
}

async function monitor () {
  const sock = net.connect(MON, '127.0.0.1')
  let buf = ''
  sock.on('data', (d) => { buf += d.toString('latin1') })
  sock.on('error', () => {})   // Renode drops the socket on quit
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j) })
  await sleep(500)
  const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\xff[\xfb-\xfe]./gs, '')
  return {
    async cmd (c, wait = 1200) { buf = ''; sock.write(c + '\n'); await sleep(wait); return strip(buf) },
    close () { sock.destroy() },
  }
}

async function bridge () {
  const sock = net.connect(BRIDGE, '127.0.0.1')
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j) })
  const frames = []
  let rest = ''
  sock.on('data', (d) => {
    rest += d.toString('latin1')
    const lines = rest.split('\r'); rest = lines.pop()
    for (const l of lines) {
      if (l[0] !== 't') continue
      const id = parseInt(l.slice(1, 4), 16), dlc = parseInt(l[4], 16)
      const data = Buffer.from(l.slice(5, 5 + dlc * 2), 'hex')
      frames.push({ id, data, at: Date.now() })
    }
  })
  return {
    frames,
    send (id, bytes) { sock.write(`t${id.toString(16).toUpperCase().padStart(3, '0')}${bytes.length}${hex(bytes)}\r`) },
    since (t, id) { return frames.filter((f) => f.at >= t && (id === undefined || f.id === id)) },
    async waitFor (id, pred, ms = 4000) {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        const f = frames.find((x) => x.at >= t0 - 50 && x.id === id && (!pred || pred(x.data)))
        if (f) return f
        await sleep(50)
      }
      return null
    },
    close () { sock.destroy() },
  }
}

async function boot () {
  await startRenode()
  await sleep(12000) // script load + C# compile
  const m = await monitor()
  await m.cmd('mach set "CB-01"')
  await m.cmd('start', 1500)
  await sleep(4000)
  const b = await bridge()
  return { m, b }
}

fs.rmSync(NV, { force: true })
let { m, b } = await boot()

// a/b ------------------------------------------------------------------------------------
let t = Date.now(); await sleep(3000)
const cyc = [0x642, 0x643, 0x644].map((id) => b.since(t, id).length)
const pc1 = (await m.cmd('cpu PC')).match(/0x[0-9a-f]+/i)?.[0]; await sleep(300)
const pc2 = (await m.cmd('cpu PC')).match(/0x[0-9a-f]+/i)?.[0]
check('a) boots without hang', cyc[0] > 5 && pc1 !== undefined, `0x642 x${cyc[0]} in 3 s, PC ${pc1} / ${pc2}`)
check('b) cyclic frames from base 0x640', cyc.every((n) => n > 5), `0x642/643/644 counts ${cyc.join('/')} in 3 s`)
check('   first boot wrote the default config to the nv file', fs.existsSync(NV) && fs.statSync(NV).size === 2048, `${NV} ${fs.existsSync(NV) ? fs.statSync(NV).size : 0} B`)

// c ---------------------------------------------------------------------------------------
b.send(0x641, [31, 0, 0, 0, 0, 0, 0, 0])
let r = await b.waitFor(0x640, (d) => d[0] === 31)
check('c) Version 0x641 -> 0x640', r && r.data[1] === 2 && r.data[4] === 5 && r.data[5] === 5 && ((r.data[6] << 8) | r.data[7]) === 107,
  r ? `reply ${hex(r.data)} = boardId ${r.data[1]}, ${r.data[4]}.${r.data[5]}.${(r.data[6] << 8) | r.data[7]}` : 'no reply')

// d ---------------------------------------------------------------------------------------
await m.cmd('sysbus.loadBank SetAnalog 1 1500', 300)
await m.cmd('sysbus.loadBank SetAnalog 4 2750', 300)
await m.cmd('sysbus.loadBank SetAnalog 5 4000', 300)
await sleep(800)
const m0 = await b.waitFor(0x642, (d) => Math.abs(d.readUInt16LE(0) - 1500) < 10)
const m1 = await b.waitFor(0x643, (d) => Math.abs(d.readUInt16LE(0) - 4000) < 10)
const ai = m0 ? [0, 2, 4, 6].map((o) => m0.data.readUInt16LE(o) * 0.001) : []
check('d) analog mV in CANBoardMsg0/Msg1', !!(m0 && m1) && Math.abs(ai[3] - 2.75) < 0.01,
  m0 && m1 ? `0x642 ${hex(m0.data)} ADCVolt_1..4 = ${ai.map((v) => v.toFixed(3)).join(' ')} V; 0x643 ${hex(m1.data)} ADCVolt5 = ${(m1.data.readUInt16LE(0) * 0.001).toFixed(3)} V BoardTemp = ${m1.data.readUInt16LE(6)}` : 'not seen')

// e ---------------------------------------------------------------------------------------
const before = fs.readFileSync(NV)
// The write applies to the live config at once: the echo already goes out on the NEW base (0x660) and the
// module now listens on 0x661, so the burn must be sent to new base + 1 (a burn on 0x641 is ignored).
b.send(0x641, [2, 0, 0, 0, 0x60, 0x06, 0, 0])
r = await b.waitFor(0x660, (d) => d[0] === 2)
const old = b.frames.find((f) => f.id === 0x640 && f.data[0] === 2)
check('e1) write base id 0x0000/0 = 0x660 (echo on the new base 0x660)', r && r.data[4] === 0x60 && r.data[5] === 0x06, r ? `echo on 0x660 ${hex(r.data)}${old ? ' (also on 0x640?!)' : ''}` : 'no reply')
t = Date.now(); await sleep(1500)
check('   cyclic frames moved to 0x662 before burn', b.since(t, 0x662).length > 3, `0x662 x${b.since(t, 0x662).length}, 0x642 x${b.since(t, 0x642).length}`)
b.send(0x661, [30, 1, 3, 8, 0, 0, 0, 0])
r = await b.waitFor(0x660, (d) => d[0] === 30, 6000)
await sleep(500)
const after = fs.readFileSync(NV)
check('e2) burn [30,1,3,8] on 0x661 -> ok on 0x660, nv file rewritten', r && r.data[4] === 1 && !before.equals(after), r ? `reply ${hex(r.data)}; nv changed ${!before.equals(after)}` : 'no reply')
await m.cmd('machine Reset', 1500)
await sleep(4000)
t = Date.now(); await sleep(2500)
check('e3) after machine Reset talks on 0x660', b.since(t, 0x662).length > 5 && b.since(t, 0x642).length === 0,
  `0x662 x${b.since(t, 0x662).length}, 0x642 x${b.since(t, 0x642).length} in 2.5 s`)

b.close(); await m.cmd('quit', 1500); m.close()
await sleep(3000);
({ m, b } = await boot())
t = Date.now(); await sleep(2500)
b.send(0x661, [31, 0, 0, 0, 0, 0, 0, 0])
r = await b.waitFor(0x660, (d) => d[0] === 31)
check('e4) fresh Renode start (image reloaded) talks on 0x660', b.since(t, 0x662).length > 5 && b.since(t, 0x642).length === 0 && !!r,
  `0x662 x${b.since(t, 0x662).length}, 0x642 x${b.since(t, 0x642).length}; Version on 0x661 -> 0x660 ${r ? hex(r.data) : 'none'}`)

b.close()
if (!keep) { await m.cmd('quit', 1500) }
m.close()
const failed = results.filter((x) => !x.ok).length
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
