import { readFileSync, writeFileSync } from 'node:fs'
import { convertDwgToPascal } from '../src/index.ts'

const input = process.argv[2]
const output = process.argv[3] ?? 'out.pascal.json'
if (!input) {
  console.error('usage: bun run convert <input.dwg> [output.json]')
  process.exit(1)
}

const buf = readFileSync(input)
const result = await convertDwgToPascal(buf, { name: 'Crescent Parklands — Level 1' })

writeFileSync(output, JSON.stringify({ nodes: result.nodes, rootNodeIds: result.rootNodeIds }, null, 2))

console.log('=== STATS ===')
for (const [k, v] of Object.entries(result.stats)) {
  if (k === 'warnings') continue
  console.log('  ' + k.padEnd(18), v)
}
console.log('  nodes total       ', Object.keys(result.nodes).length)
if (result.stats.warnings.length) {
  console.log('=== WARNINGS (' + result.stats.warnings.length + ') ===')
  for (const w of result.stats.warnings.slice(0, 8)) console.log('  - ' + w)
}
console.log('\nwrote', output)
