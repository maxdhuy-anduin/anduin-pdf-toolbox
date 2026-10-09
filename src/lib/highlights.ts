// Search highlights inside text boxes use the CSS Custom Highlight API (ranges are painted by the
// browser, so they follow wrapping, rotation and zoom). Browsers without it simply show no
// in-box highlight; the find bar still counts and navigates to the match.

type HL = { add(r: Range): void; delete(r: Range): boolean }

function make(name: string): HL | null {
  const g = globalThis as unknown as { Highlight?: new () => HL; CSS?: { highlights?: Map<string, HL> } }
  if (!g.Highlight || !g.CSS?.highlights) return null
  const h = new g.Highlight()
  g.CSS.highlights.set(name, h)
  return h
}

export const hitHighlight = make('toolbox-hit')
export const activeHighlight = make('toolbox-hit-active')

/** DOM range covering characters [start, end) of an element's text (text nodes in order). */
export function rangeFor(el: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const r = document.createRange()
  let pos = 0
  let started = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0
    if (!started && start <= pos + len) {
      r.setStart(n, start - pos)
      started = true
    }
    if (started && end <= pos + len) {
      r.setEnd(n, end - pos)
      return r
    }
    pos += len
  }
  return null
}

/** Character offsets of a range inside an element. */
export function offsetsOf(el: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  const start = pre.toString().length
  return { start, end: start + range.toString().length }
}
