// Geometry of the shapes and arrowheads drawn by the user. The same SVG path is drawn on screen and
// written to the PDF (pdf-lib drawSvgPath), so what you see is what you export. Paths use only
// M / L / C / Z and are in local coordinates: (0, 0) top-left of the shape's box, y down, points.

import { arrowHeadSize, type LineOverlay, type ShapeKind } from './model'

const K = 0.5522847498 // cubic Bézier approximation of a quarter circle

const n = (v: number) => (Math.round(v * 1000) / 1000).toString()
const poly = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} Z`

function ellipse(w: number, h: number) {
  const rx = w / 2
  const ry = h / 2
  const cx = rx
  const cy = ry
  return [
    `M${n(cx + rx)} ${n(cy)}`,
    `C${n(cx + rx)} ${n(cy + K * ry)} ${n(cx + K * rx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)}`,
    `C${n(cx - K * rx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + K * ry)} ${n(cx - rx)} ${n(cy)}`,
    `C${n(cx - rx)} ${n(cy - K * ry)} ${n(cx - K * rx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)}`,
    `C${n(cx + K * rx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - K * ry)} ${n(cx + rx)} ${n(cy)} Z`,
  ].join(' ')
}

function rounded(w: number, h: number) {
  const r = Math.min(w, h) * 0.18
  const c = r * (1 - K)
  return [
    `M${n(r)} 0 L${n(w - r)} 0`,
    `C${n(w - c)} 0 ${n(w)} ${n(c)} ${n(w)} ${n(r)}`,
    `L${n(w)} ${n(h - r)}`,
    `C${n(w)} ${n(h - c)} ${n(w - c)} ${n(h)} ${n(w - r)} ${n(h)}`,
    `L${n(r)} ${n(h)}`,
    `C${n(c)} ${n(h)} 0 ${n(h - c)} 0 ${n(h - r)}`,
    `L0 ${n(r)}`,
    `C0 ${n(c)} ${n(c)} 0 ${n(r)} 0 Z`,
  ].join(' ')
}

/** Regular polygon / star inscribed in the box (first vertex at the top). */
function radial(w: number, h: number, count: number, inner?: number) {
  const pts: [number, number][] = []
  const steps = inner ? count * 2 : count
  for (let i = 0; i < steps; i += 1) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / steps
    const r = inner && i % 2 ? inner : 1
    pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)])
  }
  // stretch so the polygon touches the top and bottom of the box
  const ys = pts.map((p) => p[1])
  const y0 = Math.min(...ys)
  const y1 = Math.max(...ys)
  return pts.map(([x, y]) => [x, ((y - y0) / (y1 - y0 || 1)) * h] as [number, number])
}

export function shapePath(kind: ShapeKind, w: number, h: number): string {
  switch (kind) {
    case 'rect':
      return poly([[0, 0], [w, 0], [w, h], [0, h]])
    case 'rounded':
      return rounded(w, h)
    case 'ellipse':
      return ellipse(w, h)
    case 'triangle':
      return poly([[w / 2, 0], [w, h], [0, h]])
    case 'diamond':
      return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])
    case 'pentagon':
      return poly(radial(w, h, 5))
    case 'hexagon':
      return poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]])
    case 'star':
      return poly(radial(w, h, 5, 0.42))
    case 'arrow': {
      const head = Math.min(w * 0.45, h * 0.9)
      return poly([[0, h * 0.3], [w - head, h * 0.3], [w - head, 0], [w, h / 2], [w - head, h], [w - head, h * 0.7], [0, h * 0.7]])
    }
    case 'check':
      return `M${n(w * 0.06)} ${n(h * 0.55)} L${n(w * 0.38)} ${n(h * 0.9)} L${n(w * 0.94)} ${n(h * 0.1)}`
    case 'cross':
      return `M${n(w * 0.1)} ${n(h * 0.1)} L${n(w * 0.9)} ${n(h * 0.9)} M${n(w * 0.9)} ${n(h * 0.1)} L${n(w * 0.1)} ${n(h * 0.9)}`
  }
}

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  rounded: 'Rounded rectangle',
  ellipse: 'Ellipse / circle',
  triangle: 'Triangle',
  diamond: 'Diamond',
  pentagon: 'Pentagon',
  hexagon: 'Hexagon',
  star: 'Star',
  arrow: 'Arrow',
  check: 'Check mark',
  cross: 'Cross mark',
}

export const DASH = (dash: 'solid' | 'dashed' | 'dotted', t: number): number[] | undefined =>
  dash === 'dashed' ? [4 * t, 3 * t] : dash === 'dotted' ? [0, 2.5 * t] : undefined

/**
 * A drawn line with its arrowheads: the shaft is shortened so its butt end doesn't poke
 * through the tip; each head is a filled triangle (absolute view-space coordinates).
 */
export function lineGeometry(l: Pick<LineOverlay, 'x1' | 'y1' | 'x2' | 'y2' | 'thickness' | 'arrow'>) {
  const dx = l.x2 - l.x1
  const dy = l.y2 - l.y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const { len: hl, half } = arrowHeadSize(l.thickness)
  const a = l.arrow ?? 'none'
  const atStart = a === 'start' || a === 'both'
  const atEnd = a === 'end' || a === 'both'
  const cut = Math.min(hl * 0.8, len / (atStart && atEnd ? 2 : 1))
  const head = (tx: number, ty: number, dirx: number, diry: number): [number, number][] => {
    const bx = tx - dirx * hl
    const by = ty - diry * hl
    return [[tx, ty], [bx - diry * half, by + dirx * half], [bx + diry * half, by - dirx * half]]
  }
  return {
    shaft: {
      x1: atStart ? l.x1 + ux * cut : l.x1,
      y1: atStart ? l.y1 + uy * cut : l.y1,
      x2: atEnd ? l.x2 - ux * cut : l.x2,
      y2: atEnd ? l.y2 - uy * cut : l.y2,
    },
    heads: [...(atStart ? [head(l.x1, l.y1, -ux, -uy)] : []), ...(atEnd ? [head(l.x2, l.y2, ux, uy)] : [])],
  }
}
