// Object-tree helpers shared by the tree panel, the CLI (`npm run analyze`) and tests.

import type { LayoutChunk, LayoutPage } from './types'

/** Short type label in Adobe-style vocabulary. */
export function chunkTag(c: LayoutChunk): string {
  switch (c.type) {
    case 'HEADING':
      return c.role === 'title' ? 'TITLE' : `H${c.level ?? 1}`
    case 'PARAGRAPH':
      return c.role ? `P · ${c.role}` : 'P'
    case 'LIST':
      return c.role === 'toc' ? 'TOC' : 'LIST'
    case 'LIST_ITEM':
      return 'LI'
    case 'TABLE':
      return `TABLE ${c.table?.rows ?? '?'}×${c.table?.columns ?? '?'}`
    case 'TABLE_ROW':
      return 'TR'
    case 'TABLE_CELL': {
      const s = c.cell && (c.cell.rowSpan > 1 || c.cell.colSpan > 1) ? ` ${c.cell.rowSpan}×${c.cell.colSpan}` : ''
      return `${c.cell?.header ? 'TH' : 'TD'}${s}`
    }
    case 'TEXT_LINE':
      return 'TEXT LINE'
    case 'TEXT_SPAN':
      return 'SPAN'
    case 'LINE':
      return 'RULE'
    case 'RECTANGLE':
      return 'RECT'
    default:
      return c.type
  }
}

export function snippet(text: string | undefined, max = 48): string {
  if (!text) return ''
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export interface TreeRow {
  id: string
  depth: number
  last: boolean[]
}

/** Depth-first rows in reading order; text lines/spans are hidden unless `includeTextLines`. */
export function treeRows(page: LayoutPage, opts: { includeTextLines?: boolean } = {}): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (id: string, depth: number, last: boolean[]) => {
    rows.push({ id, depth, last })
    const kids = page.chunks[id].children.filter((k) => opts.includeTextLines || (page.chunks[k].type !== 'TEXT_LINE' && page.chunks[k].type !== 'TEXT_SPAN'))
    kids.forEach((k, i) => walk(k, depth + 1, [...last, i === kids.length - 1]))
  }
  page.roots.forEach((id, i) => walk(id, 0, [i === page.roots.length - 1]))
  return rows
}

/** ASCII tree, e.g. for the CLI:  ├── TABLE 3×4 */
export function formatTree(page: LayoutPage, opts: { includeTextLines?: boolean; text?: boolean } = {}): string {
  return treeRows(page, opts)
    .map(({ id, last }) => {
      const c = page.chunks[id]
      const prefix = last.slice(0, -1).map((l) => (l ? '    ' : '│   ')).join('') + (last[last.length - 1] ? '└── ' : '├── ')
      const t = opts.text !== false && c.text && c.type !== 'TABLE' ? `  "${snippet(c.text)}"` : ''
      return `${prefix}${chunkTag(c)}${t}`
    })
    .join('\n')
}

/** Ids of a chunk and all its descendants. */
export function descendants(page: LayoutPage, id: string): string[] {
  const out: string[] = []
  const walk = (k: string) => {
    out.push(k)
    page.chunks[k]?.children.forEach(walk)
  }
  walk(id)
  return out
}
