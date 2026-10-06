// Connect to the SLCAN bridge, print a per-ID frame summary, optionally send frames.
//   node renode/test/slcan_probe.mjs [seconds=5] [frame ...]
//   node renode/test/slcan_probe.mjs 3 t0DF81F00000000000000      (Version request to default base 0x0DE)
// Env: SLCAN_PORT (default 7777)
import net from 'node:net'

const port = Number(process.env.SLCAN_PORT ?? 7777)
const secs = Number(process.argv[2] ?? 5)
const tx = process.argv.slice(3)
const byId = new Map()
const replies = []
let rest = ''

const sock = net.connect(port, '127.0.0.1', () => {
  setTimeout(() => { for (const f of tx) sock.write(f + '\r') }, 300)
})
sock.on('data', (d) => {
  rest += d.toString('latin1')
  const lines = rest.split('\r')
  rest = lines.pop()
  for (const l of lines) {
    if (!/^[tT]/.test(l)) { replies.push(JSON.stringify(l)); continue }
    const ext = l[0] === 'T'
    const id = parseInt(l.slice(1, ext ? 9 : 4), 16)
    const e = byId.get(id) ?? { n: 0, last: '' }
    e.n++; e.last = l
    byId.set(id, e)
  }
})
sock.on('error', (e) => { console.error('bridge:', e.message); process.exit(1) })
setTimeout(() => {
  const ids = [...byId.keys()].sort((a, b) => a - b)
  for (const id of ids) {
    const e = byId.get(id)
    console.log(`0x${id.toString(16).toUpperCase().padStart(3, '0')}  n=${String(e.n).padStart(5)}  last=${e.last}`)
  }
  if (replies.length) console.log('non-frame replies:', replies.join(' '))
  console.log(`total ids=${ids.length}`)
  sock.end(); process.exit(0)
}, secs * 1000)
