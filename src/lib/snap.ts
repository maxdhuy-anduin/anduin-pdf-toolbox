// Smart guides while moving objects (like Acrobat / Figma): the dragged selection snaps to
//  · the page centre and edges, and the page margins,
//  · the left / centre / right (top / middle / bottom) of other objects,
//  · equal spacing: the same gap on both sides (between two neighbours, or to the page edges) or
//    the same gap as between the neighbour and its own neighbour (a regular stack or row).
// Pure geometry in view space (points); the caller converts its threshold from screen pixels.

import type { Box } from './content/types'

export interface AlignGuide {
  kind: 'align'
  axis: 'x' | 'y'
  /** Position of the guide line (x for a vertical line, y for a horizontal one). */
  at: number
  /** Extent along the line. */
  from: number
  to: number
}

export interface GapGuide {
  kind: 'gap'
  axis: 'x' | 'y'
  /** Gap segments of equal length: [start, end] along the axis, drawn at `cross` on the other axis. */
  segments: { a: number; b: number; cross: number }[]
  value: number
}

export type Guide = AlignGuide | GapGuide

export interface SnapResult {
  dx: number
  dy: number
  guides: Guide[]
}

interface Cand {
  delta: number
  guides: () => Guide[]
}

const overlapY = (a: Box, b: Box) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0
const overlapX = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0

/** Projections of a box on one axis. */
const lo = (b: Box, ax: 'x' | 'y') => (ax === 'x' ? b.x : b.y)
const size = (b: Box, ax: 'x' | 'y') => (ax === 'x' ? b.w : b.h)
const hi = (b: Box, ax: 'x' | 'y') => lo(b, ax) + size(b, ax)
const mid = (b: Box, ax: 'x' | 'y') => lo(b, ax) + size(b, ax) / 2
const shift = (b: Box, ax: 'x' | 'y', d: number): Box => (ax === 'x' ? { ...b, x: b.x + d } : { ...b, y: b.y + d })

function axisCandidates(m: Box, others: Box[], page: { w: number; h: number }, margins: Box | null, ax: 'x' | 'y', tol: number): Cand[] {
  const out: Cand[] = []
  const other: 'x' | 'y' = ax === 'x' ? 'y' : 'x'
  const pageLen = ax === 'x' ? page.w : page.h
  const pageCross = ax === 'x' ? page.h : page.w
  const mine = [lo(m, ax), mid(m, ax), hi(m, ax)]

  // alignment with other objects
  for (const o of others) {
    for (const t of [lo(o, ax), mid(o, ax), hi(o, ax)]) {
      for (const v of mine) {
        const d = t - v
        if (Math.abs(d) > tol) continue
        out.push({
          delta: d,
          guides: () => {
            const n = shift(m, ax, d)
            return [{ kind: 'align', axis: ax, at: t, from: Math.min(lo(n, other), lo(o, other)), to: Math.max(hi(n, other), hi(o, other)) }]
          },
        })
      }
    }
  }
  // page centre / edges and margins
  const targets: number[] = [0, pageLen / 2, pageLen]
  if (margins) targets.push(lo(margins, ax), mid(margins, ax), hi(margins, ax))
  for (const t of targets) {
    for (const v of mine) {
      const d = t - v
      if (Math.abs(d) > tol) continue
      out.push({ delta: d, guides: () => [{ kind: 'align', axis: ax, at: t, from: 0, to: pageCross }] })
    }
  }

  // equal spacing with the neighbours in the same row (x) / column (y)
  const inLine = others.filter((o) => (ax === 'x' ? overlapY(o, m) : overlapX(o, m)))
  const before = inLine.filter((o) => hi(o, ax) <= lo(m, ax) + tol).sort((a, b) => hi(b, ax) - hi(a, ax))
  const after = inLine.filter((o) => lo(o, ax) >= hi(m, ax) - tol).sort((a, b) => lo(a, ax) - lo(b, ax))
  const crossOf = (a: Box, b: Box) => {
    const s = Math.max(lo(a, other), lo(b, other))
    const e = Math.min(hi(a, other), hi(b, other))
    return e > s ? (s + e) / 2 : (mid(a, other) + mid(b, other)) / 2
  }
  const A = before[0]
  const B = after[0]
  if (A && B) {
    // centred between the two neighbours
    const start = (hi(A, ax) + lo(B, ax) - size(m, ax)) / 2
    const d = start - lo(m, ax)
    if (Math.abs(d) <= tol && start > hi(A, ax)) {
      out.push({
        delta: d,
        guides: () => {
          const n = shift(m, ax, d)
          const g = lo(n, ax) - hi(A, ax)
          return [{ kind: 'gap', axis: ax, value: g, segments: [{ a: hi(A, ax), b: lo(n, ax), cross: crossOf(A, n) }, { a: hi(n, ax), b: lo(B, ax), cross: crossOf(n, B) }] }]
        },
      })
    }
  }
  // same gap as the neighbour's own gap (regular rows / stacks)
  const A2 = A ? inLine.filter((o) => o !== A && hi(o, ax) <= lo(A, ax) + 0.5 && (ax === 'x' ? overlapY(o, A) : overlapX(o, A))).sort((a, b) => hi(b, ax) - hi(a, ax))[0] : undefined
  if (A && A2) {
    const g = lo(A, ax) - hi(A2, ax)
    const d = hi(A, ax) + g - lo(m, ax)
    if (g > 0 && Math.abs(d) <= tol) {
      out.push({
        delta: d,
        guides: () => {
          const n = shift(m, ax, d)
          return [{ kind: 'gap', axis: ax, value: g, segments: [{ a: hi(A2, ax), b: lo(A, ax), cross: crossOf(A2, A) }, { a: hi(A, ax), b: lo(n, ax), cross: crossOf(A, n) }] }]
        },
      })
    }
  }
  const B2 = B ? inLine.filter((o) => o !== B && lo(o, ax) >= hi(B, ax) - 0.5 && (ax === 'x' ? overlapY(o, B) : overlapX(o, B))).sort((a, b) => lo(a, ax) - lo(b, ax))[0] : undefined
  if (B && B2) {
    const g = lo(B2, ax) - hi(B, ax)
    const d = lo(B, ax) - g - hi(m, ax)
    if (g > 0 && Math.abs(d) <= tol) {
      out.push({
        delta: d,
        guides: () => {
          const n = shift(m, ax, d)
          return [{ kind: 'gap', axis: ax, value: g, segments: [{ a: hi(n, ax), b: lo(B, ax), cross: crossOf(n, B) }, { a: hi(B, ax), b: lo(B2, ax), cross: crossOf(B, B2) }] }]
        },
      })
    }
  }
  // balanced between the page edges (or the margins) when nothing is in the way
  const spans: [number, number][] = [[0, pageLen]]
  // the margins' own balance, unless it's the same position as the page's (one set of markers)
  if (margins && Math.abs(mid(margins, ax) - pageLen / 2) > 0.5) spans.push([lo(margins, ax), hi(margins, ax)])
  for (const [a, b] of spans) {
    const start = (a + b - size(m, ax)) / 2
    const d = start - lo(m, ax)
    if (Math.abs(d) > tol || start < a) continue
    out.push({
      delta: d,
      guides: () => {
        const n = shift(m, ax, d)
        const c = mid(n, other)
        return [{ kind: 'gap', axis: ax, value: lo(n, ax) - a, segments: [{ a, b: lo(n, ax), cross: c }, { a: hi(n, ax), b, cross: c }] }]
      },
    })
  }
  return out
}

/**
 * Snaps the moving box `m` (already at its proposed position). Returns the correction to add to
 * the drag and the guides to draw. Gap guides win over alignment at equal distance.
 */
export function snapBox(m: Box, others: Box[], page: { w: number; h: number }, margins: Box | null, tol: number): SnapResult {
  const pick = (ax: 'x' | 'y') => {
    const cands = axisCandidates(m, others, page, margins, ax, tol)
    if (!cands.length) return { delta: 0, guides: [] as Guide[] }
    const d = cands.reduce((a, c) => (Math.abs(c.delta) < Math.abs(a.delta) ? c : a)).delta
    // every guide that holds at the snapped position, within half a point (measured boxes are not exact)
    const chosen = cands.filter((c) => Math.abs(c.delta - d) <= 0.5)
    const guides: Guide[] = []
    const seen = new Set<string>()
    for (const c of chosen) {
      for (const g of c.guides()) {
        const k = g.kind === 'align' ? `a${g.axis}${g.at.toFixed(1)}` : `g${g.axis}${g.segments.map((s) => s.a.toFixed(1)).join(',')}`
        if (seen.has(k)) continue
        seen.add(k)
        guides.push(g)
      }
    }
    return { delta: d, guides }
  }
  const x = pick('x')
  const y = pick('y')
  // alignment guides span the final position on both axes
  return { dx: x.delta, dy: y.delta, guides: [...x.guides, ...y.guides] }
}
