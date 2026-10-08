// Dev tool: node scripts/analyze-debug.ts [suite|fund|path.pdf] [page]
import { readFileSync } from 'node:fs'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { extractPage } from '../src/lib/content/extract.ts'
import { analyzePage } from '../src/lib/content/analyze.ts'
import { createLayoutSuite } from '../src/lib/testDocs.ts'
import { createSampleFund } from '../src/lib/samples.ts'

const which = process.argv[2] ?? 'suite'
const only = process.argv[3] ? Number(process.argv[3]) : null
const bytes = which === 'suite' ? await createLayoutSuite() : which === 'fund' ? await createSampleFund() : new Uint8Array(readFileSync(which))
const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0, fontExtraProperties: true, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise
for (let n = 1; n <= doc.numPages; n += 1) {
  if (only && n !== only) continue
  const page = await doc.getPage(n)
  const raw = await extractPage(page, pdfjs as never)
  const c = analyzePage(raw)
  console.log(`\n=== page ${n} [${c.kind}] ${JSON.stringify(c.stats)}  raw: ${raw.texts.length} items, ${raw.paths.length} paths, ${raw.images.length} images, ${raw.texts.filter((t) => !t.ops.length).length} items w/o ops`)
  const show = (id: string, depth: number) => {
    const o = c.objects[id]
    const b = o.bounds
    const st = o.style ? ` ${o.style.fontFamily}${o.style.bold ? ' B' : ''}${o.style.italic ? ' I' : ''} ${o.style.fontSize}pt ${o.style.color ?? ''} ${o.style.align} lh=${o.style.lineHeight}` : ''
    const extra = o.type === 'TABLE' ? ` ${o.tableKind} ${o.rows}x${o.cols}` : o.type === 'LINE' ? ` t=${o.thickness?.toFixed(1)} ${o.strokeColor}` : o.type === 'RECTANGLE' ? ` fill=${o.fillColor} stroke=${o.strokeColor}` : ''
    const txt = o.text !== undefined ? ` "${o.text.replace(/\n/g, '⏎').slice(0, 70)}"` : ''
    console.log(`${'  '.repeat(depth)}${o.type}${o.role ? '/' + o.role : ''} ${o.id} [${b.x.toFixed(0)},${b.y.toFixed(0)} ${b.w.toFixed(0)}x${b.h.toFixed(0)}]${extra}${st}${o.opsExclusive ? ' excl' : ''}${txt}`)
    if (o.type === 'TABLE') for (const r of o.children) for (const cid of c.objects[r].children) if (c.objects[cid].text) show(cid, depth + 1)
  }
  for (const id of c.roots) show(id, 1)
}
