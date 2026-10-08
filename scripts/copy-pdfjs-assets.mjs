// Copies the PDF.js runtime assets (standard fonts, cmaps, wasm decoders, ICC profiles)
// into public/pdfjs so they are served locally -- nothing is fetched from a CDN.
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const to = join(root, 'public', 'pdfjs')
rmSync(to, { recursive: true, force: true })
mkdirSync(to, { recursive: true })
for (const dir of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) cpSync(join(from, dir), join(to, dir), { recursive: true })
copyFileSync(join(from, 'build', 'pdf.worker.min.mjs'), join(to, 'pdf.worker.min.mjs'))
console.log('pdfjs assets copied to public/pdfjs')
