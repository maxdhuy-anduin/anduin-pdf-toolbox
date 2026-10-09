// Superscripts (footnote numbers, ordinals, exponents) without a rich-text model: they are stored as
// the Unicode superscript characters (¹ ² ³ ⁴ … ˢ ᵗ), so text boxes stay plain text (editing, undo,
// search and copy all work unchanged). Display and export draw each one as the normal character,
// smaller and raised, so they look the same in every font.

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ',
  n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
}
const BASE: Record<string, string> = Object.fromEntries(Object.entries(SUP).map(([k, v]) => [v, k]))

/** Size and rise of a superscript, as fractions of the font size. */
export const SUP_SCALE = 0.65
export const SUP_RISE = 0.35

export const isSuper = (ch: string) => ch in BASE

/** Superscript form of a string (characters without one are kept as they are). */
export const toSuper = (s: string) => [...s].map((c) => SUP[c] ?? SUP[c.toLowerCase()] ?? c).join('')
export const fromSuper = (s: string) => [...s].map((c) => BASE[c] ?? c).join('')

/** True when every character that has a superscript form is already superscript. */
export const allSuper = (s: string) => [...s].every((c) => isSuper(c) || !(c in SUP || c.toLowerCase() in SUP))

/** Toggles a selection: all superscript → normal, otherwise → superscript. */
export const toggleSuper = (s: string) => (allSuper(s) && [...s].some(isSuper) ? fromSuper(s) : toSuper(s))

export interface Run {
  text: string
  sup: boolean
}

/** Splits text into normal and superscript runs; superscript runs hold the *normal* characters. */
export function runs(text: string): Run[] {
  const out: Run[] = []
  for (const ch of text) {
    const sup = isSuper(ch)
    const c = sup ? BASE[ch] : ch
    const last = out[out.length - 1]
    if (last && last.sup === sup) last.text += c
    else out.push({ text: c, sup })
  }
  return out
}

export const hasSuper = (text: string) => [...text].some(isSuper)

/** Width of mixed text given a measure for normal text at full size. */
export function measureRuns(text: string, measure: (s: string) => number): number {
  if (!hasSuper(text)) return measure(text)
  return runs(text).reduce((w, r) => w + (r.sup ? measure(r.text) * SUP_SCALE : measure(r.text)), 0)
}

/** HTML for display: superscripts as raised, smaller spans (escaped). */
export function superHtml(text: string, fontPx: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return runs(text)
    .map((r) => (r.sup ? `<span data-sup style="font-size:${SUP_SCALE}em;vertical-align:${(SUP_RISE * fontPx).toFixed(2)}px;line-height:0">${esc(r.text)}</span>` : esc(r.text)))
    .join('')
}

/** Highest footnote number used anywhere (text boxes marked as footnotes). */
export function maxFootnote(pages: { overlays: { type: string; footnote?: number }[] }[]): number {
  let m = 0
  for (const p of pages) for (const o of p.overlays) if (o.type === 'text' && o.footnote) m = Math.max(m, o.footnote)
  return m
}
