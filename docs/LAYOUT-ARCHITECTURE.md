# Layout-object architecture (v3)

Status: Phases 1–2 implemented (normalized layout model, providers, bounding-box overlay, object tree). Phases 3–11 are
planned below. Baseline before this work: git tag `v0.2-edit-mode`.

---

## A. Current architecture (as inspected)

| Concern | Where | Notes |
|---|---|---|
| Rendering | `components/Viewer.tsx` | PDF.js renders each visible page into a canvas (virtualized list). Edited objects are hidden **exactly** by re-rendering with `operationsFilter`, skipping the operators that painted them. User rotation is a CSS transform (`ui.tsx › Rotated`) around the canvas *and* every overlay, so overlays rotate for free. |
| Parsing / extraction | `lib/pdfjs.ts`, `lib/content/extract.ts` | One PDF.js document per source, kept in a registry. `extractPage` walks `getOperatorList()` (CTM stack, text state, colours, paths, images, form XObjects) and matches `getTextContent()` items to their `showText` operators. Real font names come from the embedded font program's OpenType `name` table. |
| Structural analysis | `lib/content/analyze.ts` | Pure function `RawPage → PageContent`. Produces a tree of `ContentObject`s: `TEXT_BLOCK ▸ TEXT_LINE ▸ TEXT_SPAN`, `TABLE ▸ TABLE_ROW ▸ TABLE_CELL ▸ TEXT_LINE`, `LINE`, `RECTANGLE`, `IMAGE`, with role (heading, paragraph, list-item, header, footer), style, and **operator ownership** (`ops`, `opsExclusive`). Cached per source page (`content/cache.ts`), prefetched when idle. |
| Internal representation | `lib/content/types.ts` | Geometry in *view space*: points, top-left origin, intrinsic `/Rotate` applied. This is already a single canonical space; conversions live in `lib/coords.ts` (+ DOM pointer maths in `lib/geom.ts`). |
| Edit storage | `lib/model.ts` | Pages hold `overlays[]`. Editing a detected object creates an overlay that references it (`source: {objectId, ops, bounds, exclusive}`): a `TextOverlay` (new text/style/position) or a `GraphicOverlay` (moved/resized/deleted line, rect, image). Original bytes are never touched. Reducer with snapshot undo/redo (`past`/`future`), drafts, coalesced edits. |
| Export | `lib/export.ts`, `lib/pdf/pageEdit.ts`, `lib/pdf/contentStream.ts` | pdf-lib copies pages; `pageEdit` tokenizes + interprets each page's content stream and **removes** (or re-transforms, for images) the operators of edited objects; covers are a fallback only. New text/graphics are drawn after. Real PDF, selectable text. |

**Works today (65 tests + manual):** upload, viewer, thumbnails, reorder, delete/duplicate/rotate/extract/insert pages,
Add Text, Edit mode (hover/select/edit/move/resize/delete of one object), true content-stream removal on export,
undo/redo, debug view.

## B. Proposed architecture

```
PDF bytes
  │
  ├─► PDF.js render (unchanged)                                       … canvas, exact hiding via operationsFilter
  │
  └─► LayoutExtractionProvider  (lib/layout/provider.ts)
        ├─ LocalLayoutExtractor   extract.ts ► analyze.ts ► fromContent.ts   (default, on-device)
        │    └─ fallback: PDF.js text items ► basic.ts  (TEXT_SPAN chunks)
        └─ AdobeLayoutExtractor   backend proxy ► Extract JSON ► adobe.ts     (optional, off by default)
                    │
                    ▼
        LayoutPage { chunks: Record<id, LayoutChunk>, roots, hitOrder, status, provider }   (lib/layout/types.ts)
                    │  cached per source page (lib/layout/cache.ts)
                    ▼
        Interactive canvas: bounding boxes, object tree, hover/selection (Phase 3+)
                    │
                    ▼
        Edit operations (non-destructive; Phase 5+): deletedSourceIds, modified (transform/text/style), inserted
                    │
                    ▼
        Export: existing pageEdit removal/transform + draw inserted/modified chunks
```

Key decisions:

1. **Reuse, don't rewrite.** `analyze.ts` already builds the object tree; `fromContent.ts` is an adapter from
   `ContentObject` to the normalized `LayoutChunk`. Chunk ids equal the underlying object ids, so the existing Edit-mode,
   overlay and export code keep working while the UI migrates to chunks.
2. **Provider-agnostic.** The editor only ever sees `LayoutChunk`. Adobe's JSON never leaves `adobe.ts`.
3. **One coordinate system.** All chunk bounds are in *canonical page space* (see §F).
4. **Fallback chain:** structured chunks → basic PDF.js text spans → existing text-overlay editor (Add Text) →
   page-level operations. A failing page never takes the app down.

## C. Reusable as-is

PDF.js registry and rendering, `operationsFilter` hiding, `extract.ts`, `analyze.ts` (all heuristics and 16 analyzer
tests), the content-stream tokenizer/interpreter and removal (`pageEdit.ts`), the export pipeline, the reducer and undo
architecture, thumbnails, page operations, the Anduin UI kit, the layout test suite and fixtures.

## D. Exact changes (all phases)

| Phase | Change |
|---|---|
| 1 ✅ | `lib/layout/types.ts` (LayoutChunk model), `fromContent.ts` (local adapter, adds HEADING/PARAGRAPH/LIST/LIST_ITEM semantics and LIST grouping), `basic.ts` (fallback), `adobe.ts` (Adobe adapter, pure + tested), `provider.ts` (provider interface, local + Adobe providers), `cache.ts`, `tree.ts`. `lib/coords.ts`: `pdfToCanvas` / `canvasToPdf` / `canvasToScreen` / `screenToCanvas`. |
| 2 ✅ | `components/LayoutLayer.tsx` (bounding boxes, debug inspector, tree highlight; replaces `DebugLayer`), `components/ObjectTreePanel.tsx`. Toolbar toggle **Show bounding boxes** (B), ⋯ menu: Show detected objects (⇧⌘D), Show object tree, layout engine. `npm run analyze` prints the chunk tree. |
| 3 | Edit-mode hit-testing on `LayoutPage.hitOrder` with hierarchy cycling (click = innermost meaningful object; Esc/⌥-click = parent: cell → row → table). Spatial grid index if a page has > 2k chunks. |
| 4 | `selectedIds: string[]` per document (context, not undo history); marquee rubber band; Shift-click toggle. |
| 5 | `GroupSelectionBounds`; rigid group drag. Implementation: one `moveChunks{ids, dx, dy}` reducer action that turns each selected source chunk into the existing overlays (text keeps its line breaks: `wrap=false`, `lineBreaks` from `hardBreaks` + soft wraps; graphics translate). Children move with their parent; no reflow. |
| 6 | Delete for any selection (existing per-object delete generalized). |
| 7 | `PDFBlockPayload` clipboard: chunks normalized to the selection's top-left; paste = inserted chunks rendered as overlays (+20/+20 in the same document). |
| 8 | `DocumentTab[]`: each tab owns its `DocState` (already self-contained: sources, pages, history). PDF.js registry is already keyed by source id, so tabs share it. |
| 9 | App-level clipboard + `BroadcastChannel('anduin-pdf-clipboard')` for other browser tabs, `navigator.clipboard` writing plain text + `web application/x-pdf-blocks+json` where supported. |
| 10 | Word → PDF (see §H). |
| 11 | Polish, tests, README. |

## E. Local extraction vs Adobe Extract

**Recommendation: local extraction is the default and the only mandatory path; Adobe Extract is an optional,
explicitly-enabled provider behind a backend.**

| | Local (PDF.js + content stream + heuristics) | Adobe PDF Extract API |
|---|---|---|
| Privacy | Document never leaves the browser | Upload to Adobe cloud: needs legal/security sign-off for confidential fund documents |
| Latency | ~5–40 ms/page, incremental | Upload + async job, seconds to tens of seconds per document |
| Quality, digital PDFs | Good on business documents (tested on 9 layout types); weaker on merged cells, complex forms | Strong semantics (H1–H6, lists, TOC, footnotes, spans, row/col spans), Sensei ML |
| Scanned PDFs | No OCR | OCR included |
| **Editability** | Knows exactly which content-stream operators painted each object → exact hiding and true removal on export | Bounds only. To edit, its elements must be re-associated with operators (we do this by geometry), so removal is approximate |
| Cost / availability | Free, offline | Paid per transaction, credentials, network |

Editing needs operator ownership, which only the local pipeline has. Adobe is most useful as a *second opinion on
semantics* (headings, lists, spanning cells) and for scanned pages. The adapter is written, and the provider calls only a
backend proxy (`VITE_LAYOUT_SERVICE_URL`), never Adobe directly, so no credentials reach the browser. With no URL
configured it reports *unavailable* and is not selectable.

## F. The normalized LayoutChunk model

See `src/lib/layout/types.ts` for the authoritative definition.

```ts
interface LayoutChunk {
  id: string                 // stable within a page; equals the ContentObject id for local chunks
  type: ChunkType            // HEADING PARAGRAPH LIST LIST_ITEM TEXT_LINE TEXT_SPAN TABLE TABLE_ROW TABLE_CELL
                             // LINE RECTANGLE IMAGE FIGURE
  sourceId: string; pageIndex: number   // source document + 0-based page in that source (stable under reorder)
  bounds: { x, y, width, height }       // canonical page space
  rotation: number           // content rotation (deg) relative to the page
  transform: Matrix          // identity as extracted; edits compose translations/scales here (Phase 5)
  parent: string | null; children: string[]
  editable: boolean
  text?: string
  style?: { fontFamily, fontName, fallbackFont, fontSize, fontWeight, italic, underline, color,
            alignment, lineHeight, characterSpacing }
  role?: 'title' | 'header' | 'footer' | 'footnote' | 'caption' | 'toc'
  level?: number             // heading level 1–6
  table?: { rows, columns, cells: string[][], rowEdges?, colEdges?, kind }
  cell?: { row, col, rowSpan, colSpan, header }
  line?: { x1, y1, x2, y2, strokeWidth, color }
  shape?: { fill, stroke, strokeWidth }
  image?: { ref?, rotation }
  source: { provider, objectId?, ops?, opsExclusive?, path?, confidence? }
}
```

**Canonical page space** (`lib/coords.ts`): PDF points, origin at the top-left of the visible page box, y down, page's
intrinsic `/Rotate` applied; independent of zoom and of rotation added in the app. Conversions are only:

- `pdfToCanvas(info, pt)` / `canvasToPdf(info, pt)`: PDF user space (bottom-left, unrotated) ↔ canonical
- `pdfRectToCanvas` / `canvasRectToPdf`: the same for rectangles (Adobe `Bounds` are `[left, bottom, right, top]`)
- `canvasToScreen(pt, view)` / `screenToCanvas(pt, view)`: canonical ↔ on-screen pixels for a zoom + app rotation

## G. Non-destructive export

The edit model stays *original bytes + a list of operations*. Today the operations are overlays with a `source` link.
Phase 5+ formalizes them per page:

```
deletedSourceIds:  chunk ids whose painting operators are removed
modified:          { chunkId → { transform?, text?, style? } }   (moved/resized/re-styled/re-typed source chunks)
inserted:          LayoutChunk[] with no source (pasted / duplicated / new text)
```

Export, per page: (1) collect the operator sets of every deleted or modified source chunk → `pageEdit` removes them
(text: equivalent `TJ` advance; paths: whole path or sub-path; images: removed, or re-wrapped in a `cm` so a moved image
reuses the original image stream); (2) when removal is not provably safe (operator shared with untouched content, Form
XObject) fall back to a colour-sampled cover; (3) draw modified and inserted chunks as real PDF text/vector/image content.
Page size, `/Rotate`, links and all untouched operators are preserved byte-for-byte. No rasterization. Cross-document
paste of an image needs the image XObject copied into the target document: pdf-lib's `copyPages` of the source page
plus a clipped Form XObject (`embedPage` with a bounding box) does this without re-encoding.

## H. Word → PDF conversion options

The requirement is *real Word layout*, so fields (REF / PAGEREF / TOC / NOTEREF), bookmarks, footnotes, numbering and
section properties must be rendered by an engine that understands them, and converted links/bookmarks must survive.

| Option | Fidelity | References & bookmarks | Availability here | Licensing | Privacy | Complexity |
|---|---|---|---|---|---|---|
| **Microsoft Word (desktop) automation**: `ExportAsFixedFormat` / "Save as PDF" via AppleScript (macOS) or COM (Windows) | Reference renderer: identical to Word | Updates fields on demand, exports headings/bookmarks as PDF outline, keeps internal + external hyperlinks | **Installed on this Mac** | Existing M365 licence; not for multi-user server use | Local | Low for a demo (small local helper service); not a production server pattern |
| **Microsoft Graph** `GET /drives/{id}/items/{id}/content?format=pdf` | Word Online renderer, very close to desktop | Good; hyperlinks kept; bookmarks/outline weaker | Needs an Entra app + a SharePoint/OneDrive location in our tenant | M365 | Stays in our M365 tenant | Medium (auth, upload, delete) |
| **LibreOffice headless** (`soffice --convert-to pdf`, or Gotenberg) | Good but not Word: font metrics and complex tables/sections can shift pagination | Keeps cached field results; bookmarks + links exported (`ExportBookmarks`); some field types re-computed differently | Not installed (Docker/brew) | MPL, free | On-prem | Low–medium |
| **Adobe PDF Services `createPDF`** | High (Adobe's Office conversion) | Generally good; links + bookmarks | Needs Adobe credentials | Paid | Third-party cloud | Medium |
| Aspose.Words / Syncfusion (commercial SDK) | High, own layout engine | Strong field support | Licence purchase | Commercial | On-prem | Medium |
| ~~DOCX → text/HTML → new PDF~~ (mammoth, docx-preview, browser print) | Low | Destroys fields, pagination, footnotes | n/a | n/a | n/a | **Rejected** |

**Recommendation.** Hackathon: a small local conversion helper (`server/convert`, Node) that drives the installed
**Microsoft Word** to export PDF, with LibreOffice as a second engine when Word is unavailable. The browser posts the
file to `localhost`, receives the PDF and opens it in a new tab. Production: Microsoft Graph conversion inside the Anduin
M365 tenant (true Word rendering, no third party), or LibreOffice/Gotenberg on-prem if Graph is not allowed.

**Reference test plan.** A synthetic `.docx` fixture with: a TOC, numbered headings, bookmarks, `REF`/`PAGEREF`
cross-references (including one deliberately broken to reproduce "Error! Reference source not found."), footnotes, a
section break with landscape orientation, headers/footers, external + internal hyperlinks. After conversion the test
checks: text contains no "Reference source not found" (except the deliberate one), the PDF outline has the headings,
link annotations point to the right pages, and footnote text is present.
