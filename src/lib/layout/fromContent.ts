// Local provider adapter: the analyzer's ContentObject tree → normalized LayoutChunks.
//
// Chunk ids equal ContentObject ids, so selection/edit/export code built on ContentObjects keeps
// working while the UI moves to chunks. On top of the analyzer this adds the semantic layer the
// layout model needs: HEADING (with level) / PARAGRAPH / LIST_ITEM roles become types,
// consecutive list items are grouped into LIST containers, and cells get span/header info.

import type { Box, ContentObject, PageContent, TextStyle } from '../content/types'
import type { ChunkStyle, ChunkType, LayoutChunk, LayoutPage, Matrix } from './types'

// (inlined rather than imported so Node can run this file directly for scripts/analyze-debug.ts)
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export const toBounds = (b: Box) => ({ x: b.x, y: b.y, width: b.w, height: b.h })

/** "TimesNewRomanPS-BoldItalicMT" → "Times New Roman"; "Arial,Bold" → "Arial". */
export function familyFromFontName(name: string): string {
  const base = name.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0].replace(/(PS)?MT$|PS$/, '')
  const spaced = base.replace(/([a-z])([A-Z])/g, '$1 $2').trim()
  return spaced || name
}

export function chunkStyle(s: TextStyle): ChunkStyle {
  return {
    fontFamily: familyFromFontName(s.fontName),
    fontName: s.fontName,
    fallbackFont: s.fontFamily,
    fontSize: s.fontSize,
    fontWeight: s.bold ? 700 : 400,
    italic: s.italic,
    underline: false,
    color: s.color,
    alignment: s.align,
    lineHeight: s.lineHeight,
    characterSpacing: s.charSpacing,
  }
}

const union = (bs: { x: number; y: number; width: number; height: number }[]) => {
  const x0 = Math.min(...bs.map((b) => b.x))
  const y0 = Math.min(...bs.map((b) => b.y))
  const x1 = Math.max(...bs.map((b) => b.x + b.width))
  const y1 = Math.max(...bs.map((b) => b.y + b.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export function layoutFromContent(content: PageContent, sourceId: string, pageIndex: number): LayoutPage {
  const chunks: Record<string, LayoutChunk> = {}
  const objs = content.objects

  // heading levels: distinct heading sizes on the page, largest = level 1
  const headingSizes = [...new Set(Object.values(objs).filter((o) => o.type === 'TEXT_BLOCK' && o.role === 'heading').map((o) => Math.round(o.style?.fontSize ?? 0)))].sort((a, b) => b - a)

  const typeOf = (o: ContentObject): ChunkType => {
    if (o.type !== 'TEXT_BLOCK') return o.type
    if (o.role === 'heading') return 'HEADING'
    if (o.role === 'list-item') return 'LIST_ITEM'
    return 'PARAGRAPH'
  }

  for (const o of Object.values(objs)) {
    const type = typeOf(o)
    const c: LayoutChunk = {
      id: o.id,
      type,
      sourceId,
      pageIndex,
      bounds: toBounds(o.bounds),
      rotation: 0,
      transform: IDENTITY,
      parent: o.parent,
      children: [...o.children],
      editable: o.editable,
      source: { provider: 'local', objectId: o.id, ops: o.ops, opsExclusive: o.opsExclusive, zIndex: o.zIndex },
    }
    if (o.text !== undefined) c.text = o.text
    if (o.style) c.style = chunkStyle(o.style)
    if (o.role === 'header' || o.role === 'footer') c.role = o.role
    if (type === 'HEADING') c.level = Math.min(6, headingSizes.indexOf(Math.round(o.style?.fontSize ?? 0)) + 1 || 1)
    if (o.type === 'TABLE') {
      c.table = {
        rows: o.rows ?? 0,
        columns: o.cols ?? 0,
        cells: (o.cellIds ?? []).map((r) => [...r]),
        rowEdges: o.rowEdges,
        colEdges: o.colEdges,
        kind: o.tableKind ?? 'stream',
      }
    }
    if (o.type === 'TABLE_CELL') {
      c.cell = { row: o.row ?? 0, col: o.col ?? 0, rowSpan: 1, colSpan: 1, header: (o.row ?? 0) === 0 && !!o.style?.bold }
    }
    if (o.type === 'LINE') {
      c.line = { x1: o.x1 ?? o.bounds.x, y1: o.y1 ?? o.bounds.y, x2: o.x2 ?? o.bounds.x + o.bounds.w, y2: o.y2 ?? o.bounds.y + o.bounds.h, strokeWidth: o.thickness ?? 1, color: o.strokeColor ?? o.fillColor ?? null }
    }
    if (o.type === 'RECTANGLE') c.shape = { fill: o.fillColor ?? null, stroke: o.strokeColor ?? null, strokeWidth: o.thickness ?? 0 }
    if (o.type === 'IMAGE') c.image = { rotation: 0 }
    chunks[c.id] = c
  }

  // group runs of consecutive list items (reading order, similar indent, close together) into LISTs
  const roots: string[] = []
  let run: LayoutChunk[] = []
  let lists = 0
  const flush = () => {
    if (!run.length) return
    const id = `list${lists++}`
    chunks[id] = {
      id, type: 'LIST', sourceId, pageIndex, bounds: union(run.map((r) => r.bounds)), rotation: 0, transform: IDENTITY,
      parent: null, children: run.map((r) => r.id), editable: false, source: { provider: 'local' },
    }
    for (const r of run) r.parent = id
    roots.push(id)
    run = []
  }
  for (const id of content.roots) {
    const c = chunks[id]
    if (c.type === 'LIST_ITEM') {
      const prev = run[run.length - 1]
      const fs = c.style?.fontSize ?? 10
      const close = !prev || (Math.abs(prev.bounds.x - c.bounds.x) < 2 * fs && c.bounds.y - (prev.bounds.y + prev.bounds.height) < 2.5 * fs && c.bounds.y >= prev.bounds.y)
      if (!close) flush()
      run.push(c)
      continue
    }
    flush()
    roots.push(id)
  }
  flush()

  return {
    sourceId,
    pageIndex,
    width: content.width,
    height: content.height,
    provider: 'local',
    status: content.kind === 'digital' ? 'structured' : content.kind,
    chunks,
    roots,
    hitOrder: content.hitOrder.filter((id) => chunks[id]),
    ms: content.stats.ms,
    warnings: [],
  }
}
