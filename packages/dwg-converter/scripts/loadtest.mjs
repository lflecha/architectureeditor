import { readFileSync } from 'node:fs'
import { useScene } from '@pascal-app/core'

const j = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const before = {}
for (const n of Object.values(j.nodes)) before[n.type] = (before[n.type] || 0) + 1
console.log('BEFORE:', JSON.stringify(before), 'total', Object.keys(j.nodes).length)

try {
  useScene.getState().setScene(j.nodes, j.rootNodeIds)
} catch (e) {
  console.log('setScene THREW:', e?.message)
}

const after = {}
const st = useScene.getState()
for (const n of Object.values(st.nodes)) after[n.type] = (after[n.type] || 0) + 1
console.log('AFTER :', JSON.stringify(after), 'total', Object.keys(st.nodes).length)
console.log('rootNodeIds:', JSON.stringify(st.rootNodeIds))

// If walls were dropped, try parsing one wall through migrate to see the error
const wall = Object.values(j.nodes).find((n) => n.type === 'wall')
if (!Object.values(st.nodes).some((n) => n.type === 'wall')) {
  console.log('\nWalls dropped. Trying WallNode.parse on one directly:')
  const { WallNode } = await import('@pascal-app/core')
  const res = WallNode.safeParse(wall)
  console.log('WallNode.safeParse success:', res.success)
  if (!res.success) console.log(JSON.stringify(res.error.issues?.slice(0, 5), null, 2))
}
