// Regressions found in the pre-release audit, each reproduced on a minimal PDF and checked in the
// exported file (not only in the model).
import { PDFName } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildPdf } from './export'
import { makePage, type Overlay, type PageModel } from './model'
import { copySelection, pageItems, planDelete, planMove, type OverlayEdits } from './objects'
import { moveOverlayFor } from './content/edits'
import { analyzed, metaFromBytes, rawPage, viewItems } from '../test/helpers'

const apply = (p: PageModel, e: OverlayEdits): PageModel => {
  const drop = new Set(e.remove)
  const patches = new Map(e.update.map((u) => [u.id, u.patch]))
  return { ...p, overlays: [...p.overlays.filter((o) => !drop.has(o.id)).map((o) => (patches.has(o.id) ? ({ ...o, ...patches.get(o.id) } as Overlay) : o)), ...e.add] }
}

describe('audit regressions', () => {
  it('moving a table twice moves its cells once (cells whose text operator is shared by the row)', async () => {
    // each row is drawn by one TJ, so cells can't be moved by their operators and are re-typeset
    const row = (y: number, a: string, b: string, c: string) => `BT /F1 10 Tf 72 ${y} Td [(${a}) -10000 (${b}) -10000 (${c})] TJ ET`
    const bytes = await rawPage([row(700, 'Name', 'Amount', 'Date'), row(682, 'Alpha', '100', '2020'), row(668, 'Beta', '200', '2021'), '72 660 m 400 660 l 72 712 m 400 712 l 72 695 m 400 695 l S'].join('\n'))
    const content = await analyzed(bytes)
    const tbl = Object.values(content.objects).find((o) => o.type === 'TABLE')!
    expect(tbl).toBeTruthy()
    let page = makePage('a', 0)
    let e = planMove(page, content, [`o:${tbl.id}`], 0, 100)
    page = apply(page, e)
    e = planMove(page, content, e.keys, 0, 100)
    page = apply(page, e)
    const texts = page.overlays.filter((o) => o.type === 'text')
    // (rows 2-3 have no rule between them, so they form one cell: "Alpha Beta")
    expect(texts.filter((t) => t.type === 'text' && t.text.includes('Alpha'))).toHaveLength(1)
    const meta = await metaFromBytes('a', 'a.pdf', bytes)
    const r = await buildPdf([page], { a: meta }, () => bytes)
    const alpha = (await viewItems(r.bytes, 0)).filter((i) => i.str.includes('Alpha'))
    const near = (y: number) => alpha.filter((i) => Math.abs(i.y - y) < 3).length
    expect(near(792 - 682 + 200)).toBe(1) // drawn once, at +200
    expect(near(792 - 682 + 100)).toBe(0) // no stale copy from the first move
    // the row's single text operator can't be removed per cell: the original stays, covered, and the export says so
    expect(near(792 - 682)).toBe(1)
    expect(r.warnings.some((w) => /still in the file/.test(w))).toBe(true)
    // copying the moved table copies what is shown, at its new place
    const copied = copySelection(page, content, pageItems(content, page.overlays), [`o:${tbl.id}`])!
    expect(copied.texts.filter((t) => t.text.includes('Alpha'))).toHaveLength(1)
    // and deleting it leaves nothing behind
    page = apply(page, planDelete(page, content, e.keys))
    expect(page.overlays.filter((o) => o.type === 'text' && o.text)).toEqual([]) // stand-ins emptied, none re-created
    const d = await buildPdf([page], { a: meta }, () => bytes)
    const left = (await viewItems(d.bytes, 0)).filter((i) => i.str.includes('Alpha'))
    expect(left.map((i) => Math.round(i.y))).toEqual([792 - 682]) // only the covered original…
    expect(d.warnings.some((w) => /still in the file/.test(w))).toBe(true) // …which the export reports
  })

  it("moving or deleting a paragraph leaves another object's footnote marker inside its box alone", async () => {
    const bytes = await rawPage(`BT /F1 10 Tf 72 700 Td (This is a paragraph with a note) Tj ET
BT /F1 6 Tf 222 704 Td (1) Tj ET
BT /F1 10 Tf 72 688 Td (second line of the same paragraph text goes here ok) Tj ET
BT /F1 10 Tf 72 676 Td (third line of the paragraph wraps around here too.) Tj ET`)
    const content = await analyzed(bytes)
    const para = Object.values(content.objects).find((o) => o.type === 'TEXT_BLOCK' && o.text?.startsWith('This'))!
    const marker = Object.values(content.objects).find((o) => o.type === 'TEXT_BLOCK' && o.text === '1')!
    expect(marker).toBeTruthy()
    expect(para.ops).not.toContain(marker.ops[0]) // the screen leaves the marker where it is…
    const meta = await metaFromBytes('a', 'a.pdf', bytes)
    const markerAt = (await viewItems(bytes, 0)).find((i) => i.str === '1')!
    for (const ov of [moveOverlayFor(para, { dy: 300 }), moveOverlayFor(para, { deleted: true })]) {
      const r = await buildPdf([{ ...makePage('a', 0), overlays: [ov] }], { a: meta }, () => bytes)
      const items = await viewItems(r.bytes, 0)
      const m = items.filter((i) => i.str === '1') // …and so must the export
      expect(m).toHaveLength(1)
      expect(m[0].y).toBeCloseTo(markerAt.y, 1)
      expect(r.stats.covered).toBe(0)
      expect(items.some((i) => i.str.startsWith('This is a paragraph'))).toBe(!ov.deleted)
    }
  })

  it('a rule inside a table, moved on its own and then with the table, is drawn once and moves exactly', async () => {
    const row = (y: number, a: string, b: string, c: string) => `BT /F1 10 Tf 72 ${y} Td (${a}) Tj ET BT /F1 10 Tf 200 ${y} Td (${b}) Tj ET BT /F1 10 Tf 330 ${y} Td (${c}) Tj ET`
    const bytes = await rawPage([row(700, 'Name', 'Amount', 'Date'), '0.5 w 72 695 m 300 695 l S', row(682, 'Alpha', '100', '2020'), row(668, 'Beta', '200', '2021'), row(654, 'Gamma', '300', '2022')].join('\n'))
    const content = await analyzed(bytes)
    const tbl = Object.values(content.objects).find((o) => o.type === 'TABLE')!
    const line = Object.values(content.objects).find((o) => o.type === 'LINE')!
    expect(tbl && line).toBeTruthy()
    const meta = await metaFromBytes('a', 'a.pdf', bytes)
    const rules = async (out: Uint8Array) => Object.values((await analyzed(out)).objects).filter((o) => o.type === 'LINE').map((o) => [Math.round(o.bounds.x), Math.round(o.bounds.y + o.bounds.h / 2)])
    // table moved alone: the rule goes with it, no "could not be moved" warning
    let page = apply(makePage('a', 0), planMove(makePage('a', 0), content, [`o:${tbl.id}`], 50, 0))
    let r = await buildPdf([page], { a: meta }, () => bytes)
    expect(r.warnings).toEqual([])
    expect(await rules(r.bytes)).toEqual([[72 + 50, 792 - 695]])
    // rule moved first (+30 down), then the table (+50 right): the rule ends up at (+50, +30), once
    page = apply(makePage('a', 0), planMove(makePage('a', 0), content, [`o:${line.id}`], 0, 30))
    page = apply(page, planMove(page, content, [`o:${tbl.id}`], 50, 0))
    r = await buildPdf([page], { a: meta }, () => bytes)
    expect(r.warnings).toEqual([])
    expect(await rules(r.bytes)).toEqual([[72 + 50, 792 - 695 + 30]])
  })

  it('copies a rule whose operator also draws another rule (as an equivalent drawn line)', async () => {
    const bytes = await rawPage('BT /F1 10 Tf 72 720 Td (Heading text) Tj ET 1 w 72 700 m 300 700 l 72 600 m 300 600 l S')
    const content = await analyzed(bytes)
    const rules = Object.values(content.objects).filter((o) => o.type === 'LINE')
    expect(rules).toHaveLength(2)
    expect(rules.every((r) => !r.opsExclusive)).toBe(true)
    const top = rules.find((r) => r.bounds.y < 100)!
    const copied = copySelection(makePage('a', 0), content, pageItems(content, []), [`o:${top.id}`])
    expect(copied).not.toBeNull()
    expect(copied!.lines).toHaveLength(1)
    const l = copied!.lines[0]
    expect([l.x1 + copied!.origin.x, l.x2 + copied!.origin.x].map(Math.round)).toEqual([72, 300])
    expect(Math.round(l.y1 + copied!.origin.y)).toBe(792 - 700)
    expect(copied!.skipped ?? 0).toBe(0)
  })

  it('exports pasted content from a page whose font has a malformed /W array', async () => {
    const bytes = await rawPage('BT /F1 12 Tf 72 700 Td (Movable paragraph text) Tj ET BT /F2 12 Tf 72 600 Td <00410042> Tj ET', (doc, page) => {
      const desc = doc.context.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Arial', CIDSystemInfo: { Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 }, W: [1, 2] })
      const f2 = doc.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Arial', Encoding: 'Identity-H', DescendantFonts: [doc.context.register(desc)] })
      page.node.setFontDictionary(PDFName.of('F2'), doc.context.register(f2))
    })
    const content = await analyzed(bytes)
    const para = Object.values(content.objects).find((o) => o.type === 'TEXT_BLOCK' && o.text?.startsWith('Movable'))!
    const page = makePage('a', 0)
    const copied = copySelection(page, content, pageItems(content, []), [`o:${para.id}`])!
    const g = copied.groups[0]
    const paste: Overlay = { id: 'paste1', type: 'paste', sourceId: 'a', srcIndex: 0, items: g.items, dx: g.shift.x + 10, dy: g.shift.y + 300 }
    const r = await buildPdf([{ ...makePage('a', 0), overlays: [paste] }], { a: await metaFromBytes('a', 'a.pdf', bytes) }, () => bytes)
    expect((await viewItems(r.bytes, 0)).filter((i) => i.str === 'Movable paragraph text')).toHaveLength(2)
  })
})
