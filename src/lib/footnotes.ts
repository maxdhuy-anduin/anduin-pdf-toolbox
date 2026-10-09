// Footnotes: a superscript number in the text (a small marker box placed after a word of the PDF,
// or a superscript character typed into a text box) and the note itself at the bottom of the page,
// under a short separator rule, like Word. Notes are ordinary text boxes (marked `footnote: n`), so
// they can be moved, restyled, searched and exported like any other text.

import { BASELINE_RATIO } from './coords'
import type { ContentObject, PageContent } from './content/types'
import { detectMargins, type Margins } from './margins'
import { isLine, isMove, isText, makeLineOverlay, makeTextOverlay, type FontFamily, type LineOverlay, type PageInfo, type PageModel, type TextOverlay } from './model'
import { toSuper } from './richText'
import { lineCharRects } from './search'

export interface TextStyleLike {
  fontFamily: FontFamily
  fontSize: number
  color: string
}

/** The PDF text line at a point (with moved objects at their new place), if any. */
function lineAt(page: PageModel, content: PageContent | undefined, x: number, y: number): { line: ContentObject; dx: number; dy: number } | null {
  if (!content) return null
  const moves = new Map(page.overlays.filter(isMove).map((m) => [m.source.objectId, m]))
  const replaced = new Set(page.overlays.flatMap((o) => (!isMove(o) && o.source ? [o.source.objectId] : [])))
  let best: { line: ContentObject; dx: number; dy: number; d: number } | null = null
  for (const l of Object.values(content.objects)) {
    if (l.type !== 'TEXT_LINE' || !l.text?.trim()) continue
    const owner = l.parent ?? ''
    if (replaced.has(owner)) continue
    const mv = moves.get(owner)
    if (mv?.deleted) continue
    const dx = mv?.dx ?? 0
    const dy = mv?.dy ?? 0
    const b = l.bounds
    const inY = y >= b.y + dy - 3 && y <= b.y + b.h + dy + 3
    if (!inY) continue
    const d = x < b.x + dx ? b.x + dx - x : x > b.x + b.w + dx ? x - (b.x + b.w + dx) : 0
    if (d > 24) continue
    if (!best || d < best.d) best = { line: l, dx, dy, d }
  }
  return best
}

/**
 * A footnote marker placed where the user clicked: snapped to the nearest character boundary of the
 * PDF line there, sized like that text, its baseline on the line's baseline.
 */
export function markerAt(page: PageModel, content: PageContent | undefined, x: number, y: number, n: number): TextOverlay {
  const hit = lineAt(page, content, x, y)
  if (!hit) {
    const fs = 11
    return makeTextOverlay(x, y - fs * 0.6, { text: toSuper(String(n)), fontSize: fs, wrap: false, width: 6 })
  }
  const { line, dx, dy } = hit
  const st = line.style
  const family = st?.fontFamily ?? 'Helvetica'
  const fs = st?.fontSize ?? 11
  const rects = lineCharRects(line)
  let bx = line.bounds.x + line.bounds.w
  let bd = Infinity
  for (const r of rects) {
    for (const edge of [r.x, r.x + r.w]) {
      const d = Math.abs(edge + dx - x)
      if (d < bd) {
        bd = d
        bx = edge
      }
    }
  }
  const baseline = (line.firstBaseline ?? line.bounds.y + line.bounds.h * 0.8) + dy
  return makeTextOverlay(bx + dx + 0.3, baseline - fs * BASELINE_RATIO[family], {
    text: toSuper(String(n)),
    fontFamily: family,
    fontSize: fs,
    bold: false,
    italic: false,
    color: st?.color ?? '#000000',
    wrap: false,
    width: 6,
  })
}

/** Where footnotes go: above the running footer, inside the page margins. */
function noteArea(info: PageInfo, content: PageContent | undefined, custom: Margins | null) {
  const m = custom ?? detectMargins(content) ?? { left: 72, right: 72, top: 72, bottom: 72 }
  let floor = info.height - Math.max(24, Math.min(m.bottom, 72) * 0.5)
  for (const o of Object.values(content?.objects ?? {})) if (o.type === 'TEXT_BLOCK' && o.role === 'footer') floor = Math.min(floor, o.bounds.y - 6)
  const left = Math.min(m.left, info.width / 3)
  const width = Math.max(180, info.width - left - Math.min(m.right, info.width / 3))
  return { left, width, floor }
}

/**
 * The note for footnote `n` on `page` (and the separator rule, for the page's first footnote).
 * Notes stack downwards; the first one leaves room for a few more above the footer.
 */
export function planFootnote(
  page: PageModel,
  info: PageInfo,
  content: PageContent | undefined,
  n: number,
  style: TextStyleLike,
  opts: { margins?: Margins | null; heightOf?: (o: TextOverlay) => number } = {},
): { note: TextOverlay; separator: LineOverlay | null } {
  const fs = Math.max(7, Math.round(style.fontSize * 0.8 * 2) / 2)
  const lh = fs * 1.2
  const { left, width, floor } = noteArea(info, content, opts.margins ?? null)
  const notes = page.overlays.filter(isText).filter((o) => o.footnote)
  const height = (o: TextOverlay) => opts.heightOf?.(o) ?? o.fontSize * (o.lineHeight ?? 1.2) * Math.max(1, o.text.split('\n').length)
  let y: number
  if (notes.length) y = Math.max(...notes.map((o) => o.y + height(o))) + 2
  else y = floor - 3 * lh
  y = Math.max(0, Math.min(y, info.height - lh - 4))
  const x = notes.length ? notes[notes.length - 1].x : left
  const note = makeTextOverlay(x, y, {
    text: `${toSuper(String(n))} `,
    fontFamily: style.fontFamily,
    fontSize: fs,
    color: style.color,
    width: notes.length ? notes[notes.length - 1].width : width,
    footnote: n,
  })
  const hasRule = page.overlays.some((o) => isLine(o) && o.role === 'footnote-separator')
  const separator = hasRule ? null : { ...makeLineOverlay(x, y - 4, x + Math.min(144, width / 3), y - 4, { color: '#141414', thickness: 0.5 }), role: 'footnote-separator' as const }
  return { note, separator }
}
