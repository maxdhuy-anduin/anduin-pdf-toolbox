# Anduin PDF Toolbox

A focused, browser-only PDF tool for the workflows people reach for Acrobat for most: **view, reorder, delete,
duplicate, rotate, insert, extract, and edit PDF content as objects** (paragraphs, headings, tables and cells,
lines, rectangles, images), then **export a real PDF**. Hackathon MVP, not an Acrobat replacement.

**Privacy:** everything runs in the browser. There is no backend, no upload, no analytics and no third-party requests
(PDF.js assets and the Manrope / IBM Plex Mono fonts are served locally). Documents are never written to storage; the only
things remembered locally are the view toggles (boxes, tree, debug). The optional Adobe Extract provider is off unless
`VITE_LAYOUT_SERVICE_URL` points at your own backend; it is never called by default.

## Run it

```bash
npm install        # also copies the PDF.js runtime assets into public/pdfjs
npm run dev        # http://localhost:5173
npm test           # analyzer, content-stream editing, export round-trips, model
npm run build      # type-check + production build into dist/ (static files, host anywhere)
npm run analyze    # print detected objects for the layout suite (or: npm run analyze -- fund | path/to.pdf [page])
npm run fixtures   # (optional) writes edge-case PDFs to test-fixtures/ for manual testing
```

## Two-minute demo (click **Try with sample document**)

1. The sample is a synthetic 7-page fund offering summary (no real data).
2. Click page 4 ("Internal Drafting Notes") in the thumbnails → **Delete** (Undo is in the toast).
3. Drag page 7 (Subscription Instructions) up next to the cover.
4. **Insert PDF** → *Use sample supplement* → untick page 2 → "After page 2" → **Insert**.
5. **Edit** (E) on the Terms page: hover, and paragraphs, cells, the table outline and rules light up as objects.
   Double-click the `$500,000,000` cell, type `$750,000,000`, Esc. Drag the intro paragraph somewhere else.
6. **Add Text** (T) → click the page, type a correction; make it bold in the right panel.
7. **Export PDF** (Ctrl/Cmd+S). The toast reports how many edited objects were rewritten in the page content.

**Seeing the layout model:** **Boxes** in the toolbar (or `B`, or `?boxes`) outlines every detected object by type: headings,
paragraphs, lists, tables, cells, rules, rectangles and images. **Tree** (or `?tree`) shows the current page's object tree;
hovering a row highlights the object on the page, and clicking pins it (in Edit mode it also selects it). **⋯ → Show detected
objects** (⇧⌘D, `?debug`) adds text lines and spans plus an inspector: id, type, bbox, page, text, font, size, parent,
children and source operators. **⋯ → Open layout test suite** loads a synthetic 9-page PDF covering the layouts below.
`npm run analyze -- suite 7` prints the same tree in the terminal.

## Architecture

The layout-object upgrade (normalized `LayoutChunk` tree, providers, roadmap for multi-select, copy/paste, tabs and
Word → PDF) is described in [docs/LAYOUT-ARCHITECTURE.md](docs/LAYOUT-ARCHITECTURE.md).

```
PDF bytes ─► PDF.js ─ getOperatorList() ─┐
                     getTextContent() ───┼─► extract.ts  RawPage: text items (+ painting op indices, colour,
                                          │                real font name), paths (rules/rects), images, in view space
                                          └─► analyze.ts  PageContent: TEXT_BLOCK ▸ TEXT_LINE ▸ TEXT_SPAN,
                                                          TABLE ▸ TABLE_ROW ▸ TABLE_CELL, LINE, RECTANGLE, IMAGE
                                                          (pure function, unit-tested in Node; cached per source page)
Edit mode ─ hover / select / drag / resize over cached geometry (PageOverlays.tsx)
          ─ a changed object becomes an overlay {source: object id, ops, bounds}
Viewer    ─ re-renders the page with PDF.js `operationsFilter`, skipping exactly the operators of edited objects
Export    ─ pdf-lib copies pages ─► pageEdit.ts rewrites each page's content stream: removes the operators that
            painted edited text/rules/rectangles, re-transforms moved images ─► draws new content ─► save
```

| Layer | Where |
|---|---|
| **Normalized layout model** (`LayoutChunk`, provider-agnostic) | `src/lib/layout/types.ts` |
| Layout providers: local (default) and Adobe Extract via a backend (off unless configured), with fallback | `src/lib/layout/provider.ts`, `cache.ts` |
| Adapters: analyzer → chunks, PDF.js text → chunks (fallback), Adobe JSON → chunks | `src/lib/layout/fromContent.ts`, `basic.ts`, `adobe.ts` |
| Canonical coordinates: `pdfToCanvas` / `canvasToPdf` / `canvasToScreen` / `screenToCanvas` | `src/lib/coords.ts` |
| Bounding boxes, inspector, object tree | `src/components/LayoutLayer.tsx`, `ObjectTreePanel.tsx` |
| Content object model (analyzer output) | `src/lib/content/types.ts` |
| Low-level extraction from PDF.js (CTM stack, text state, colours, paths, images, font names) | `src/lib/content/extract.ts` |
| Content analyzer (lines, blocks, roles, columns, lists, tables, graphics, op ownership) | `src/lib/content/analyze.ts` |
| Parse-once cache + idle prefetch | `src/lib/content/cache.ts` |
| Object → editable overlay, colour sampling | `src/lib/content/edits.ts` |
| Content-stream tokenizer / rebuild | `src/lib/pdf/contentStream.ts` |
| Content-stream interpreter + removal / transform | `src/lib/pdf/pageEdit.ts` |
| Document model, undo/redo, drafts | `src/lib/model.ts` |
| Export | `src/lib/export.ts` |

### How objects are detected (heuristics, no ML)

Inspired by Adobe PDF Extract's element model (H / P / L / LI / Table / TR / TD / Figure, with bounds, font, size and
attributes) and by the "lattice" and "stream" table strategies of Tabula/Camelot.

- **Lines:** text items clustered by baseline; split at large gaps, at vertical rules, and at **column gutters**. A gutter is a
  whitespace strip that stays empty across neighbouring lines, which is what separates two-column layouts from the wide word
  gaps of justified text.
- **Blocks:** consecutive lines joined by line spacing, size, weight, alignment/overlap and no separating rule; first-line
  indents and bullets start new blocks. Roles: heading (size or all-bold), list item (bullet/enumerator), header / footer
  (page margins), paragraph. Alignment (left/right/centre/justify), line height and hard vs. soft line breaks are measured.
- **Fonts and colours** come from the PDF itself: the real font name is read from the font file's OpenType `name` table
  (PDF.js `fontExtraProperties`), and the fill colour from the operator list.
- **Tables:** (1) *lattice*: connected grids of horizontal + vertical rules; (2) *rules*: stacks of horizontal rules with
  matching extents, columns from text alignment; (3) *stream*: rows of whitespace-separated columns, with guards against
  multi-column prose and sparse chart labels. Cells can be multi-line.
- **Graphics:** stroked or filled thin shapes become LINEs; other rectangles become RECTANGLEs; image paints become IMAGEs.
  Page-sized backgrounds are ignored.
- **Operator ownership:** each object records the operator indices that paint it, and whether they paint nothing else
  (`opsExclusive`). That is what makes exact hiding and true removal possible.

### Export: removal, not covering

`pageEdit.ts` interprets the page content stream (graphics + text state, Std-14 AFM widths or the font's `/Widths`/`/W`) to
locate each edited object's painting operators in PDF user space, then:
- **text**: the show operators are replaced by an equivalent advance (`[-n] TJ`), so later text on the line doesn't shift
- **rules/rectangles**: the path, or only the matching sub-path, is removed (moved ones are redrawn)
- **images**: removed, or wrapped in a new `cm` so the original image stream is reused (no re-encoding)

If an object cannot be matched safely (content inside a Form XObject, or a text operator shared with neighbouring content),
that object falls back to a cover filled with the sampled background colour. The export toast reports the split.

## Known limitations

- Replacement text uses the 14 standard PDF fonts (closest of Helvetica/Times/Courier, bold/italic preserved). Original
  embedded fonts are not reused, so text in an unusual font looks different after editing. Characters outside WinAnsi
  (e.g. Vietnamese `ả`, CJK) are flagged and exported as `?`. *Next step:* embed a Unicode font via `@pdf-lib/fontkit`.
- Paragraph edits reflow within the original width; if the fallback font is wider, line breaks can differ.
- Detection is heuristic and tuned on digitally generated business documents. Merged/spanning table cells, rotated text
  and complex vector art are not modelled. Content inside Form XObjects is detected but exported via covers.
- Moved images keep their original paint order in the exported PDF (on screen they are drawn on top while editing).
- Export rebuilds the document with pdf-lib: page content, links and images are kept, document-level features are not
  (form fields, bookmarks, tags, signatures).
- Password-protected PDFs are rejected with a clear message. Scanned pages: viewing and page operations work; Edit is
  disabled (no OCR); Add Text still works.

## Shortcuts

`V` select · `E` edit · `T` add text · `Enter` edit the selected object · `Del` delete the selected object / text box /
pages · `Esc` deselect · arrows nudge a selected text box · `⌘/Ctrl+Z` undo · `⌘/Ctrl+Shift+Z` redo · `⌘/Ctrl+S` export ·
`⌘/Ctrl+O` open · `B` bounding boxes · `⇧⌘D` debug view.

## Verification status

Automated (`npm test`, 90 tests): layout model (canonical coordinates at every rotation, local adapter tree consistency,
headings/levels, list grouping, table grid, Adobe adapter on a synthetic Extract sample incl. row/col spans, fallback);
analyzer on the 9-page layout suite and the fund sample (paragraphs, justification,
headings, two columns, lists, headers/footers, fonts/weights/colours, spans, lattice/rules/stream tables, multi-line cells,
chart false-positive guard, graphics); **true removal** (edited paragraph/cell/heading text absent from the exported file,
neighbours intact, moved rule/deleted rectangle/moved+resized image verified by re-analysing the export); model, undo/redo,
drafts, page operations and export round-trips.

Exercised by hand in Chromium: bounding boxes, object tree (hover highlight, click-to-select), debug inspector on a
page rotated 90°; hover/select/edit/move on paragraphs, cells, table outline, rules, rectangles and images;
debug view; edits on a rotated page; export → re-open in the app.

**Not yet exercised:** OS file picker / drag-and-drop of real files, Firefox/Safari, and opening exports in
Acrobat/Preview (they re-parse cleanly in pdf-lib and PDF.js). Check in Adobe Reader before circulating a real document.
