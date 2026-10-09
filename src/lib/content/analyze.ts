// Content analyzer: RawPage → PageContent (blocks, lines, spans, tables, rules, rectangles, images).
//
// Pure geometry heuristics, no PDF.js dependency, so it is unit-testable in Node.
// Pipeline:
//   1. graphics → horizontal/vertical rules, rectangles (page backgrounds ignored)
//   2. text items → lines (baseline bands, split at large gaps and at vertical rules) → spans
//   3. tables: lattice (ruled grid) → horizontal-rule tables → stream (whitespace columns)
//   4. remaining lines → blocks (line spacing, size, weight, indent, bullets, separating rules)
//   5. roles (heading / paragraph / list-item / header / footer), alignment, line height
//   6. operator ownership (can an object's operators be hidden without hiding anything else?)
import type { FontFamily } from '../model'
import type { Box, ContentObject, PageContent, RawPage, RawText, Role, TextRun, TextStyle } from './types'

// ---------------------------------------------------------------------------
// font classification
// ---------------------------------------------------------------------------

export function classifyFont(name: string, generic: string, flags: { bold?: boolean; italic?: boolean } = {}) {
  const n = name.replace(/^[A-Z]{6}\+/, '')
  const bold = !!flags.bold || /bold|black|heavy|semibold|demi|extrabold|,b\b/i.test(n)
  const italic = !!flags.italic || /italic|oblique|ital\b|-it\b|,i\b/i.test(n)
  let family: FontFamily = 'Helvetica'
  if (/courier|mono|consolas|menlo|typewriter|lucida console/i.test(n) || generic === 'monospace') family = 'Courier'
  else if (/times|georgia|garamond|palatino|cambria|minion|bookman|century|baskerville|caslon|serif/i.test(n) && !/sans/i.test(n)) family = 'Times'
  else if (generic === 'serif' && !/arial|helvet|calibri|verdana|tahoma|sans|gothic|segoe|roboto|inter|manrope/i.test(n)) family = 'Times'
  // families the app can embed (same metrics or design): edits keep the look of the original
  if (/calibri|carlito/i.test(n)) family = 'Calibri'
  else if (/cambria|caladea/i.test(n)) family = 'Cambria'
  else if (/georgia|gelasio/i.test(n)) family = 'Georgia'
  else if (/garamond/i.test(n)) family = 'Garamond'
  else if (/opensans|open sans/i.test(n)) family = 'OpenSans'
  else if (/roboto/i.test(n) && !/mono|slab/i.test(n)) family = 'Roboto'
  else if (/\blato/i.test(n)) family = 'Lato'
  return { family, bold, italic }
}

const BULLET = /^\s*([•●▪■◦‣∙·\-–—*]|\(?[0-9]{1,2}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])\s+/i

interface Item extends RawText {
  idx: number
  family: FontFamily
  isBold: boolean
  isItalic: boolean
  top: number
  bottom: number
}

interface Line {
  id: string
  items: Item[]
  x: number
  right: number
  baseline: number
  top: number
  bottom: number
  size: number
  text: string
  allBold: boolean
  used: boolean
}

interface Rule {
  o: 'h' | 'v'
  x1: number
  y1: number
  x2: number
  y2: number
  thickness: number
  color: string | null
  op: number
  used: boolean
}

interface RectCand {
  box: Box
  fill: string | null
  stroke: string | null
  thickness: number
  op: number
  used: boolean
}

const union = (boxes: Box[]): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
const median = (v: number[]) => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}
const cluster = (values: number[], tol: number): number[] => {
  const s = [...values].sort((a, b) => a - b)
  const out: number[][] = []
  for (const v of s) {
    const last = out[out.length - 1]
    if (last && v - last[last.length - 1] <= tol) last.push(v)
    else out.push([v])
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length)
}
const lineBox = (l: { x: number; right: number; top: number; bottom: number }): Box => ({ x: l.x, y: l.top, w: l.right - l.x, h: l.bottom - l.top })

export function analyzePage(raw: RawPage): PageContent {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const W = raw.width
  const H = raw.height
  const objects: Record<string, ContentObject> = {}
  const add = (o: ContentObject) => {
    objects[o.id] = o
    return o
  }

  // ---- 1. graphics ----------------------------------------------------------
  const rules: Rule[] = []
  const rects: RectCand[] = []
  const primitivesPerOp = new Map<number, number>()
  const bump = (op: number) => primitivesPerOp.set(op, (primitivesPerOp.get(op) ?? 0) + 1)
  for (const p of raw.paths) {
    if (p.stroke) {
      for (const [x1, y1, x2, y2] of p.segments) {
        const dx = Math.abs(x2 - x1)
        const dy = Math.abs(y2 - y1)
        if (dy <= 0.6 && dx >= 3) {
          rules.push({ o: 'h', x1: Math.min(x1, x2), x2: Math.max(x1, x2), y1: (y1 + y2) / 2, y2: (y1 + y2) / 2, thickness: p.lineWidth, color: p.strokeColor, op: p.op, used: false })
          bump(p.op)
        } else if (dx <= 0.6 && dy >= 3) {
          rules.push({ o: 'v', x1: (x1 + x2) / 2, x2: (x1 + x2) / 2, y1: Math.min(y1, y2), y2: Math.max(y1, y2), thickness: p.lineWidth, color: p.strokeColor, op: p.op, used: false })
          bump(p.op)
        } else bump(p.op) // diagonal/curved ink: not an object, but shares the operator
      }
    } else if (p.segments.length) bump(p.op)
    for (const r of p.rects) {
      if (r.w * r.h >= 0.95 * W * H) continue // page background
      if (p.fill && r.h <= 2.5 && r.w >= 4) {
        rules.push({ o: 'h', x1: r.x, x2: r.x + r.w, y1: r.y + r.h / 2, y2: r.y + r.h / 2, thickness: r.h, color: p.fillColor, op: p.op, used: false })
      } else if (p.fill && r.w <= 2.5 && r.h >= 4) {
        rules.push({ o: 'v', x1: r.x + r.w / 2, x2: r.x + r.w / 2, y1: r.y, y2: r.y + r.h, thickness: r.w, color: p.fillColor, op: p.op, used: false })
      } else if (r.w >= 2 && r.h >= 2) {
        rects.push({ box: r, fill: p.fill ? p.fillColor : null, stroke: p.stroke ? p.strokeColor : null, thickness: p.lineWidth, op: p.op, used: false })
        if (p.stroke && !p.fill) {
          // a stroked box also contributes its edges as rules (cell borders)
          const t = p.lineWidth
          rules.push(
            { o: 'h', x1: r.x, x2: r.x + r.w, y1: r.y, y2: r.y, thickness: t, color: p.strokeColor, op: -1, used: false },
            { o: 'h', x1: r.x, x2: r.x + r.w, y1: r.y + r.h, y2: r.y + r.h, thickness: t, color: p.strokeColor, op: -1, used: false },
            { o: 'v', x1: r.x, x2: r.x, y1: r.y, y2: r.y + r.h, thickness: t, color: p.strokeColor, op: -1, used: false },
            { o: 'v', x1: r.x + r.w, x2: r.x + r.w, y1: r.y, y2: r.y + r.h, thickness: t, color: p.strokeColor, op: -1, used: false },
          )
        }
      } else continue
      bump(p.op)
    }
  }
  const hRules = rules.filter((r) => r.o === 'h')
  const vRules = rules.filter((r) => r.o === 'v')

  // ---- 2. text → lines → spans ------------------------------------------------
  const items: Item[] = raw.texts
    .map((t, idx) => {
      const f = classifyFont(t.fontName, t.generic, t)
      return { ...t, idx, family: f.family, isBold: f.bold, isItalic: f.italic, top: t.baseline - t.size * 0.86, bottom: t.baseline + t.size * 0.24 }
    })
    .filter((t) => t.horizontal && t.str.trim())

  const bands: Item[][] = []
  for (const it of [...items].sort((a, b) => a.baseline - b.baseline)) {
    const band = bands[bands.length - 1]
    if (band && Math.abs(band[0].baseline - it.baseline) < 0.35 * Math.min(band[0].size, it.size)) band.push(it)
    else bands.push([it])
  }
  const ruleBetween = (x0: number, x1: number, y: number) =>
    vRules.some((r) => r.x1 > x0 - 0.5 && r.x1 < x1 + 0.5 && r.y1 <= y && r.y2 >= y - 2)

  let lineN = 0
  const lines: Line[] = []
  for (const band of bands) band.sort((a, b) => a.x - b.x)
  // A column gutter is a whitespace strip that stays empty across several neighbouring lines
  // (with text on both sides); word gaps in justified text do not line up like that.
  const isGutter = (bi: number, x0: number, x1: number) => {
    const mid = (x0 + x1) / 2
    const size = bands[bi][0].size
    let n = 0
    for (let j = Math.max(0, bi - 5); j <= Math.min(bands.length - 1, bi + 5); j += 1) {
      if (j === bi || Math.abs(bands[j][0].baseline - bands[bi][0].baseline) > 6 * size) continue
      const blocked = bands[j].some((it) => it.x < x1 - 1 && it.x + it.width > x0 + 1)
      const leftSide = bands[j].some((it) => it.x + it.width < mid - 1)
      const rightSide = bands[j].some((it) => it.x > mid + 1)
      if (!blocked && leftSide && rightSide) n += 1
    }
    return n >= 2
  }
  bands.forEach((band, bi) => {
    // Justified text is often drawn word-by-word with wide, uneven gaps.
    const gaps = band.slice(1).map((it, k) => it.x - (band[k].x + band[k].width)).filter((g) => g > 0.1 * band[0].size)
    const wordByWord = gaps.length >= 3 && band.filter((it) => !/\s/.test(it.str.trim())).length / band.length >= 0.6
    let cur: Item[] = []
    const flush = () => {
      if (!cur.length) return
      lines.push(makeLine(`ln${++lineN}`, cur))
      cur = []
    }
    for (const it of band) {
      const last = cur[cur.length - 1]
      if (last) {
        const right = Math.max(...cur.map((c) => c.x + c.width))
        const gap = it.x - right
        const size = Math.max(last.size, it.size)
        const split = wordByWord
          ? (gap > 0.6 * size && isGutter(bi, right, it.x)) || gap > 6 * size
          : gap > 1.0 * size || (gap > 0.6 * size && isGutter(bi, right, it.x))
        // a lone bullet / enumerator glyph belongs to the text that follows it
        const afterBullet = cur.length === 1 && /^([•●▪■◦‣∙·\-–—*]|\(?[0-9a-z]{1,3}[.)])$/i.test(last.str.trim()) && gap < 3 * size
        if ((split && !afterBullet) || gap < -2 * size || ruleBetween(right, it.x, it.baseline)) flush()
      }
      cur.push(it)
    }
    flush()
  })

  // body text size = character-weighted median (robust on pages with many display sizes)
  const bodySize = (() => {
    const w = items.map((it) => [it.size, it.str.trim().length] as const).sort((a, b) => a[0] - b[0])
    const total = w.reduce((n, [, c]) => n + c, 0)
    let acc = 0
    for (const [size, c] of w) {
      acc += c
      if (acc >= total / 2) return size
    }
    return 10
  })()

  // ---- 3. tables ---------------------------------------------------------------
  let tableN = 0
  const tables: string[] = []

  const buildTable = (kind: 'lattice' | 'rules' | 'stream', rowEdges: number[], colEdges: number[], members: Line[], usedRules: Rule[]) => {
    const tid = `tbl${++tableN}`
    const rows = rowEdges.length - 1
    const cols = colEdges.length - 1
    const cellIds: string[][] = []
    const children: string[] = []
    const cellLines = new Map<string, Line[]>()
    for (let r = 0; r < rows; r += 1) {
      const rowId = `${tid}r${r}`
      const rowCells: string[] = []
      for (let c = 0; c < cols; c += 1) {
        const id = `${tid}c${r}_${c}`
        rowCells.push(id)
        cellLines.set(id, [])
      }
      cellIds.push(rowCells)
      children.push(rowId)
    }
    for (const l of members) {
      const cx = (l.x + l.right) / 2
      const cy = (l.top + l.bottom) / 2
      const r = rowEdges.findIndex((e, k) => k < rows && cy >= e - 1 && cy <= rowEdges[k + 1] + 1)
      const c = colEdges.findIndex((e, k) => k < cols && cx >= e - 1 && cx <= colEdges[k + 1] + 1)
      if (r < 0 || c < 0) continue
      cellLines.get(cellIds[r][c])!.push(l)
      l.used = true
    }
    for (let r = 0; r < rows; r += 1) {
      const rowId = `${tid}r${r}`
      for (let c = 0; c < cols; c += 1) {
        const id = cellIds[r][c]
        const ls = cellLines.get(id)!.sort((a, b) => a.baseline - b.baseline || a.x - b.x)
        const bounds = { x: colEdges[c], y: rowEdges[r], w: colEdges[c + 1] - colEdges[c], h: rowEdges[r + 1] - rowEdges[r] }
        const cell: ContentObject = {
          id, type: 'TABLE_CELL', bounds, parent: rowId, children: ls.map((l) => l.id), zIndex: 0, editable: true,
          sourceItems: ls.flatMap((l) => l.items.map((i) => i.idx)), ops: [], opsExclusive: false, row: r, col: c,
        }
        if (ls.length) Object.assign(cell, textProps(ls, bounds))
        else cell.text = ''
        add(cell)
        for (const l of ls) addLine(l, id)
      }
      add({
        id: rowId, type: 'TABLE_ROW', parent: tid, children: cellIds[r], zIndex: 0, editable: false, sourceItems: [], ops: [], opsExclusive: false, row: r,
        bounds: { x: colEdges[0], y: rowEdges[r], w: colEdges[cols] - colEdges[0], h: rowEdges[r + 1] - rowEdges[r] },
      })
    }
    for (const u of usedRules) u.used = true
    const ruleOps = [...new Set(usedRules.map((u) => u.op).filter((o) => o >= 0))]
    add({
      id: tid, type: 'TABLE', parent: null, children, zIndex: 0, editable: false, sourceItems: [], ops: ruleOps, opsExclusive: false,
      bounds: { x: colEdges[0], y: rowEdges[0], w: colEdges[cols] - colEdges[0], h: rowEdges[rows] - rowEdges[0] },
      rows, cols, rowEdges, colEdges, cellIds, tableKind: kind,
    })
    tables.push(tid)
  }

  // 3a. lattice: connected grids of horizontal + vertical rules
  {
    const all = [...hRules.filter((r) => r.x2 - r.x1 >= 8), ...vRules.filter((r) => r.y2 - r.y1 >= 6)]
    const parent = all.map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const [a, b] = [all[i], all[j]]
        if (a.o === b.o) continue
        const h = a.o === 'h' ? a : b
        const v = a.o === 'h' ? b : a
        if (v.x1 >= h.x1 - 2 && v.x1 <= h.x2 + 2 && h.y1 >= v.y1 - 2 && h.y1 <= v.y2 + 2) parent[find(i)] = find(j)
      }
    }
    const groups = new Map<number, Rule[]>()
    all.forEach((r, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), r]))
    for (const g of groups.values()) {
      const hs = g.filter((r) => r.o === 'h')
      const vs = g.filter((r) => r.o === 'v')
      if (hs.length < 2 || vs.length < 2) continue
      const rowEdges = cluster(hs.map((r) => r.y1), 2)
      const colEdges = cluster(vs.map((r) => r.x1), 2)
      if (rowEdges.length < 2 || colEdges.length < 2 || (rowEdges.length - 1) * (colEdges.length - 1) < 2) continue
      const box = { x: colEdges[0], y: rowEdges[0], w: colEdges[colEdges.length - 1] - colEdges[0], h: rowEdges[rowEdges.length - 1] - rowEdges[0] }
      const inside = lines.filter((l) => !l.used && contains(box, l))
      const filledCells = new Set(inside.map((l) => `${rowEdges.findIndex((e) => (l.top + l.bottom) / 2 < e)}:${colEdges.findIndex((e) => (l.x + l.right) / 2 < e)}`))
      if (filledCells.size < 2) continue // a box or form field, not a table
      buildTable('lattice', rowEdges, colEdges, inside, g)
    }
  }

  // 3b. tables delimited by horizontal rules only (very common in financial documents)
  {
    const cands = hRules.filter((r) => !r.used && r.x2 - r.x1 >= 60).sort((a, b) => a.y1 - b.y1)
    const groups: Rule[][] = []
    for (const r of cands) {
      const g = groups.find((gr) => Math.abs(gr[0].x1 - r.x1) < 4 && Math.abs(gr[0].x2 - r.x2) < 4 && r.y1 - gr[gr.length - 1].y1 < 90 && r.y1 - gr[gr.length - 1].y1 > 4)
      if (g) g.push(r)
      else groups.push([r])
    }
    for (const g of groups) {
      if (g.length < 3) continue
      const rowEdges = cluster(g.map((r) => r.y1), 1)
      const x1 = g[0].x1
      const x2 = g[0].x2
      const region = { x: x1 - 2, y: rowEdges[0], w: x2 - x1 + 4, h: rowEdges[rowEdges.length - 1] - rowEdges[0] }
      const inside = lines.filter((l) => !l.used && contains(region, l))
      if (inside.length < 3) continue
      const colEdges = columnsFromProjection(inside, x1, x2)
      if (!colEdges || colEdges.length < 3) continue
      // every row band must contain text
      const filledRows = new Set(inside.map((l) => rowEdges.findIndex((e) => (l.top + l.bottom) / 2 < e)))
      if (filledRows.size < Math.max(2, (rowEdges.length - 1) * 0.6)) continue
      buildTable('rules', rowEdges, colEdges, inside, g)
    }
  }

  // 3c. stream tables: rows of whitespace-separated columns, no rules
  {
    const free = lines.filter((l) => !l.used)
    const rowsByBaseline: Line[][] = []
    for (const l of [...free].sort((a, b) => a.baseline - b.baseline)) {
      const r = rowsByBaseline[rowsByBaseline.length - 1]
      if (r && Math.abs(r[0].baseline - l.baseline) < 0.4 * l.size) r.push(l)
      else rowsByBaseline.push([l])
    }
    let i = 0
    while (i < rowsByBaseline.length) {
      if (rowsByBaseline[i].length < 2) {
        i += 1
        continue
      }
      // grow a run of multi-segment rows (allowing single-segment continuation rows)
      let j = i
      const run: Line[][] = [rowsByBaseline[i]]
      while (j + 1 < rowsByBaseline.length) {
        const next = rowsByBaseline[j + 1]
        const prev = run[run.length - 1]
        const gap = next[0].baseline - prev[0].baseline
        if (gap > 2.4 * prev[0].size) break
        if (next.length < 2 && !(run.length && next[0].x > Math.min(...run[0].map((l) => l.x)) + 30)) break
        run.push(next)
        j += 1
      }
      const multi = run.filter((r) => r.length >= 2)
      const all = run.flat()
      const x1 = Math.min(...all.map((l) => l.x))
      const x2 = Math.max(...all.map((l) => l.right))
      const colEdges = columnsFromProjection(all, x1, x2)
      const cols = colEdges ? colEdges.length - 1 : 0
      // Multi-column prose is not a table: its lines fill their column edge to edge.
      const looksLikeProse = !!colEdges && (() => {
        const filled = all.filter((l) => {
          const c = colEdges.findIndex((_e, k) => k < colEdges.length - 1 && (l.x + l.right) / 2 <= colEdges[k + 1])
          const cw = colEdges[c + 1] - colEdges[c]
          return (l.right - l.x) / cw > 0.8 && l.text.split(/\s+/).length >= 5
        }).length
        return filled > all.length * 0.5
      })()
      // real tables fill most of their cells; scattered labels (e.g. chart annotations) do not
      const density = colEdges ? multi.reduce((n, r) => n + new Set(r.map((l) => colEdges.findIndex((e) => (l.x + l.right) / 2 < e))).size, 0) / (multi.length * cols) : 0
      if (colEdges && cols >= 2 && ((multi.length >= 3 && density >= 0.6) || (multi.length === 2 && cols >= 3 && density >= 0.9)) && !looksLikeProse) {
        // row edges: halfway between consecutive multi-segment rows; continuation rows join the row above
        const starts = run.map((r) => r.length >= 2)
        const rowTops: number[] = []
        run.forEach((r, k) => {
          if (starts[k]) rowTops.push(Math.min(...r.map((l) => l.top)))
        })
        const bottom = Math.max(...all.map((l) => l.bottom))
        const rowEdges = [...rowTops.map((t, k) => (k === 0 ? t - 2 : (t + prevBottom(run, starts, k)) / 2)), bottom + 2]
        buildTable('stream', rowEdges, colEdges, all, [])
        i = j + 1
      } else i += 1
    }
  }

  // ---- 4. blocks from the remaining lines -------------------------------------------
  let blockN = 0
  const blocks: { id: string; lines: Line[] }[] = []
  const free = lines.filter((l) => !l.used).sort((a, b) => a.top - b.top || a.x - b.x)
  const hRuleBetween = (a: Line, b: Line) =>
    hRules.some((r) => r.y1 > a.bottom - 1 && r.y1 < b.top + 1 && r.x2 > Math.max(a.x, b.x) && r.x1 < Math.min(a.right, b.right))
  for (const l of free) {
    const isBullet = BULLET.test(l.text)
    let best: { id: string; lines: Line[] } | null = null
    let bestScore = Infinity
    for (const b of blocks) {
      const last = b.lines[b.lines.length - 1]
      const dy = l.baseline - last.baseline
      const size = Math.max(l.size, last.size)
      if (dy < 0.5 * size || dy > 1.9 * size) continue
      if (l.size / last.size > 1.18 || last.size / l.size > 1.18) continue
      if (b.lines.length >= 2) {
        const gaps = b.lines.slice(1).map((x, k) => x.baseline - b.lines[k].baseline)
        if (dy > median(gaps) * 1.3 + 0.5) continue
      }
      const bx = Math.min(...b.lines.map((x) => x.x))
      const br = Math.max(...b.lines.map((x) => x.right))
      const overlap = Math.min(br, l.right) - Math.max(bx, l.x)
      const aligned = Math.abs(l.x - bx) < 2.5 || Math.abs((l.x + l.right) / 2 - (bx + br) / 2) < 2.5
      if (!aligned && overlap < 0.3 * Math.min(br - bx, l.right - l.x)) continue
      if (l.x > br + 2 || l.right < bx - 2) continue
      if (isBullet) continue // a bullet always starts a new item
      if (last.allBold !== l.allBold && (last.allBold || l.allBold)) continue // heading vs body
      // first-line indent starts a new paragraph (but a block may *begin* with an indented line)
      if (b.lines.length >= 2 && l.x > bx + 0.8 * l.size && Math.abs(last.x - bx) < 2) continue
      // list item continuation: hanging indent aligned with the text after the bullet
      const firstIsBullet = BULLET.test(b.lines[0].text)
      if (firstIsBullet && l.x < bx - 1) continue
      if (hRuleBetween(last, l)) continue
      const score = dy + (aligned ? 0 : 5)
      if (score < bestScore) {
        best = b
        bestScore = score
      }
    }
    if (best) best.lines.push(l)
    else blocks.push({ id: `blk${++blockN}`, lines: [l] })
    l.used = true
  }

  const textRight = Math.max(0, ...lines.map((l) => l.right))
  const blockIds: string[] = []
  for (const b of blocks) {
    const bounds = union(b.lines.map(lineBox))
    const o: ContentObject = {
      id: b.id, type: 'TEXT_BLOCK', parent: null, children: b.lines.map((l) => l.id), zIndex: 0, editable: true,
      sourceItems: b.lines.flatMap((l) => l.items.map((i) => i.idx)), ops: [], opsExclusive: false,
      ...textProps(b.lines, bounds, { W, textRight }),
      bounds,
    }
    o.role = roleOf(o, b.lines, { H, bodySize })
    add(o)
    for (const l of b.lines) addLine(l, b.id)
    blockIds.push(b.id)
  }

  // ---- 5. graphics objects --------------------------------------------------------------
  let ruleN = 0
  const ruleIds: string[] = []
  for (const r of rules) {
    if (r.used || r.op < 0) continue
    const len = r.o === 'h' ? r.x2 - r.x1 : r.y2 - r.y1
    if (len < 4) continue
    const id = `rule${++ruleN}`
    const t = Math.max(r.thickness, 0.5)
    add({
      id, type: 'LINE', parent: null, children: [], zIndex: r.op, editable: true, sourceItems: [], ops: [r.op], opsExclusive: primitivesPerOp.get(r.op) === 1,
      bounds: r.o === 'h' ? { x: r.x1, y: r.y1 - t / 2, w: r.x2 - r.x1, h: t } : { x: r.x1 - t / 2, y: r.y1, w: t, h: r.y2 - r.y1 },
      x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, thickness: r.thickness, strokeColor: r.color,
    })
    ruleIds.push(id)
  }
  let rectN = 0
  const rectIds: string[] = []
  for (const r of rects) {
    if (r.used) continue
    const inTable = tables.some((t) => contains(objects[t].bounds, { x: r.box.x, right: r.box.x + r.box.w, top: r.box.y, bottom: r.box.y + r.box.h }, 2))
    if (inTable && !r.fill) continue // cell borders belong to the table
    const id = `rect${++rectN}`
    add({
      id, type: 'RECTANGLE', parent: null, children: [], zIndex: r.op, editable: true, sourceItems: [], ops: [r.op], opsExclusive: primitivesPerOp.get(r.op) === 1,
      bounds: r.box, fillColor: r.fill, strokeColor: r.stroke, thickness: r.thickness,
    })
    rectIds.push(id)
  }
  let imgN = 0
  const imageIds: string[] = []
  for (const im of raw.images) {
    if (im.bbox.w < 3 || im.bbox.h < 3) continue
    const id = `img${++imgN}`
    add({ id, type: 'IMAGE', parent: null, children: [], zIndex: im.op, editable: true, sourceItems: [], ops: [im.op], opsExclusive: true, bounds: im.bbox })
    imageIds.push(id)
  }

  // ---- 6. operator ownership -------------------------------------------------------------
  const opOwner = new Map<number, Set<string>>()
  const ownerOfItem = new Map<number, string>()
  for (const o of Object.values(objects)) {
    if (o.type === 'TEXT_LINE') for (const i of o.sourceItems) ownerOfItem.set(i, o.id)
  }
  raw.texts.forEach((t, i) => {
    for (const op of t.ops) {
      const s = opOwner.get(op) ?? new Set<string>()
      s.add(ownerOfItem.get(i) ?? `orphan${i}`)
      opOwner.set(op, s)
    }
  })
  for (const o of Object.values(objects)) {
    if (o.type === 'TEXT_BLOCK' || o.type === 'TABLE_CELL' || o.type === 'TEXT_LINE') {
      const lineIds = new Set(o.type === 'TEXT_LINE' ? [o.id] : o.children)
      const ops = new Set<number>()
      let known = o.sourceItems.length > 0
      for (const i of o.sourceItems) {
        if (!raw.texts[i].ops.length) known = false
        for (const op of raw.texts[i].ops) ops.add(op)
      }
      o.ops = [...ops].sort((a, b) => a - b)
      o.opsExclusive = known && o.ops.every((op) => [...(opOwner.get(op) ?? [])].every((owner) => lineIds.has(owner)))
      o.zIndex = o.ops[0] ?? 0
    }
  }
  // a table owns every vector path drawn entirely inside it (rules, borders, cell fills), so it can
  // be moved / deleted / copied as one unit
  for (const t of tables) {
    const tb = objects[t].bounds
    const ops = new Set<number>()
    for (const p of raw.paths) {
      const tol = Math.max(2, p.lineWidth)
      const b = p.bbox
      if (b.x >= tb.x - tol && b.y >= tb.y - tol && b.x + b.w <= tb.x + tb.w + tol && b.y + b.h <= tb.y + tb.h + tol) ops.add(p.op)
    }
    objects[t].ops = [...ops].sort((x, y) => x - y)
    objects[t].opsExclusive = true
  }
  for (const t of tables) objects[t].zIndex = Math.min(...objects[t].children.flatMap((r) => objects[r].children.map((c) => objects[c].zIndex)), objects[t].ops[0] ?? Infinity)

  // ---- roots, hit order, page kind ---------------------------------------------------------
  const roots = [...blockIds, ...tables, ...ruleIds, ...rectIds, ...imageIds].sort((a, b) => objects[a].bounds.y - objects[b].bounds.y || objects[a].bounds.x - objects[b].bounds.x)
  const selectable = Object.values(objects).filter((o) => ['TEXT_BLOCK', 'TABLE_CELL', 'TABLE', 'LINE', 'RECTANGLE', 'IMAGE'].includes(o.type))
  // Smallest first, so a cell wins over its table and a paragraph wins over a background box.
  const area = (o: ContentObject) => (o.type === 'LINE' ? 0 : o.type === 'TABLE_CELL' && !o.text ? o.bounds.w * o.bounds.h * 4 : o.bounds.w * o.bounds.h)
  const hitOrder = selectable.sort((a, b) => area(a) - area(b)).map((o) => o.id)

  const imageArea = raw.images.reduce((s, im) => s + Math.min(im.bbox.w * im.bbox.h, W * H), 0)
  const kind = items.length > 0 ? 'digital' : imageArea > 0.4 * W * H ? 'scanned' : raw.images.length || raw.paths.length ? 'digital' : 'empty'

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  return {
    kind,
    width: W,
    height: H,
    objects,
    roots,
    hitOrder,
    paintOps: raw.paintOps ?? [...new Set([...raw.texts.flatMap((t) => t.ops), ...raw.paths.map((p) => p.op), ...raw.images.map((i) => i.op)])].sort((x, y) => x - y),
    stats: { items: items.length, lines: lines.length, blocks: blockIds.length, tables: tables.length, rules: ruleIds.length, rects: rectIds.length, images: imageIds.length, ms: Math.round((t1 - t0) * 10) / 10 },
  }

  // ---- helpers (closures over objects) ----
  function addLine(l: Line, parent: string) {
    const spans: string[] = []
    let cur: Item[] = []
    let spanN = 0
    const flushSpan = () => {
      if (!cur.length) return
      const id = `${l.id}s${++spanN}`
      const f = cur[0]
      add({
        id, type: 'TEXT_SPAN', parent: l.id, children: [], zIndex: 0, editable: false,
        bounds: union(cur.map((c) => ({ x: c.x, y: c.top, w: c.width, h: c.bottom - c.top }))),
        sourceItems: cur.map((c) => c.idx), ops: [...new Set(cur.flatMap((c) => c.ops))], opsExclusive: false,
        text: joinItems(cur),
        style: { fontFamily: f.family, fontName: f.fontName, fontSize: round1(f.size), bold: f.isBold, italic: f.isItalic, color: f.color, align: 'left', lineHeight: 1.2, charSpacing: 0 },
      })
      spans.push(id)
      cur = []
    }
    for (const it of l.items) {
      const p = cur[cur.length - 1]
      if (p && (p.fontName !== it.fontName || Math.abs(p.size - it.size) > 0.2 || p.color !== it.color)) flushSpan()
      cur.push(it)
    }
    flushSpan()
    add({
      id: l.id, type: 'TEXT_LINE', parent, children: spans, zIndex: 0, editable: false,
      bounds: lineBox(l), sourceItems: l.items.map((i) => i.idx), ops: [...new Set(l.items.flatMap((i) => i.ops))], opsExclusive: false,
      text: l.text, firstBaseline: l.baseline, textRuns: joinWithRuns(l.items).runs,
      style: dominantStyle(l.items, 'left', 1.2),
    })
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const round1 = (n: number) => Math.round(n * 10) / 10

function contains(box: Box, l: { x: number; right: number; top: number; bottom: number }, tol = 1) {
  return l.x >= box.x - tol && l.right <= box.x + box.w + tol && (l.top + l.bottom) / 2 >= box.y - tol && (l.top + l.bottom) / 2 <= box.y + box.h + tol
}

function joinItems(items: Item[]): string {
  return joinWithRuns(items).text
}

/** Joined text of items plus, for each item, the character range it produced and its x extent. */
function joinWithRuns(items: Item[]): { text: string; runs: TextRun[] } {
  let s = ''
  const out: TextRun[] = []
  items.forEach((it, i) => {
    if (i > 0) {
      const p = items[i - 1]
      const gap = it.x - (p.x + p.width)
      if (gap > 0.12 * it.size && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' '
    }
    out.push({ s: s.length, e: s.length + it.str.length, x0: it.x, x1: it.x + it.width, family: it.family })
    s += it.str
  })
  const text = s.replace(/\s+$/, '')
  return { text, runs: out.filter((r) => r.s < text.length).map((r) => ({ ...r, e: Math.min(r.e, text.length) })) }
}

function makeLine(id: string, its: Item[]): Line {
  const chars = (i: Item) => i.str.trim().length
  let size = its[0].size
  let n = -1
  for (const i of its) if (chars(i) > n) [size, n] = [i.size, chars(i)]
  return {
    id,
    items: its,
    x: Math.min(...its.map((i) => i.x)),
    right: Math.max(...its.map((i) => i.x + i.width)),
    baseline: its.reduce((s, i) => s + i.baseline * chars(i), 0) / Math.max(1, its.reduce((s, i) => s + chars(i), 0)) || its[0].baseline,
    top: Math.min(...its.map((i) => i.top)),
    bottom: Math.max(...its.map((i) => i.bottom)),
    size,
    text: joinItems(its),
    allBold: its.every((i) => i.isBold || !i.str.trim()),
    used: false,
  }
}

function dominantStyle(its: Item[], align: TextStyle['align'], lineHeight: number): TextStyle {
  const weight = new Map<Item, number>()
  for (const i of its) weight.set(i, i.str.trim().length)
  const d = [...its].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))[0]
  return {
    fontFamily: d.family,
    fontName: d.fontName,
    fontSize: round1(d.size),
    bold: d.isBold,
    italic: d.isItalic,
    color: d.color,
    align,
    lineHeight: round1(lineHeight * 100) / 100,
    charSpacing: 0,
  }
}

/** Text, style, alignment, line height and hard breaks for a stack of lines (block or cell). */
function textProps(ls: Line[], bounds: Box, page?: { W: number; textRight: number }) {
  const right = Math.max(...ls.map((l) => l.right))
  const size = median(ls.map((l) => l.size))
  let align: TextStyle['align'] = 'left'
  if (ls.length >= 2) {
    const lefts = ls.map((l) => l.x)
    const rights = ls.map((l) => l.right)
    const centers = ls.map((l) => (l.x + l.right) / 2)
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v)
    const lAligned = spread(lefts) < 2
    const rAligned = spread(rights.slice(0, -1)) < 2 && ls.length >= 3
    if (lAligned && rAligned && spread(rights) > 2) align = 'justify'
    else if (lAligned) align = 'left'
    else if (spread(rights) < 2) align = 'right'
    else if (spread(centers) < 2.5) align = 'center'
  } else if (page) {
    const l = ls[0]
    const cx = (l.x + l.right) / 2
    if (Math.abs(cx - page.W / 2) < 3 && l.x > page.W * 0.15) align = 'center'
    else if (l.x > page.W / 2 && Math.abs(l.right - page.textRight) < 3) align = 'right'
  }
  const gaps = ls.slice(1).map((l, k) => l.baseline - ls[k].baseline)
  const lineHeight = gaps.length ? median(gaps) / size : 1.2
  // A line break is "hard" if the next line's first word would have fit on this line.
  const hardBreaks = ls.slice(0, -1).map((l, k) => {
    const next = ls[k + 1]
    const firstWord = next.text.split(/\s+/)[0] ?? ''
    const perChar = (next.right - next.x) / Math.max(1, next.text.length)
    const need = (firstWord.length + 1) * perChar
    return l.right + need < right - 1 || /[:;]$/.test(l.text.trim()) || BULLET.test(next.text)
  })
  let text = ''
  ls.forEach((l, k) => {
    if (k > 0) {
      const prev = text
      if (hardBreaks[k - 1]) text += '\n'
      else if (!/-$/.test(prev)) text += ' '
    }
    text += l.text
  })
  return {
    text,
    style: dominantStyle(ls.flatMap((l) => l.items), align, Math.min(3, Math.max(1, lineHeight))),
    hardBreaks,
    firstBaseline: ls[0].baseline,
    bounds,
  }
}

function roleOf(o: ContentObject, ls: Line[], p: { H: number; bodySize: number }): Role {
  const b = o.bounds
  if (b.y + b.h < p.H * 0.075 && ls.length <= 2) return 'header'
  if (b.y > p.H * 0.925 && ls.length <= 2) return 'footer'
  if (BULLET.test(ls[0].text)) return 'list-item'
  const size = o.style?.fontSize ?? p.bodySize
  if (ls.length <= 3 && size >= p.bodySize * 1.18) return 'heading'
  if (ls.length <= 2 && ls.every((l) => l.allBold) && (o.text?.length ?? 0) < 90) return 'heading'
  return 'paragraph'
}

/**
 * Column boundaries from the horizontal projection of lines (Tabula/Camelot "stream" idea):
 * x-ranges covered by text are merged; the remaining gaps are column gutters.
 */
function columnsFromProjection(ls: Line[], x1: number, x2: number): number[] | null {
  const iv = ls.map((l) => [l.x, l.right]).sort((a, b) => a[0] - b[0])
  const merged: number[][] = []
  const minGap = Math.max(6, median(ls.map((l) => l.size)) * 0.9)
  for (const [a, b] of iv) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1] + minGap) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  if (merged.length < 2) return null
  const edges = [Math.min(x1, merged[0][0]) - 1]
  for (let k = 1; k < merged.length; k += 1) edges.push(merged[k][0] - Math.min(4, (merged[k][0] - merged[k - 1][1]) / 2))
  edges.push(Math.max(x2, merged[merged.length - 1][1]) + 1)
  return edges
}

function prevBottom(run: Line[][], starts: boolean[], k: number): number {
  // bottom of the last row (including its continuation lines) before the k-th row start
  let seen = -1
  let idx = -1
  for (let r = 0; r < run.length; r += 1) {
    if (starts[r]) seen += 1
    if (seen === k) {
      idx = r
      break
    }
  }
  return Math.max(...run[Math.max(0, idx - 1)].map((l) => l.bottom))
}
