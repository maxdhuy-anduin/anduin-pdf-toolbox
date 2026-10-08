import type { PageInfo } from './model'

/**
 * Converts a point from "page view space" (points, y-down, origin = top-left of the
 * page as displayed with only the page's intrinsic /Rotate applied) into PDF user
 * space (y-up). Also returns the angle the text baseline has in user space.
 */
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

/** Axis-aligned rectangle (view space) → rectangle in user space. */
export function viewRectToUser(info: PageInfo, x: number, y: number, w: number, h: number) {
  const a = viewToUser(info, x, y)
  const b = viewToUser(info, x + w, y + h)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/** Where the baseline sits inside a CSS line box of height 1.2em, per font family. */
export const BASELINE_RATIO = { Helvetica: 0.9465, Times: 0.9375, Courier: 0.8665 } as const
