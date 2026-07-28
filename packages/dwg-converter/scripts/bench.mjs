import { readFileSync } from 'node:fs'
import { LibreDwg } from '@mlightcad/libredwg-web'

const input = process.argv[2]
if (!input) {
  console.error('usage: bun run bench <input.dwg>')
  process.exit(1)
}

const t0 = performance.now()
const buf = readFileSync(input)
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const t1 = performance.now()

const dwg = await LibreDwg.create()
const data = dwg.dwg_read_data(ab, 0)
const db = dwg.convert(data)
const t2 = performance.now()

const ents = db.entities ?? []
const isWallLayer = (l) => /_WALL_(EXT|INT)\b/i.test(l)
let wallLines = 0
let totalLines = 0
const typeCounts = {}
for (const e of ents) {
  typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1
  if (e.type === 'LINE') {
    totalLines++
    if (isWallLayer(e.layer ?? '')) wallLines++
  }
}

console.log('file size          ', (buf.length / 1024 / 1024).toFixed(2), 'MB')
console.log('read+parse         ', (t2 - t1).toFixed(0), 'ms')
console.log('total entities     ', ents.length)
console.log('total LINE         ', totalLines)
console.log('WALL LINE (segs)   ', wallLines)
console.log('--- top entity types ---')
for (const [k, v] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log('  ' + k.padEnd(16), v)
}
// O(n^2) estimate
console.log('--- pairing cost ---')
console.log('  n^2 pair iters   ', (wallLines * wallLines).toLocaleString())
