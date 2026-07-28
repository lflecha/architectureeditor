import { readFileSync } from 'node:fs'
import { LibreDwg } from '@mlightcad/libredwg-web'

const input = process.argv[2]
const dwg = await LibreDwg.create()
const buf = readFileSync(input)
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const db = dwg.convert(dwg.dwg_read_data(ab, 0))
const ents = db.entities ?? []

// layer -> { types: {type:count}, total }
const byLayer = new Map()
for (const e of ents) {
  const l = e.layer ?? '(none)'
  if (!byLayer.has(l)) byLayer.set(l, { total: 0, types: {} })
  const g = byLayer.get(l)
  g.total++
  g.types[e.type] = (g.types[e.type] ?? 0) + 1
}

const rows = [...byLayer.entries()].sort((a, b) => b[1].total - a[1].total)
console.log('=== ALL LAYERS (', rows.length, ') ===')
for (const [layer, g] of rows) {
  const types = Object.entries(g.types).map(([t, c]) => `${t}:${c}`).join(' ')
  console.log(String(g.total).padStart(5), layer.padEnd(48), types)
}

// Highlight likely glazing / window / curtain / door layers
console.log('\n=== GLAZING / WINDOW / CURTAIN / DOOR candidates ===')
for (const [layer, g] of rows) {
  if (/glaz|window|curtain|cw|door|glass|facade|screen|mull/i.test(layer)) {
    console.log(String(g.total).padStart(5), layer)
  }
}

// Sample INSERT block names per door/window-ish layer
console.log('\n=== sample INSERT names on door/window/curtain layers ===')
const seen = new Set()
for (const e of ents) {
  if (e.type !== 'INSERT') continue
  const l = e.layer ?? ''
  if (!/glaz|window|curtain|door|glass/i.test(l)) continue
  const key = l + '||' + (e.name ?? '')
  if (seen.has(key)) continue
  seen.add(key)
  if (seen.size <= 40) console.log(l.padEnd(40), '->', e.name)
}
