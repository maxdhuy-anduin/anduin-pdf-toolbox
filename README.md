# Anduin PDF Toolbox

A focused, browser-only PDF tool for the workflows people reach for Acrobat for most: **view, reorder, delete,
duplicate, rotate, insert, extract, and edit PDF content as objects** (paragraphs, headings, tables and cells,
lines, rectangles, images), then **export a real PDF**. Hackathon MVP, not an Acrobat replacement.

**Privacy:** everything runs in the browser. There is no backend, no upload, no analytics and no third-party requests
(PDF.js assets, the UI fonts and the fonts used for text boxes are served by the app itself). Documents are never written to
storage; the only things remembered locally are the view toggles (boxes, debug, rulers, ruler unit). Copied objects stay in memory and are shared only with this
app's other open tabs (BroadcastChannel); they are never written to disk. The optional Adobe Extract provider is off unless
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
   Grab a table by its border and drag it: rules, cells and fills move as one, drawn exactly as before.
   Drag across empty space to select several objects (or Shift-click), then drag one of them: they move together.
   ⌘C / ⌘V duplicates them (+20 pt); open another PDF in a second browser tab and ⌘V pastes them there.
6. **Add Text** (T) → click the page, type a correction; make it bold in the right panel. This is the only way to add
   text: empty table cells are not treated as fields (clicking one selects its table).
   **Add Line** (L) → drag on the page (Shift = straight / 45°); set colour, thickness and solid / dashed / dotted in the
   panel, drag its end points to adjust. Lines move, copy and paste like everything else.
7. **Organize** (grid icon in the toolbar): all pages as a grid. Drag pages (or a selection) anywhere to reorder; type
   `1-3, 5` in the range box to select; **Extract** takes the selection or any range (`8-`, `odd`, `last`…) into a new PDF,
   optionally one file per page and/or removing them from this document. Rotate, duplicate, delete, insert. **Done** or Esc
   goes back; double-click a page to open it.
8. **Find** (⌘F): `partner` finds 14 matches across the document; **Aa** = match case, **ab** = whole words only; Enter /
   ⇧Enter step through them. **Replace** (⌥⌘F or the chevron) replaces one or all; **AB** (preserve case) turns
   `Partnership` into `Membership` and `PARTNER` into `MEMBER`. Replace all is one undo step.
9. **Shapes** (S, or the shape button): rectangle, rounded rectangle, ellipse/circle, triangle, diamond, pentagon, hexagon,
   star, arrow, check mark and cross. Drag to draw (Shift = square / circle); outline, fill (or none), thickness, dash and
   opacity in the panel; 8 handles resize (Shift keeps proportions). A drawn line can have arrowheads (none / end / start / both).
10. **Footnote** (N): click right after a word in the PDF: a superscript number goes there (matching the text's font, size,
    colour and baseline) and the note goes to the bottom of the page under a short rule, ready to type. Further notes stack
    below; numbering continues through the document. While typing in a text box, **Insert footnote** puts the number at the
    caret. **x²** (⇧⌘=) makes selected characters superscript (`1st` → `1ˢᵗ`); **S̶** strikes text through.
11. **Smart guides**: drag anything in Edit mode (or a text box): pink lines show when it lines up with the page centre,
    the margins or other objects' edges/centres, and pink measurements when it's evenly spaced (between two neighbours, the
    same gap as the next pair, or centred between the page edges). It snaps there; hold ⌥ to move freely.
12. **Rulers** (R, or the ruler button): inches / cm / mm / pt (click the corner), the page margins (drag the blue markers to
    set your own for snapping and footnotes, double-click to go back to the detected ones) and the selection's extent.
13. **Fonts**: text boxes can use Arial/Helvetica, Times New Roman, Courier New (standard PDF fonts) or Calibri, Cambria,
    Georgia, Garamond, Open Sans, Roboto, Lato (embedded, see below). Vietnamese and other Latin-script text works with these.
14. **Export PDF** (Ctrl/Cmd+S). The toast reports how many edited objects were rewritten in the page content.

**Seeing the layout model:** **Boxes** in the toolbar (or `B`, or `?boxes`) outlines every detected object by type: headings,
paragraphs, lists, tables, cells, rules, rectangles and images. **⋯ → Show detected objects** (⇧⌘D, `?debug`) adds text lines
and spans plus an inspector: id, type, bbox, page, text, font, size, parent, children and source operators. **⋯ → Open layout
test suite** loads a synthetic 9-page PDF covering the layouts below. `npm run analyze -- suite 7` prints the object tree in
the terminal.

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
| Bounding boxes, inspector | `src/components/LayoutLayer.tsx` |
| Selection, marquee, group move / delete, copy (pure logic) | `src/lib/objects.ts` |
| Clipboard (in memory, shared across tabs) | `src/lib/clipboard.ts` |
| Moved / pasted objects on screen (PDF.js render of only their operators) | `src/components/ContentLayers.tsx` |
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

**Moving, copying and pasting** never re-typesets anything. A moved object is a `MoveOverlay` (object id + offset): on screen
its operators are skipped in the page render and drawn again, alone, at the offset; on export they are removed from the page
and the source page is cut down to just those objects (`keepOnly`) and stamped at the new position as a Form XObject. Same
fonts, same line breaks, same vectors, still selectable text. A paste is the same stamp, from a copy of the source page that
travels with the clipboard, so pasting into another document works. A table owns every path drawn inside it, so it moves
with its rules and fills.

If an object cannot be matched safely (content inside a Form XObject, or a text operator shared with neighbouring content),
that object falls back to a cover filled with the sampled background colour. The export toast reports the split.

### Fonts

Calibri, Cambria, Georgia and Garamond are Microsoft / Monotype fonts that can't be redistributed, so the app ships open-source
equivalents (SIL Open Font License, in `public/fonts` with their licences): **Carlito** and **Caladea** have exactly the same
character widths as Calibri and Cambria (text wraps identically); **Gelasio** is designed to match Georgia; **EB Garamond** is a
Garamond revival; Open Sans, Roboto and Lato are the originals. The same files are used on screen (`@font-face`) and embedded
(subset) in the export via `@pdf-lib/fontkit`, which is loaded only when an export uses one of them. The files were prepared
with fontTools: static Regular/Bold/Italic/BoldItalic instances, Latin + Vietnamese + Greek + Cyrillic + common symbols, glyphs
padded to 4 bytes (fontkit's subsetter corrupts fonts whose glyphs have odd lengths; a test checks every file). Edited PDF text
in Calibri/Cambria/Georgia/Garamond/Open Sans/Roboto/Lato now keeps that font. If a font file can't be loaded, export falls back
to the closest standard font and says so.

### Find & replace, superscripts

Find searches the PDF's own text (paragraphs and cells, at their moved place if moved) and every text box; highlights in PDF text
are computed from the positions of the text items, highlights in text boxes use the CSS Custom Highlight API. Replacing PDF text
re-types that paragraph or cell exactly as editing it by hand would. Superscripts are stored as Unicode superscript characters
(¹ ² ³ ˢ ᵗ …), so text stays plain (search, copy, undo work); they are drawn as the normal character at 65 % size, raised
0.35 em, both on screen and in the export, so they look right in every font.

## Known limitations

- Edited text uses the closest available font (the 3 standard PDF fonts or the 7 embedded families above, bold/italic
  preserved); other original fonts are not reused. With the standard fonts, characters outside WinAnsi (e.g. Vietnamese `ả`,
  CJK) are flagged and exported as `?`; the embedded fonts cover Latin (incl. Vietnamese), Greek and Cyrillic, not CJK.
- Footnote numbers are assigned when inserted (next number in the document); they are not renumbered when notes are added
  earlier in the document or deleted. Notes don't push body text up: the PDF has no reflow, drag them if they overlap.
- Find doesn't search inside pasted blocks or scanned pages; replacing text that is part of the PDF re-types that paragraph.
- Rulers' margins are a view setting (they don't change the PDF); dragging them is disabled on pages you rotated in the app.
- Paragraph edits reflow within the original width; if the fallback font is wider, line breaks can differ.
- Detection is heuristic and tuned on digitally generated business documents. Merged/spanning table cells, rotated text
  and complex vector art are not modelled. Content inside Form XObjects is detected but exported via covers.
- Moved and pasted objects are drawn on top of the page's other content (moved images keep their paint order on export).
- Content inside Form XObjects, and text whose drawing operator also draws neighbouring text, can't be moved as-is: such text is
  re-typeset in a standard font (as an edit would be), and anything else is left in place with a warning on export.
- Resize handles apply to a single object that has not been moved yet; groups move but don't scale.
- Cross-document paste works between tabs of this app in the same browser profile (both tabs open). In-app document tabs
  are not built yet.
- Export rebuilds the document with pdf-lib: page content, links and images are kept, document-level features are not
  (form fields, bookmarks, tags, signatures).
- Password-protected PDFs are rejected with a clear message. Scanned pages: viewing and page operations work; Edit is
  disabled (no OCR); Add Text still works.

## Shortcuts

`V` select · `E` edit · `T` add text · `L` add line · `S` add shape · `N` footnote · `R` rulers · `⌘/Ctrl+F` find ·
`⌥⌘/Ctrl+Alt+F` replace · `⌘/Ctrl+G` / `⇧⌘G` next / previous match · in a text box `⇧⌘=` superscript · while dragging `⌥` = no
snapping · Edit mode: drag empty space / `Shift`-click to select several, `⌘/Ctrl+A` select all
on the page, `⌘/Ctrl+C` `X` `V` copy / cut / paste, arrows nudge the selection (`Shift` = 10 pt) · `Enter` edit the selected
object · `Del` delete the selected objects / text box / pages · `Esc` deselect · `⌘/Ctrl+Z` undo · `⌘/Ctrl+Shift+Z` redo · `⌘/Ctrl+S` export ·
`⌘/Ctrl+O` open · Organize: `⌘/Ctrl+A` select all pages, `Del` delete, `Esc` clear selection / back · `B` bounding boxes · `⇧⌘D` debug view.

## Verification status

Automated (`npm test`, 130 tests): find (match case, whole words, typographic quotes, highlights inside the paragraph, moved
and deleted paragraphs), replace (preserve case, PDF paragraph → edited text present in the export, text boxes, replace all
across pages = one undo step); superscripts (smaller and raised in the export, still real text); strikethrough position;
shapes (exact position also on a page with /Rotate 90, filled / open shapes, move / delete / copy); arrowheads; smart guides
(edge and centre alignment, equal gaps, regular stacks, threshold); detected margins; footnotes (marker snapped to the end of
a line with that line's size, note above the footer, stacking, export); embedded fonts (all 7 families, bold/italic,
Vietnamese without `?`, Calibri wrapping, fallback with a warning, every font file survives subsetting glyph by glyph,
font detection keeps families); moving/deleting tables with empty cells creates no text boxes; drawn lines export as
vector lines; page-range parsing; rigid moves (whole ruled table moved: same cell text, font and size at the new place,
nothing left behind; paragraph moved + another deleted; table deleted completely), paste from another page (original font,
only the copied object), marquee rules, group move in one undo step, clipboard positions relative to the selection; layout model (canonical coordinates at every rotation, local adapter tree consistency,
headings/levels, list grouping, table grid, Adobe adapter on a synthetic Extract sample incl. row/col spans, fallback);
analyzer on the 9-page layout suite and the fund sample (paragraphs, justification,
headings, two columns, lists, headers/footers, fonts/weights/colours, spans, lattice/rules/stream tables, multi-line cells,
chart false-positive guard, graphics); **true removal** (edited paragraph/cell/heading text absent from the exported file,
neighbours intact, moved rule/deleted rectangle/moved+resized image verified by re-analysing the export); model, undo/redo,
drafts, page operations and export round-trips.

Exercised in Chromium (October 2026 additions): ⌘F with 11/3/14/4 matches for match case / whole words, stepping across
pages, replace one + replace all with preserve case + a single undo, highlights in text boxes, closing clears them, ⌥⌘F from
the find field; superscript of a selection (selection kept) and strikethrough; Footnote tool after a word (² placed after
"Agreement." in the paragraph's font) and Insert footnote at the caret; every shape from the menu, restyle, corner resize,
marquee + copy/paste of a shape and an arrow; smart guides mid-drag (margin and table-edge alignment, centred between the page
edges) for shapes and text boxes; rulers in in/cm, margin drag and reset; all 10 fonts × 4 styles exported and re-opened, and
the same features rendered by Apple's PDF engine (QuickLook); find on a 112-page document (≤ 70 ms per keystroke); regression:
table drag, cell drag + undo, Organize, export.

Exercised by hand in Chromium earlier: Organize pages (range selection, dragging two pages to a new position, extract a range
with "delete after", undo, double-click to open); the ⋯ menu; dragging a table; marquee + Shift-click selection of heading, paragraph and table and
moving them together; ⌘C/⌘V duplicate; ⌘V into a different document in a second browser tab, then export (pasted table is
real text); Delete + undo; bounding boxes; debug inspector on a page rotated 90°; hover/select/edit/move on paragraphs, cells, table outline, rules, rectangles and images;
debug view; edits on a rotated page; export → re-open in the app.

**Not yet exercised:** OS file picker / drag-and-drop of real files, Firefox/Safari (the find highlights inside text boxes need
Safari 17.2+ / Firefox 140+), physical-keyboard Shift/⌥ during drags, and Acrobat (exports render correctly in PDF.js and Apple's
PDF engine). Check in Adobe Reader before circulating a real document.
