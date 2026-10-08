// Generates edge-case PDFs into ./test-fixtures (git-ignored) for manual/browser testing:
//   invalid.pdf   - not a PDF at all
//   truncated.pdf - a real PDF cut in half
//   scanned.pdf   - image-only pages (no text layer)
//   mixed.pdf     - mixed page sizes, intrinsic rotation, offset crop box
//   big.pdf       - 400 pages
// encrypted.pdf is created separately with scripts/make-encrypted.swift (macOS PDFKit).
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { createSampleFund } from '../src/lib/samples.ts'

const out = new URL('../test-fixtures/', import.meta.url).pathname
mkdirSync(out, { recursive: true })

// minimal grayscale PNG encoder
function png(w, h, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]) }
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = pixel(x, y) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

writeFileSync(out + 'invalid.pdf', 'This is definitely not a PDF file.\n'.repeat(20))

const sample = await createSampleFund()
writeFileSync(out + 'truncated.pdf', sample.slice(0, Math.floor(sample.length / 2)))

{
  const doc = await PDFDocument.create()
  const img = await doc.embedPng(png(300, 400, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? 235 : 190))
  for (let i = 0; i < 3; i++) { const p = doc.addPage([612, 792]); p.drawImage(img, { x: 40, y: 40, width: 532, height: 712 }) }
  writeFileSync(out + 'scanned.pdf', await doc.save())
}

{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const mk = (w, h, label, rot = 0) => { const p = doc.addPage([w, h]); p.drawText(label, { x: 50, y: h - 80, size: 22, font }); p.drawRectangle({ x: 30, y: 30, width: w - 60, height: h - 60, borderColor: rgb(0.2, 0.2, 0.6), borderWidth: 1 }); if (rot) p.setRotation(degrees(rot)); return p }
  mk(612, 792, 'Letter portrait')
  mk(842, 595, 'A4 landscape')
  mk(595, 842, 'A4 portrait, /Rotate 90', 90)
  mk(612, 792, 'Letter, /Rotate 180', 180)
  mk(400, 300, 'Small, /Rotate 270', 270)
  const off = mk(612, 792, 'Crop box offset')
  off.setCropBox(50, 100, 400, 500)
  writeFileSync(out + 'mixed.pdf', await doc.save())
}

{
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  for (let i = 1; i <= 400; i++) {
    const p = doc.addPage([612, 792])
    p.drawText(`Stress test document — page ${i} of 400`, { x: 60, y: 720, size: 20, font })
    for (let l = 0; l < 40; l++) p.drawText(`Line ${l + 1}: The quick brown fox jumps over the lazy dog ${i}.${l}`, { x: 60, y: 680 - l * 15, size: 10, font })
  }
  writeFileSync(out + 'big.pdf', await doc.save())
}
console.log('fixtures written to', out)
