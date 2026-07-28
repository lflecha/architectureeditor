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
  WindowNode,
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
const isWindowLayer = (l: string) => /-M_WINDOW\b/i.test(l)

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

// Dimensions live in the middle " - " segment of the block name (e.g.
// "... - 1500_w_x400_d_mm-12468747-L27 - EAST_PHASE 1"), NOT the last one — so
// scan the whole name. Widths are tagged `_w` (a door may list several, e.g.
// "920_920_w"), heights `_h`, column depths `_d`. The negative lookahead stops
// a tag from matching mid-word.

/** Millimetre width(s) immediately before an `_w` tag, e.g. "920_920_w" → [920,920]. */
function parseWidthsMm(name: string): number[] {
  const m = name.match(/(\d{2,5}(?:_\d{2,5})*)_w(?![a-z0-9])/i)
  if (!m) return []
  return m[1].split('_').map(Number).filter((n) => n >= 10)
}

/** Millimetre value before an `_<tag>` (h = height, d = depth). */
function parseTagMm(name: string, tag: 'h' | 'd'): number | undefined {
  const m = name.match(new RegExp(`(\\d{2,5})_${tag}(?![a-z0-9])`, 'i'))
  return m ? Number(m[1]) : undefined
}

/** Column: "..._Rectangular_Concrete - 1500_w_x400_d_mm..." or "..._Round_... 900mm". */
function parseColumnDims(name: string): {
  crossSection: 'rectangular' | 'round'
  width: number
  depth: number
  radius?: number
} {
  if (/round|diamater|diameter/i.test(name)) {
    const dia = parseWidthsMm(name)[0] ?? parseTagMm(name, 'd') ?? 440
    return { crossSection: 'round', width: dia, depth: dia, radius: dia / 2 }
  }
  const width = parseWidthsMm(name)[0] ?? 440
  const depth = parseTagMm(name, 'd') ?? width
  return { crossSection: 'rectangular', width, depth }
}

/** Door: "..._Swing_Sgl1 - Door_Entry_920_w_x2340_h_..." / "..._Sliding_..._2Panel_XO - 3000_w_ x 2700_h_". */
function parseDoorDims(name: string): {
  width: number
  height: number
  doorType: 'hinged' | 'double' | 'sliding'
  leafCount: 1 | 2 | 3 | 4
} {
  const widths = parseWidthsMm(name)
  const width = widths.length ? widths.reduce((a, b) => a + b, 0) : 900
  const height = parseTagMm(name, 'h') ?? 2100
  const sliding = /sliding/i.test(name)
  const dbl = /_dbl\b|double/i.test(name) || widths.length >= 2
  const doorType = sliding ? 'sliding' : dbl ? 'double' : 'hinged'
  const leafCount = (widths.length >= 4 ? 4 : widths.length >= 2 ? 2 : 1) as 1 | 2 | 4
  return { width, height, doorType, leafCount }
}

/** Window: "..._Awning_DblRow_AO - 1500_w_x2550_h_..." / "..._Sliding_XO - 1500_w_ x 1900_h_". */
function parseWindowDims(name: string): {
  width: number
  height: number
  windowType: 'fixed' | 'sliding' | 'casement' | 'awning' | 'hopper' | 'double-hung'
} {
  const width = parseWidthsMm(name)[0] ?? 1500
  const height = parseTagMm(name, 'h') ?? 1500
  const windowType = /awning/i.test(name)
    ? 'awning'
    : /sliding/i.test(name)
      ? 'sliding'
      : /casement/i.test(name)
        ? 'casement'
        : /hopper/i.test(name)
          ? 'hopper'
          : /hung/i.test(name)
            ? 'double-hung'
            : 'fixed'
  return { width, height, windowType }
}

// ---------------------------------------------------------------------------
// Wall reconstruction: pair parallel face-lines into centreline + thickness
// ---------------------------------------------------------------------------

interface WallSeg {
  start: Pt
  end: Pt
  thickness: number
}

/**
 * Weld collinear face-lines into continuous runs.
 *
 * CAD walls are drawn as many short LINE entities, broken at every door,
 * window, junction and dimension tick. Left un-merged they inflate the wall
 * count by 4–8× and pair badly. This groups segments that lie on the same
 * infinite line (same direction ±2°, same perpendicular offset ±8 mm) and
 * unions their extents along that line, bridging only hairline numeric gaps
 * (≤25 mm) so real openings stay open.
 */
function mergeCollinear(segs: Seg[]): Seg[] {
  const ANGLE_EPS = Math.sin((2 * Math.PI) / 180)
  const OFFSET_EPS = 8 // mm perpendicular
  const WELD_GAP = 25 // mm — welds split lines, never bridges a door opening

  interface Group {
    dir: Pt // canonical (rightward/upward) unit direction
    ref: Pt // a point on the line
    perp: Pt // unit normal
    items: { lo: number; hi: number; off: number }[]
  }
  const groups: Group[] = []

  for (const s of segs) {
    const d = unit(sub(s.b, s.a))
    // Canonicalise direction so a→b and b→a land in the same group.
    const cd = d.x < 0 || (d.x === 0 && d.y < 0) ? { x: -d.x, y: -d.y } : d
    const perp = { x: -cd.y, y: cd.x }
    let g = groups.find(
      (g) =>
        Math.abs(cross(g.dir, cd)) <= ANGLE_EPS &&
        Math.abs(dot(sub(s.a, g.ref), g.perp)) <= OFFSET_EPS,
    )
    if (!g) {
      g = { dir: cd, ref: s.a, perp, items: [] }
      groups.push(g)
    }
    const ta = projectParam(s.a, g.ref, g.dir)
    const tb = projectParam(s.b, g.ref, g.dir)
    const off = (dot(sub(s.a, g.ref), g.perp) + dot(sub(s.b, g.ref), g.perp)) / 2
    g.items.push({ lo: Math.min(ta, tb), hi: Math.max(ta, tb), off })
  }

  const out: Seg[] = []
  for (const g of groups) {
    g.items.sort((a, b) => a.lo - b.lo)
    let lo = g.items[0].lo
    let hi = g.items[0].hi
    let offSum = g.items[0].off
    let offN = 1
    const flush = () => {
      const off = offSum / offN
      const a = {
        x: g.ref.x + g.dir.x * lo + g.perp.x * off,
        y: g.ref.y + g.dir.y * lo + g.perp.y * off,
      }
      const b = {
        x: g.ref.x + g.dir.x * hi + g.perp.x * off,
        y: g.ref.y + g.dir.y * hi + g.perp.y * off,
      }
      out.push({ a, b, layer: '' })
    }
    for (let k = 1; k < g.items.length; k++) {
      const iv = g.items[k]
      if (iv.lo <= hi + WELD_GAP) {
        hi = Math.max(hi, iv.hi)
        offSum += iv.off
        offN++
      } else {
        flush()
        lo = iv.lo
        hi = iv.hi
        offSum = iv.off
        offN = 1
      }
    }
    flush()
  }
  return out
}

function buildWalls(rawSegs: Seg[], opts: Required<ConvertOptions>): WallSeg[] {
  const segs = mergeCollinear(rawSegs)
  const minT = opts.minWallThicknessMm
  const maxT = opts.maxWallThicknessMm
  const used = new Array(segs.length).fill(false)
  const walls: WallSeg[] = []
  const ANGLE_EPS = Math.sin((5 * Math.PI) / 180) // ~5 degrees
  const MIN_OVERLAP = 150 // mm
  const MIN_LEN = 150
  const MAX_LEN = 60000
  // Unpaired lines only become single-face walls above this length. A wall
  // with no matching second face is usually a façade/partition drawn single-
  // line; anything shorter is almost always a jamb, tick or fragment.
  const SINGLE_FACE_MIN_LEN = 600

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
      // unpaired: emit as a single-face wall only if plausibly a wall run
      if (li >= SINGLE_FACE_MIN_LEN && li <= MAX_LEN) {
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
  const windowInserts: Insert[] = []
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
      else if (isWindowLayer(layer)) windowInserts.push(ins)
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

  // Host an opening (door/window) at DWG position `pos` to the nearest wall
  // centreline. Returns the wall node and the along-wall offset `u` (mm),
  // clamped so a `widthMm`-wide opening sits fully within the wall run instead
  // of hanging off the end (walls are drawn broken at each opening, so the
  // insertion point often lands near a stub's end).
  const HOST_THRESHOLD = 2000 // mm perpendicular
  const findHost = (pos: Pt, widthMm: number): { wall: any; u: number } | null => {
    const halfW = widthMm / 2
    let bestWall: any = null
    let bestDist = Infinity
    let bestU = 0
    let bestWl = 0
    for (const w of wallNodes) {
      const dir = unit(sub(w.end, w.start))
      const wl = len(sub(w.end, w.start))
      const u = projectParam(pos, w.start, dir)
      if (u < -halfW || u > wl + halfW) continue
      const gap = perpDistance(pos, w.start, w.end)
      if (gap < bestDist) {
        bestDist = gap
        bestWall = w
        bestU = u
        bestWl = wl
      }
    }
    if (!bestWall || bestDist > HOST_THRESHOLD) return null
    const u = bestWl >= widthMm ? Math.min(Math.max(bestU, halfW), bestWl - halfW) : bestWl / 2
    return { wall: bestWall, u }
  }

  // --- Doors: host to nearest wall centreline, sit on the floor ---
  let doorCount = 0
  for (const d of doorInserts) {
    const dims = parseDoorDims(d.name)
    const host = findHost(d.pos, dims.width)
    if (!host) {
      warnings.push(`Door "${d.name.slice(0, 24)}" not near any wall; skipped`)
      continue
    }
    const node = DoorNode.parse({
      object: 'node',
      type: 'door',
      parentId: host.wall.node.id,
      wallId: host.wall.node.id,
      position: [host.u / 1000, dims.height / 1000 / 2, 0],
      width: dims.width / 1000,
      height: dims.height / 1000,
      doorType: dims.doorType,
      leafCount: dims.leafCount,
    }) as any
    nodes[node.id] = node
    host.wall.node.children.push(node.id)
    doorCount++
  }

  // --- Windows: host to nearest wall; derive a sill so the head clears the
  // ceiling. Tall units (awning/curtain-wall glazing) drop to a low sill. ---
  let windowCount = 0
  for (const wi of windowInserts) {
    const dims = parseWindowDims(wi.name)
    const host = findHost(wi.pos, dims.width)
    if (!host) {
      warnings.push(`Window "${wi.name.slice(0, 24)}" not near any wall; skipped`)
      continue
    }
    const heightM = dims.height / 1000
    const levelM = opts.levelHeight
    // Bottom of glass: keep a normal ~0.9 m sill where it fits, else drop it so
    // the head stays under the slab (floor-to-ceiling glazing → sill ≈ 0).
    const sill = Math.max(0, Math.min(0.9, levelM - heightM - 0.1))
    const node = WindowNode.parse({
      object: 'node',
      type: 'window',
      parentId: host.wall.node.id,
      wallId: host.wall.node.id,
      position: [host.u / 1000, sill + heightM / 2, 0],
      width: dims.width / 1000,
      height: heightM,
      windowType: dims.windowType,
    }) as any
    nodes[node.id] = node
    host.wall.node.children.push(node.id)
    windowCount++
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
      windows: windowCount,
      rawWallLines: wallSegs.length,
      rawColumnInserts: columnInserts.length,
      rawDoorInserts: doorInserts.length,
      rawWindowInserts: windowInserts.length,
      warnings,
    },
  }
}
