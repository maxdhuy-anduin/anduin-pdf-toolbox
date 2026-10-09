// Deleting objects must remove exactly them: on the fund sample, the 9-page layout suite and the
// app's sample PDF (a real, Word-generated 14-page CRS form, public/samples), every
// other text object is deleted in one export (both alternations), then the reopened file is checked:
// deleted text is gone (true removal, never just covered) and every kept object's text is still there.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPage } from './content/extract'
import { analyzePage } from './content/analyze'
import { buildPdf } from './export'
import { makePage, type PageInfo } from './model'
import { moveOverlayFor, isTextObject } from './content/edits'
import { createSampleFund } from './samples'
import { createLayoutSuite } from './testDocs'

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
describe('deleting objects removes exactly them', () => {
const crs = async () => new Uint8Array(readFileSync(new URL('../../public/samples/sample-crs-fcl.pdf', import.meta.url)))
for (const [which, make] of [['fund', createSampleFund], ['suite', createLayoutSuite], ['crs sample', crs]] as const) {
  for (const parity of [0, 1]) it(`${which}: delete every other text object (${parity ? 'odd' : 'even'})`, async () => {
    const bytes = await make()
    const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true }).promise
    const pages: PageInfo[] = []
    const contents: ReturnType<typeof analyzePage>[] = []
    const raws: Awaited<ReturnType<typeof extractPage>>[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n)
      const vp = p.getViewport({ scale: 1 })
      pages.push({ view: p.view as PageInfo['view'], rotate: p.rotate as PageInfo['rotate'], width: vp.width, height: vp.height })
      raws.push(await extractPage(p, pdfjs as never))
      contents.push(analyzePage(raws[raws.length - 1]))
    }
    const meta = { id: 'r', name: 'r', size: bytes.length, numPages: doc.numPages, pages, likelyScanned: false }
    const models = contents.map((c, i) => {
      const texts = Object.values(c.objects).filter((o) => isTextObject(o))
      const del = texts.filter((_, k) => k % 2 === parity)
      const keep = texts.filter((_, k) => k % 2 !== parity)
      return { page: { ...makePage('r', i), overlays: del.map((o) => moveOverlayFor(o, { deleted: true })) }, del, keep }
    })
    const r = await buildPdf(models.map((m) => m.page), { r: meta }, () => bytes)
    const out = await pdfjs.getDocument({ data: r.bytes.slice(), verbosity: 0 }).promise
    const res = { keptPresent: 0, keptMissing: [] as string[], deletedGone: 0, deletedStill: [] as string[] }
    for (let i = 0; i < out.numPages; i++) {
      const txt = norm((await (await out.getPage(i + 1)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(''))
      const src = norm((await (await doc.getPage(i + 1)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(''))
      // a kept object is intact when every text run it is made of is still painted (checked run by run:
      // how PDF.js joins neighbouring runs into a string changes when a neighbour is removed)
      for (const o of models[i].keep) {
        const runs = o.sourceItems.map((k) => norm(raws[i].texts[k].str)).filter((t) => t.length >= 3)
        if (!runs.length) continue
        const lost = runs.filter((t) => !txt.includes(t))
        if (!lost.length) res.keptPresent++
        else res.keptMissing.push(`p${i + 1} ${o.type} ${o.id}: ${lost.join(' | ').slice(0, 60)}`)
      }
      for (const o of models[i].del) {
        const t = norm(o.text ?? '')
        if (t.length < 6 || src.split(t).length > 2) continue // too short / repeated on the page to judge
        if (!txt.includes(t)) res.deletedGone++
        else res.deletedStill.push(`p${i + 1} ${o.type} ${o.id}: ${o.text?.slice(0, 50)}`)
      }
    }
    // never any collateral loss, and every deletion is a true removal (nothing only covered)
    expect(res.keptMissing).toEqual([])
    expect(r.stats.covered).toBe(0)
    expect(r.warnings).toEqual([])
    expect(res.deletedStill).toEqual([])
    expect(res.keptPresent).toBeGreaterThan(40)
    expect(res.deletedGone).toBeGreaterThan(30)
  })
}
})
