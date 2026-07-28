import { LibreDwg } from '@mlightcad/libredwg-web'
import {
  BuildingNode,
  ColumnNode,
  DEFAULT_LEVEL_HEIGHT,
  DoorNode,
  LevelNode,
  SiteNode,
  SlabNode,
  WallNode,
} from '@pascal-app/core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConvertOptions {
  /** Floor-to-floor height in metres applied to the level and walls. */
  levelHeight?: number
  /** Wall-thickness search window in millimetres for pairing face lines. */
  minWallThicknessMm?: number
  maxWallThicknessMm?: number
  /** Emit an unpaired wall line as a single-face wall of this thickness (mm). */
  singleFaceThicknessMm?: number
  name?: string
}

export interface ConvertResult {
  nodes: Record<string, unknown>
  rootNodeIds: string[]
  stats: Record<string, number> & { warnings: string[] }
}

interface Pt {
  x: number
  y: number
}
interface Seg {
  a: Pt
  b: Pt
  layer: string
}
interface Insert {
  pos: Pt
  rotation: number
  name: string
  layer: string
}

// ---------------------------------------------------------------------------
// Layer classification (national CAD standard used by the sample set)
// ---------------------------------------------------------------------------

const isWallLayer = (l: string) => /_WALL_(EXT|INT)\b/i.test(l)
const isColumnLayer = (l: string) => /_COLUMN\b/i.test(l)
const isDoorLayer = (l: string) => /-M_DOOR\b/i.test(l) // main door layer, not _PANEL/_FRAME

// ---------------------------------------------------------------------------
// Small 2D geometry helpers (millimetres throughout until final scaling)
// ---------------------------------------------------------------------------

const sub = (p: Pt, q: Pt): Pt => ({ x: p.x - q.x, y: p.y - q.y })
const len = (p: Pt) => Math.hypot(p.x, p.y)
const dot = (p: Pt, q: Pt) => p.x * q.x + p.y * q.y
const cross = (p: Pt, q: Pt) => p.x * q.y - p.y * q.x
const unit = (p: Pt): Pt => {
  const l = len(p) || 1
  return { x: p.x / l, y: p.y / l }
}

/** Perpendicular distance from point p to the infinite line through a→b. */
function perpDistance(p: Pt, a: Pt, b: Pt): number {
  const d = sub(b, a)
  const l = len(d) || 1
  return Math.abs(cross(sub(p, a), d)) / l
}

/** Project point p onto line a→b, returning the scalar parameter t (in mm along a→b unit dir). */
function projectParam(p: Pt, a: Pt, dir: Pt): number {
  return dot(sub(p, a), dir)
}

// ---------------------------------------------------------------------------
// DWG parsing
// ---------------------------------------------------------------------------

function entPoint(v: any): Pt | null {
  if (!v) return null
  if (typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y }
  return null
}

async function readDwg(buffer: ArrayBuffer | Uint8Array) {
  const ab =
    buffer instanceof Uint8Array
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      : buffer
  const dwg = await LibreDwg.create()
  const data = dwg.dwg_read_data(ab as ArrayBuffer, 0)
  if (data === undefined || data === 0) throw new Error('Failed to read DWG file')
  const db = dwg.convert(data)
  return db
}

// ---------------------------------------------------------------------------
// Block-name dimension parsing
// ---------------------------------------------------------------------------

/** Column: "..._Rectangular_... - 1000_w_x500..." or "..._Round_... - Diamater_900mm". */
function parseColumnDims(name: string): {
  crossSection: 'rectangular' | 'round'
  width: number
  depth: number
  radius?: number
} {
  if (/round|diamater|diameter/i.test(name)) {
    const m = name.match(/(\d{2,5})\s*mm/i) || name.match(/(\d{2,5})/)
    const dia = m ? Number(m[1]) : 440
    return { crossSection: 'round', width: dia, depth: dia, radius: dia / 2 }
  }
  // rectangular: grab the two dimensions after the last " - "
  const tail = name.split(' - ').pop() ?? name
  const nums = tail.match(/\d{2,5}/g)?.map(Number) ?? []
  const width = nums[0] ?? 440
  const depth = nums[1] ?? width
  return { crossSection: 'rectangular', width, depth }
}

/** Door: "..._Sliding_..._4Panel_OXXO - 4000_w_x2700_h..." or "..._Swing_Dbl - 920_920_w_x2340_h_". */
function parseDoorDims(name: string): {
  width: number
  height: number
  doorType: string
  leafCount: 1 | 2 | 3 | 4
} {
  const tail = name.split(' - ').pop() ?? name
  // widths appear before "_w", height before "_h"
  const wMatch = tail.match(/([\d_]+?)_w/i)
  const widths = wMatch ? wMatch[1].split('_').map(Number).filter(Boolean) : []
  const width = widths.length ? widths.reduce((a, b) => a + b, 0) : 900
  const hMatch = tail.match(/x?\s*(\d{3,5})_h/i)
  const height = hMatch ? Number(hMatch[1]) : 2100
  const sliding = /sliding/i.test(name)
  const dbl = /_dbl|double/i.test(name) || widths.length >= 2
  const doorType = sliding ? 'sliding' : dbl ? 'double' : 'hinged'
  const leafCount = (widths.length >= 4 ? 4 : widths.length >= 2 ? 2 : 1) as 1 | 2 | 4
  return { width, height, doorType, leafCount }
}

// ---------------------------------------------------------------------------
// Wall reconstruction: pair parallel face-lines into centreline + thickness
// ---------------------------------------------------------------------------

interface WallSeg {
  start: Pt
  end: Pt
  thickness: number
}

function buildWalls(segs: Seg[], opts: Required<ConvertOptions>): WallSeg[] {
  const minT = opts.minWallThicknessMm
  const maxT = opts.maxWallThicknessMm
  const used = new Array(segs.length).fill(false)
  const walls: WallSeg[] = []
  const ANGLE_EPS = Math.sin((5 * Math.PI) / 180) // ~5 degrees
  const MIN_OVERLAP = 150 // mm
  const MIN_LEN = 150
  const MAX_LEN = 60000

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    const si = segs[i]
    const di = unit(sub(si.b, si.a))
    const li = len(sub(si.b, si.a))
    if (li < MIN_LEN) {
      used[i] = true
      continue
    }
    let best = -1
    let bestScore = Infinity
    let bestThick = 0
    for (let j = i + 1; j < segs.length; j++) {
      if (used[j]) continue
      const sj = segs[j]
      const dj = unit(sub(sj.b, sj.a))
      // parallel?
      if (Math.abs(cross(di, dj)) > ANGLE_EPS) continue
      // perpendicular gap within thickness window?
      const gap = perpDistance(sj.a, si.a, si.b)
      if (gap < minT || gap > maxT) continue
      // overlap along di?
      const t0 = 0
      const t1 = li
      const u0 = projectParam(sj.a, si.a, di)
      const u1 = projectParam(sj.b, si.a, di)
      const lo = Math.max(Math.min(t0, t1), Math.min(u0, u1))
      const hi = Math.min(Math.max(t0, t1), Math.max(u0, u1))
      if (hi - lo < MIN_OVERLAP) continue
      const score = gap + (li - (hi - lo)) * 0.01
      if (score < bestScore) {
        bestScore = score
        best = j
        bestThick = gap
      }
    }
    if (best >= 0) {
      used[i] = true
      used[best] = true
      const sj = segs[best]
      // centreline: midpoints of the two segments' overlapping extent
      const midA = { x: (si.a.x + closest(sj, si.a).x) / 2, y: (si.a.y + closest(sj, si.a).y) / 2 }
      const midB = { x: (si.b.x + closest(sj, si.b).x) / 2, y: (si.b.y + closest(sj, si.b).y) / 2 }
      walls.push({ start: midA, end: midB, thickness: bestThick })
    } else {
      // unpaired: emit as a single-face wall if plausibly a wall run
      if (li >= MIN_LEN && li <= MAX_LEN) {
        used[i] = true
        walls.push({ start: si.a, end: si.b, thickness: opts.singleFaceThicknessMm })
      } else {
        used[i] = true
      }
    }
  }
  return walls
}

/** Closest point on segment s to point p. */
function closest(s: Seg, p: Pt): Pt {
  const d = sub(s.b, s.a)
  const l2 = dot(d, d) || 1
  let t = dot(sub(p, s.a), d) / l2
  t = Math.max(0, Math.min(1, t))
  return { x: s.a.x + d.x * t, y: s.a.y + d.y * t }
}

// ---------------------------------------------------------------------------
// Convex hull (Andrew's monotone chain) for a floor slab footprint
// ---------------------------------------------------------------------------

function convexHull(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross3 = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt[] = []
  for (const q of p) {
    while (lower.length >= 2 && cross3(lower[lower.length - 2], lower[lower.length - 1], q) <= 0)
      lower.pop()
    lower.push(q)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross3(upper[upper.length - 2], upper[upper.length - 1], q) <= 0)
      upper.pop()
    upper.push(q)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

// ---------------------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------------------

export async function convertDwgToPascal(
  buffer: ArrayBuffer | Uint8Array,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  const opts: Required<ConvertOptions> = {
    levelHeight: options.levelHeight ?? 3.1,
    minWallThicknessMm: options.minWallThicknessMm ?? 50,
    maxWallThicknessMm: options.maxWallThicknessMm ?? 500,
    singleFaceThicknessMm: options.singleFaceThicknessMm ?? 150,
    name: options.name ?? 'Imported DWG',
  }
  const warnings: string[] = []

  const db = await readDwg(buffer)
  const ents: any[] = db.entities ?? []

  // Collect segments and inserts by classification
  const wallSegs: Seg[] = []
  const columnInserts: Insert[] = []
  const doorInserts: Insert[] = []
  for (const e of ents) {
    const layer: string = e.layer ?? ''
    if (e.type === 'LINE' && isWallLayer(layer)) {
      const a = entPoint(e.startPoint ?? e.start)
      const b = entPoint(e.endPoint ?? e.end)
      if (a && b) wallSegs.push({ a, b, layer })
    } else if (e.type === 'INSERT') {
      const pos = entPoint(e.insertionPoint ?? e.position)
      if (!pos) continue
      const ins: Insert = { pos, rotation: e.rotation ?? 0, name: e.name ?? '', layer }
      if (isColumnLayer(layer)) columnInserts.push(ins)
      else if (isDoorLayer(layer)) doorInserts.push(ins)
    }
  }

  // Compute origin (centre of building bbox from walls + columns) for recentring
  const anchor: Pt[] = [
    ...wallSegs.flatMap((s) => [s.a, s.b]),
    ...columnInserts.map((c) => c.pos),
  ]
  if (anchor.length === 0) throw new Error('No walls or columns found on recognised layers')
  const minX = Math.min(...anchor.map((p) => p.x))
  const maxX = Math.max(...anchor.map((p) => p.x))
  const minY = Math.min(...anchor.map((p) => p.y))
  const maxY = Math.max(...anchor.map((p) => p.y))
  const ox = (minX + maxX) / 2
  const oy = (minY + maxY) / 2

  // mm (recentred) -> metres, DWG(X,Y) -> level plane (x, z). Flip Y so plan north stays up.
  const MX = (p: Pt): [number, number] => [(p.x - ox) / 1000, -(p.y - oy) / 1000]

  // --- Root scaffold: site -> building -> level ---
  const site = SiteNode.parse({
    object: 'node',
    type: 'site',
    name: opts.name,
    parentId: null,
    children: [],
  }) as any
  const building = BuildingNode.parse({
    object: 'node',
    type: 'building',
    parentId: site.id,
    children: [],
  }) as any
  const level = LevelNode.parse({
    object: 'node',
    type: 'level',
    name: 'Level 1',
    parentId: building.id,
    level: 0,
    height: opts.levelHeight,
    children: [],
  }) as any
  site.children.push(building.id)
  building.children.push(level.id)

  const nodes: Record<string, unknown> = {}
  nodes[site.id] = site
  nodes[building.id] = building
  nodes[level.id] = level

  // --- Walls ---
  const wallSpecs = buildWalls(wallSegs, opts)
  const wallNodes: any[] = []
  for (const w of wallSpecs) {
    const node = WallNode.parse({
      object: 'node',
      type: 'wall',
      parentId: level.id,
      start: MX(w.start),
      end: MX(w.end),
      thickness: Math.max(0.05, w.thickness / 1000),
      children: [],
    }) as any
    nodes[node.id] = node
    level.children.push(node.id)
    wallNodes.push({ node, start: w.start, end: w.end }) // keep mm centreline for door hosting
  }

  // --- Columns ---
  let columnCount = 0
  for (const c of columnInserts) {
    const dims = parseColumnDims(c.name)
    const [x, z] = MX(c.pos)
    const props: any = {
      object: 'node',
      type: 'column',
      parentId: level.id,
      position: [x, 0, z],
      rotation: -c.rotation, // plan CCW about Z -> world about Y (flipped with Y)
      height: opts.levelHeight,
      crossSection: dims.crossSection,
      width: dims.width / 1000,
      depth: dims.depth / 1000,
    }
    if (dims.radius) props.radius = dims.radius / 1000
    const node = ColumnNode.parse(props) as any
    nodes[node.id] = node
    level.children.push(node.id)
    columnCount++
  }

  // --- Doors: host to nearest wall centreline within threshold ---
  let doorCount = 0
  const HOST_THRESHOLD = 2000 // mm
  for (const d of doorInserts) {
    const dims = parseDoorDims(d.name)
    let bestWall: any = null
    let bestDist = Infinity
    let bestU = 0
    for (const w of wallNodes) {
      const dir = unit(sub(w.end, w.start))
      const gap = perpDistance(d.pos, w.start, w.end)
      const u = projectParam(d.pos, w.start, dir)
      const wl = len(sub(w.end, w.start))
      if (u < 0 || u > wl) continue
      if (gap < bestDist) {
        bestDist = gap
        bestWall = w
        bestU = u
      }
    }
    if (!bestWall || bestDist > HOST_THRESHOLD) {
      warnings.push(`Door "${d.name.slice(0, 24)}" not near any wall; skipped`)
      continue
    }
    const node = DoorNode.parse({
      object: 'node',
      type: 'door',
      parentId: bestWall.node.id,
      wallId: bestWall.node.id,
      position: [bestU / 1000, dims.height / 1000 / 2, 0],
      width: dims.width / 1000,
      height: dims.height / 1000,
      doorType: dims.doorType,
      leafCount: dims.leafCount,
    }) as any
    nodes[node.id] = node
    bestWall.node.children.push(node.id)
    doorCount++
  }

  // --- Floor slab: convex hull of wall endpoints ---
  const hullPts = convexHull(wallSegs.flatMap((s) => [s.a, s.b]))
  if (hullPts.length >= 3) {
    const slab = SlabNode.parse({
      object: 'node',
      type: 'slab',
      name: 'Floor',
      parentId: level.id,
      polygon: hullPts.map((p) => MX(p)),
      elevation: 0.05,
      thickness: 0.2,
    }) as any
    nodes[slab.id] = slab
    level.children.push(slab.id)
  }

  return {
    nodes,
    rootNodeIds: [site.id],
    stats: {
      walls: wallNodes.length,
      pairedWalls: wallSpecs.filter((w) => w.thickness !== opts.singleFaceThicknessMm).length,
      columns: columnCount,
      doors: doorCount,
      rawWallLines: wallSegs.length,
      rawColumnInserts: columnInserts.length,
      rawDoorInserts: doorInserts.length,
      warnings,
    },
  }
}
