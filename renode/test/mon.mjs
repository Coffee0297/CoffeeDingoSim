// Send Renode monitor commands over the telnet port and print the replies.
//   node renode/test/mon.mjs "mach set \"PDM-01\"" "cpu PC" "sysbus.gpioPortC.statusLed State"
// Env: MON_PORT (default 1234), MON_WAIT_MS (default 1500 per command)
import net from 'node:net'

const port = Number(process.env.MON_PORT ?? 1234)
const wait = Number(process.env.MON_WAIT_MS ?? 1500)
const cmds = process.argv.slice(2)
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\xff][\xfb-\xfe]./gs, '')

const sock = net.connect(port, '127.0.0.1')
let buf = ''
sock.on('data', (d) => { buf += d.toString('latin1') })
sock.on('error', (e) => { console.error('monitor:', e.message); process.exit(1) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => sock.once('connect', r))
await sleep(500)
buf = ''
for (const c of cmds) {
  sock.write(c + '\n')
  await sleep(wait)
  console.log(`>>> ${c}\n${strip(buf).trim()}\n`)
  buf = ''
}
sock.end(); process.exit(0)
