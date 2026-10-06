// Render a one-PDM scene through server/renode.js generateResc (the templates in renode/templates)
// and print the .resc path.   node renode/test/gen_single.mjs [elf]
// Default elf: $SIM_FW_DIR/dingopdm_v7.elf (SIM_FW_DIR default ../CoffeeDingoFW/build next to this repo).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateResc } from '../../server/renode.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const elf = process.argv[2] ?? path.join(process.env.SIM_FW_DIR || path.resolve(root, '../CoffeeDingoFW/build'), 'dingopdm_v7.elf')
const scene = { name: 'r1single', modules: [{ id: 'PDM-01', kind: 'pdm', baseId: 0x0de }] }
const r = generateResc(scene, { pdm: elf }, {
  outDir: path.join(root, 'renode', 'test', 'gen'),
  nvDir: path.join(root, 'renode', 'test', 'nv'),
})
console.log(r.fallback ? 'FALLBACK' : 'templates', r.path)
