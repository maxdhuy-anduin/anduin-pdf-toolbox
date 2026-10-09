import type { PageInfo } from './model'

// ---------------------------------------------------------------------------------------------
// Coordinate systems. Every conversion in the app goes through this file.
//
//  PDF user space       points, origin bottom-left of the page's coordinate system, y up, unrotated
//                       (content streams, pdf-lib, Adobe Extract `Bounds`)
//  canonical page space points, origin top-left of the visible page box (crop ∩ media), y down, with
//    ("canvas space")   the page's intrinsic /Rotate applied; independent of zoom and of rotation added
//                       in the app. All LayoutChunk / ContentObject bounds and overlays live here.
//  screen space         CSS pixels inside a page element: canonical × zoom, then the app rotation
//                       (a CSS rotation about the page centre)
// ---------------------------------------------------------------------------------------------

export interface Pt {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Canonical page space → PDF user space. Also returns the angle a horizontal baseline has in user space. */
export function viewToUser(info: PageInfo, vx: number, vy: number): { x: number; y: number; angle: number } {
  const [x0, y0, x1, y1] = info.view
  const uw = x1 - x0
  const uh = y1 - y0
  switch (info.rotate) {
    case 90:
      return { x: x0 + vy, y: y0 + vx, angle: 90 }
    case 180:
      return { x: x0 + uw - vx, y: y0 + vy, angle: 180 }
    case 270:
      return { x: x0 + uw - vy, y: y0 + uh - vx, angle: 270 }
    default:
      return { x: x0 + vx, y: y0 + uh - vy, angle: 0 }
  }
}

/** Canonical page space → PDF user space. */
export function canvasToPdf(info: PageInfo, p: Pt): Pt {
  const u = viewToUser(info, p.x, p.y)
  return { x: u.x, y: u.y }
}

/** PDF user space → canonical page space (inverse of canvasToPdf). */
export function pdfToCanvas(info: PageInfo, p: Pt): Pt {
  const [x0, y0, x1, y1] = info.view
  const uw = x1 - x0
  const uh = y1 - y0
  switch (info.rotate) {
    case 90:
      return { x: p.y - y0, y: p.x - x0 }
    case 180:
      return { x: x0 + uw - p.x, y: p.y - y0 }
    case 270:
      return { x: y0 + uh - p.y, y: x0 + uw - p.x }
    default:
      return { x: p.x - x0, y: y0 + uh - p.y }
  }
}

/** PDF user-space rectangle given as [left, bottom, right, top] → canonical rectangle. */
export function pdfRectToCanvas(info: PageInfo, r: [number, number, number, number]): Rect {
  const a = pdfToCanvas(info, { x: r[0], y: r[1] })
  const b = pdfToCanvas(info, { x: r[2], y: r[3] })
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** Canonical rectangle → PDF user-space rectangle (x, y = bottom-left corner). */
export function canvasRectToPdf(info: PageInfo, r: Rect): Rect {
  const a = canvasToPdf(info, { x: r.x, y: r.y })
  const b = canvasToPdf(info, { x: r.x + r.width, y: r.y + r.height })
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** Axis-aligned rectangle (canonical) → rectangle in user space ({x, y, w, h}). */
export function viewRectToUser(info: PageInfo, x: number, y: number, w: number, h: number) {
  const r = canvasRectToPdf(info, { x, y, width: w, height: h })
  return { x: r.x, y: r.y, w: r.width, h: r.height }
}

/** How a page is currently displayed: zoom, app rotation (clockwise) and its canonical size. */
export interface ScreenView {
  scale: number
  rotation: number
  width: number
  height: number
}

/** Canonical point → CSS px inside the (rotated) page element. */
export function canvasToScreen(p: Pt, v: ScreenView): Pt {
  const px = p.x * v.scale
  const py = p.y * v.scale
  const w = v.width * v.scale
  const h = v.height * v.scale
  switch (((v.rotation % 360) + 360) % 360) {
    case 90:
      return { x: h - py, y: px }
    case 180:
      return { x: w - px, y: h - py }
    case 270:
      return { x: py, y: w - px }
    default:
      return { x: px, y: py }
  }
}

/** CSS px inside the (rotated) page element → canonical point (inverse of canvasToScreen). */
export function screenToCanvas(s: Pt, v: ScreenView): Pt {
  const w = v.width * v.scale
  const h = v.height * v.scale
  let px: number
  let py: number
  switch (((v.rotation % 360) + 360) % 360) {
    case 90:
      px = s.y
      py = h - s.x
      break
    case 180:
      px = w - s.x
      py = h - s.y
      break
    case 270:
      px = w - s.y
      py = s.x
      break
    default:
      px = s.x
      py = s.y
  }
  return { x: px / v.scale, y: py / v.scale }
}

/** Pointer event → canonical point, given the page's outer (rotated) element. */
export function clientToCanvas(clientX: number, clientY: number, pageEl: HTMLElement, v: ScreenView): Pt {
  const r = pageEl.getBoundingClientRect()
  return screenToCanvas({ x: clientX - r.left, y: clientY - r.top }, v)
}

/** Where the baseline sits inside a CSS line box of height 1.2em, per font family. */
export const BASELINE_RATIO = {
  Helvetica: 0.9465,
  Times: 0.9375,
  Courier: 0.8665,
  // 0.6 + (ascent - descent) / 2, from each font's hhea metrics (what browsers use for the line box)
  Calibri: 0.9418,
  Cambria: 0.925,
  Georgia: 0.893,
  Garamond: 0.9545,
  OpenSans: 0.9879,
  Roboto: 0.9418,
  Lato: 0.987,
} as const
