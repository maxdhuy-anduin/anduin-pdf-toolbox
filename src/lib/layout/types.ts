// Normalized layout model: the provider-agnostic representation of a page as a tree of
// meaningful objects. Every layout provider (local heuristics, Adobe Extract, …) produces this;
// the UI and editor consume only this. Element vocabulary follows Adobe PDF Extract's public
// model (H/P/L/LI/Table/TR/TD/Figure, Bounds, Font, TextSize, alignment, row/col spans).
//
// Geometry: canonical page space (see lib/coords.ts): points, top-left origin, intrinsic /Rotate applied.

import type { FontFamily } from '../model'
import type { Rect } from '../coords'

export type ChunkType =
  | 'HEADING'
  | 'PARAGRAPH'
  | 'LIST'
  | 'LIST_ITEM'
  | 'TEXT_LINE'
  | 'TEXT_SPAN'
  | 'TABLE'
  | 'TABLE_ROW'
  | 'TABLE_CELL'
  | 'LINE'
  | 'RECTANGLE'
  | 'IMAGE'
  | 'FIGURE'

export type Bounds = Rect

/** Affine matrix [a, b, c, d, e, f] in canonical page space. */
export type Matrix = [number, number, number, number, number, number]
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export type ProviderId = 'local' | 'local-basic' | 'adobe'

export interface ChunkStyle {
  /** Family name as found in the PDF / provider, e.g. "Arial", "Times New Roman". */
  fontFamily: string
  /** Full font name (subset prefix stripped), e.g. "Arial-BoldMT". */
  fontName: string
  /** Standard-14 family used when the text is re-rendered. */
  fallbackFont: FontFamily
  fontSize: number
  fontWeight: number
  italic: boolean
  underline: boolean
  /** #rrggbb, null if unknown. */
  color: string | null
  alignment: 'left' | 'center' | 'right' | 'justify'
  /** Baseline-to-baseline distance as a multiple of fontSize. */
  lineHeight: number
  characterSpacing: number
}

export interface TableInfo {
  rows: number
  columns: number
  /** cells[row][col] = chunk id; a spanning cell's id repeats over every grid slot it covers. */
  cells: string[][]
  rowEdges?: number[]
  colEdges?: number[]
  /** How the table was found: ruled grid, horizontal rules only, whitespace alignment, or by the provider. */
  kind: 'lattice' | 'rules' | 'stream' | 'provider'
}

export interface CellInfo {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  header: boolean
}

export interface LineInfo {
  x1: number
  y1: number
  x2: number
  y2: number
  strokeWidth: number
  color: string | null
}

export interface ShapeInfo {
  fill: string | null
  stroke: string | null
  strokeWidth: number
}

export interface ImageInfo {
  /** Provider reference (e.g. Adobe `filePaths` entry); local images are referenced through source.ops. */
  ref?: string
  rotation: number
}

export interface SourceMetadata {
  provider: ProviderId
  /** Underlying analyzer object (local provider): links the chunk to the existing edit/export pipeline. */
  objectId?: string
  /** Operator-list indices that paint this chunk. */
  ops?: number[]
  /** True when `ops` paint nothing else (exact hiding / removal possible). */
  opsExclusive?: boolean
  /** Paint order. */
  zIndex?: number
  /** Provider structure path, e.g. Adobe "//Document/Table[2]/TR[3]/TD[1]/P". */
  path?: string
}

export interface LayoutChunk {
  id: string
  type: ChunkType
  /** Source document id + 0-based page index in that document (stable when pages are reordered). */
  sourceId: string
  pageIndex: number
  bounds: Bounds
  /** Rotation of the content relative to the page, degrees. */
  rotation: number
  /** Identity as extracted; edits (move/scale) compose here. */
  transform: Matrix
  parent: string | null
  children: string[]
  editable: boolean
  text?: string
  style?: ChunkStyle
  role?: 'title' | 'header' | 'footer' | 'footnote' | 'caption' | 'toc'
  /** Heading level 1–6. */
  level?: number
  table?: TableInfo
  cell?: CellInfo
  line?: LineInfo
  shape?: ShapeInfo
  image?: ImageInfo
  source: SourceMetadata
}

/**
 * structured: full object tree · basic: text spans only (structural analysis failed) ·
 * scanned: image-only page · empty: nothing on the page · failed: no layout at all (page ops still work)
 */
export type LayoutStatus = 'structured' | 'basic' | 'scanned' | 'empty' | 'failed'

export interface LayoutPage {
  sourceId: string
  pageIndex: number
  width: number
  height: number
  provider: ProviderId
  status: LayoutStatus
  chunks: Record<string, LayoutChunk>
  /** Top-level chunks in reading order. */
  roots: string[]
  /** Selectable chunks, innermost/smallest first (hit-testing order). */
  hitOrder: string[]
  ms: number
  warnings: string[]
}

export const TEXT_TYPES: ReadonlySet<ChunkType> = new Set(['HEADING', 'PARAGRAPH', 'LIST_ITEM', 'TEXT_LINE', 'TEXT_SPAN', 'TABLE_CELL'])
