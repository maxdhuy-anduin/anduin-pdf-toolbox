/** Rotation helpers: pages are rotated with a CSS transform, so pointer maths must undo it. */

/** Pointer position → px inside `el`'s own (unrotated) box. */
export function screenToLocal(clientX: number, clientY: number, el: HTMLElement, rotation: number) {
  const r = el.getBoundingClientRect()
  const dx = clientX - (r.left + r.width / 2)
  const dy = clientY - (r.top + r.height / 2)
  const { x, y } = rotateDelta(dx, dy, rotation)
  return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 }
}

/** Screen-space delta → delta in the unrotated local frame. */
export function rotateDelta(dx: number, dy: number, rotation: number) {
  const t = (rotation * Math.PI) / 180
  const c = Math.round(Math.cos(t))
  const s = Math.round(Math.sin(t))
  return { x: dx * c + dy * s, y: -dx * s + dy * c }
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const hex2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')
export const rgbToHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`

/**
 * Looks at a region of a rendered page canvas and estimates the background colour
 * (median of a ring just outside the region) and the text colour (the pixel inside
 * that differs most from the background).
 */
export function sampleColors(
  canvas: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
): { bg: string; fg: string } {
  const fallback = { bg: '#ffffff', fg: '#000000' }
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return fallback
    const pad = 3
    const x0 = clamp(Math.floor(rect.x) - pad, 0, canvas.width - 1)
    const y0 = clamp(Math.floor(rect.y) - pad, 0, canvas.height - 1)
    const x1 = clamp(Math.ceil(rect.x + rect.w) + pad, x0 + 1, canvas.width)
    const y1 = clamp(Math.ceil(rect.y + rect.h) + pad, y0 + 1, canvas.height)
    const w = x1 - x0
    const h = y1 - y0
    const data = ctx.getImageData(x0, y0, w, h).data
    const inner = { l: rect.x - x0, t: rect.y - y0, r: rect.x + rect.w - x0, b: rect.y + rect.h - y0 }
    const ring: number[][] = []
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const outside = x < inner.l - 0.5 || x >= inner.r + 0.5 || y < inner.t - 0.5 || y >= inner.b + 0.5
        if (outside) {
          const i = (y * w + x) * 4
          ring.push([data[i], data[i + 1], data[i + 2]])
        }
      }
    }
    if (!ring.length) return fallback
    const med = (k: number) => ring.map((p) => p[k]).sort((a, b) => a - b)[Math.floor(ring.length / 2)]
    const bg = [med(0), med(1), med(2)]
    let best = -1
    let fg = [0, 0, 0]
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (x < inner.l || x >= inner.r || y < inner.t || y >= inner.b) continue
        const i = (y * w + x) * 4
        const d = (data[i] - bg[0]) ** 2 + (data[i + 1] - bg[1]) ** 2 + (data[i + 2] - bg[2]) ** 2
        if (d > best) {
          best = d
          fg = [data[i], data[i + 1], data[i + 2]]
        }
      }
    }
    // Nothing distinguishable from the background: default to black text.
    const text = best < 40 * 40 ? [0, 0, 0] : fg
    return { bg: rgbToHex(bg[0], bg[1], bg[2]), fg: rgbToHex(text[0], text[1], text[2]) }
  } catch {
    return fallback
  }
}
