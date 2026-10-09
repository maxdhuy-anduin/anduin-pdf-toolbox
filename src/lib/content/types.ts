// Content object model: what the analyzer reconstructs from a page's low-level PDF content.
//
// PDFs have no paragraphs or tables, only positioned glyphs, paths and images. This model is
// the "document understanding" layer on top of them, loosely inspired by Adobe PDF Extract's
// element tree (H/P/L/LI/Table/TR/TD/Figure with Bounds, Font, TextSize, Attributes).
//
// All geometry is in page *view space*: points at scale 1, origin top-left, with the page's
// intrinsic /Rotate applied (the same space text overlays use, see coords.ts).

import type { FontFamily } from '../model'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export type ObjType =
  | 'TEXT_BLOCK'
  | 'TEXT_LINE'
  | 'TEXT_SPAN'
  | 'TABLE'
  | 'TABLE_ROW'
  | 'TABLE_CELL'
  | 'LINE'
  | 'RECTANGLE'
  | 'IMAGE'

export type Role = 'heading' | 'paragraph' | 'list-item' | 'header' | 'footer'

export interface TextStyle {
  fontFamily: FontFamily
  /** Font name as embedded in the PDF (subset prefix stripped), e.g. "Arial-BoldMT". */
  fontName: string
  fontSize: number
  bold: boolean
  italic: boolean
  /** Fill colour (#rrggbb) read from the content stream, null if unknown. */
  color: string | null
  align: 'left' | 'center' | 'right' | 'justify'
  /** Baseline-to-baseline distance as a multiple of fontSize. */
  lineHeight: number
  charSpacing: number
}

export interface ContentObject {
  id: string
  type: ObjType
  bounds: Box
  parent: string | null
  children: string[]
  /** Paint order (lowest operator index involved). */
  zIndex: number
  editable: boolean
  /** Indices into RawPage.texts of the text items that make up this object. */
  sourceItems: number[]
  /** Operator-list indices that paint this object (used to hide it in the viewer). */
  ops: number[]
  /** True when `ops` paint nothing but this object, so they can be hidden/removed safely. */
  opsExclusive: boolean

  // text objects (TEXT_BLOCK / TEXT_LINE / TEXT_SPAN / TABLE_CELL)
  text?: string
  style?: TextStyle
  role?: Role
  /** For blocks: true when the line break after line i is a real (hard) break, not a wrap. */
  hardBreaks?: boolean[]
  /** Baseline of the first line (view space), used to place replacement text precisely. */
  firstBaseline?: number
  /** Lines: which characters of `text` each PDF text item drew, and where (search highlights). */
  textRuns?: TextRun[]

  // tables
  rows?: number
  cols?: number
  rowEdges?: number[]
  colEdges?: number[]
  /** cellIds[row][col] */
  cellIds?: string[][]
  tableKind?: 'lattice' | 'rules' | 'stream'
  row?: number
  col?: number

  // graphics
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  thickness?: number
  strokeColor?: string | null
  fillColor?: string | null
}

export interface TextRun {
  /** Character range [s, e) in the line's text. */
  s: number
  e: number
  /** Horizontal extent of the item (view space). */
  x0: number
  x1: number
  family: FontFamily
}

export type PageKind = 'digital' | 'scanned' | 'empty'

export interface PageContent {
  kind: PageKind
  width: number
  height: number
  objects: Record<string, ContentObject>
  /** Top-level objects in reading order. */
  roots: string[]
  /** Objects that can be hovered/selected, smallest first (hit-testing order). */
  hitOrder: string[]
  /** Operator-list indices of every painting operator on the page (used to render one object alone). */
  paintOps: number[]
  stats: { items: number; lines: number; blocks: number; tables: number; rules: number; rects: number; images: number; ms: number }
}

// ---------------------------------------------------------------------------
// Raw input to the analyzer (produced from PDF.js by extract.ts, or by tests)
// ---------------------------------------------------------------------------

export interface RawText {
  str: string
  /** Baseline-left origin. */
  x: number
  baseline: number
  width: number
  /** Font size in points (view space). */
  size: number
  /** Font name from the PDF (subset prefix stripped) if known, else PDF.js's internal name. */
  fontName: string
  /** PDF.js generic family hint: 'serif' | 'sans-serif' | 'monospace' | ''. */
  generic: string
  /** Weight/style flags from the font descriptor (names are checked separately). */
  bold?: boolean
  italic?: boolean
  color: string | null
  /** Operator-list indices of the showText ops that paint this item. */
  ops: number[]
  /** False for rotated / vertical text, which is detected but not editable. */
  horizontal: boolean
}

export interface RawPath {
  op: number
  /** Straight segments, view space. */
  segments: [number, number, number, number][]
  /** Axis-aligned rectangles found among the subpaths, view space. */
  rects: Box[]
  hasCurves: boolean
  bbox: Box
  stroke: boolean
  fill: boolean
  strokeColor: string | null
  fillColor: string | null
  /** Stroke width in view-space points. */
  lineWidth: number
  /** Number of subpaths in this path operation. */
  subpaths: number
}

export interface RawImage {
  op: number
  bbox: Box
}

export interface RawPage {
  width: number
  height: number
  texts: RawText[]
  paths: RawPath[]
  images: RawImage[]
  /** Operator-list indices of every operator that paints (text, paths, images, shadings). */
  paintOps?: number[]
}
