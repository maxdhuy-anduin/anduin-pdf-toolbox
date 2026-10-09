import type { FontFamily } from './model'
import { fromSuper } from './richText'

const CP1252_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((c) => c.codePointAt(0)!))

/** Characters the standard PDF fonts (WinAnsi) can draw. */
export function isWinAnsi(ch: string): boolean {
  if (ch === '\n') return true
  const cp = ch.codePointAt(0)!
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRA.has(cp)
}

/** Characters a standard font can't draw (superscripts count as their normal form). Embedded fonts: checked on export. */
export function unsupportedChars(text: string, family: FontFamily = 'Helvetica'): string[] {
  if (EMBEDDED_FONTS[family]) return []
  const bad = new Set<string>()
  for (const ch of fromSuper(text)) if (!isWinAnsi(ch)) bad.add(ch)
  return [...bad]
}

// ---------------------------------------------------------------------------------------------
// Embedded fonts. Calibri, Cambria, Georgia and Garamond are proprietary and can't be shipped,
// so the app uses open-source fonts with the same character widths (Carlito, Caladea) or the same
// design (Gelasio, EB Garamond). The files are served by the app itself (public/fonts, SIL Open
// Font License) and embedded (subset) in the exported PDF. Nothing is fetched from third parties.
// ---------------------------------------------------------------------------------------------


export interface EmbeddedFont {
  /** File name prefix in public/fonts: `${file}-Regular.ttf` etc. */
  file: string
  /** What the user is told about it. */
  note: string
  css: string
}

export const EMBEDDED_FONTS: Partial<Record<FontFamily, EmbeddedFont>> = {
  Calibri: { file: 'Carlito', note: 'Carlito: same character widths as Calibri', css: '"Toolbox Calibri", Carlito, Calibri, sans-serif' },
  Cambria: { file: 'Caladea', note: 'Caladea: same character widths as Cambria', css: '"Toolbox Cambria", Caladea, Cambria, serif' },
  Georgia: { file: 'Gelasio', note: 'Gelasio: designed to match Georgia', css: '"Toolbox Georgia", Gelasio, Georgia, serif' },
  Garamond: { file: 'EBGaramond', note: 'EB Garamond', css: '"Toolbox Garamond", "EB Garamond", Garamond, serif' },
  OpenSans: { file: 'OpenSans', note: 'Open Sans', css: '"Toolbox OpenSans", "Open Sans", sans-serif' },
  Roboto: { file: 'Roboto', note: 'Roboto', css: '"Toolbox Roboto", Roboto, sans-serif' },
  Lato: { file: 'Lato', note: 'Lato', css: '"Toolbox Lato", Lato, sans-serif' },
}

export const isEmbedded = (f: FontFamily) => !!EMBEDDED_FONTS[f]

export function fontFile(f: FontFamily, bold: boolean, italic: boolean): string | null {
  const e = EMBEDDED_FONTS[f]
  if (!e) return null
  return `${e.file}-${bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular'}.ttf`
}

type Loader = (file: string) => Promise<Uint8Array>
const base = (() => {
  try {
    return import.meta.env?.BASE_URL ?? '/'
  } catch {
    return '/'
  }
})()
let loader: Loader = async (file) => {
  const r = await fetch(`${base}fonts/${file}`)
  if (!r.ok) throw new Error(`Font ${file} could not be loaded (${r.status})`)
  return new Uint8Array(await r.arrayBuffer())
}
const bytesCache = new Map<string, Promise<Uint8Array>>()

/** Tests (Node) read the files from disk instead of fetching them. */
export function setFontLoader(fn: Loader) {
  loader = fn
  bytesCache.clear()
}

export function loadFontBytes(file: string): Promise<Uint8Array> {
  let p = bytesCache.get(file)
  if (!p) {
    p = loader(file)
    bytesCache.set(file, p)
    p.catch(() => bytesCache.delete(file))
  }
  return p
}
