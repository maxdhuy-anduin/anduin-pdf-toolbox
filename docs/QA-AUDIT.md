# Pre-release QA audit — October 2026

Scope: the whole repository at commit `0df3cb7` plus the fixes listed below. Method: baseline build/tests, static review of
every module (UI layer and analyzer/export layer reviewed independently), adversarial PDFs generated for each risk, the
real app driven in Chromium (real mouse/keyboard input through the browser's input pipeline), and every export reopened
with PDF.js (an independent parse of the bytes, not the app's viewer state). Only synthetic documents were used.

## 1. Release recommendation

**Ready with documented limitations, for an internal pilot.** The application must be deployed behind company access
control, built *without* `VITE_LAYOUT_SERVICE_URL`, and used with the rule "check every export before it is circulated".

It is **not** suitable for: removing confidential information (it is not a redaction tool), fillable forms, signed PDFs,
scanned documents that need OCR, or any workflow that needs bookmarks/tags/PDF/A. Those stay in Acrobat.

Before broad rollout: run the export round-trip checks on a handful of real (non-sensitive or approved) client PDFs on a
developer machine. Real-world documents were *not* tested in this audit (see §6).

## 2. Build and test results

| Command | Baseline (before) | After fixes |
|---|---|---|
| `npm ci` | pass (0 vulnerabilities) | pass |
| `npx tsc --noEmit` | pass | pass |
| `npm test` (`vitest run`) | pass, 130 tests / 8 files | pass, **147 tests / 11 files** (154 / 12 with document tabs and the sample-form checks) |
| `npm run build` | pass (warning: 1.34 MB main chunk) | pass (same warning) |
| `npm audit` | 0 vulnerabilities | 0 vulnerabilities |
| lint | not configured | not configured |
| `npm run preview` + browser | — | pass: renders, exports, re-opens; no dev hook, no third-party requests |

## 3. Feature QA matrix

Pass = observed working in the real app and/or verified in exported bytes. "Unit" = automated test only.

| Feature | Test performed | Result | Remaining limitation |
|---|---|---|---|
| Open via file input | injected `File` into the app's `<input>` change handler: valid, invalid, truncated, empty, `.txt`, encrypted | Pass (clear message for each) | OS dialog itself not driven |
| Drag-and-drop open/insert | code reviewed only | Not tested | |
| Large documents | 400-page file: opens in 266 ms; scroll through all pages, only ~6 canvases painted, heap ≈ 92 MB | Pass | very dense pages analyse slowly (§7) |
| Mixed sizes / rotation / crop box | fixture + export probes at /Rotate 0/90/180/270 with offset CropBox | Pass | |
| Page rotate / duplicate / delete / insert (toolbar) | real clicks, then export reopened: order, count, rotation exact | Pass | Insert position follows the scrolled-to page |
| Organize: drag reorder | real mouse drag of last tile to first | Pass (1 undo step) | |
| Extract (range `odd`) | real typing + click; downloaded bytes reopened | Pass | |
| Undo / redo of page operations | 4 undos to original (dirty flag clears), 4 redos | Pass | |
| Edit: move paragraph | real drag; dx exactly 0, dy as dragged; export position verified | Pass | |
| Edit: edit cell text | real double-click + typing; export has new value, old value absent | Pass | ⌘A inside the editor not testable via automation (macOS) |
| Edit: click a moved paragraph to edit | real clicks | **Fail → fixed** (D1) | |
| Edit: stale edit after scrolling / Organize | real input | **Fail → fixed** (D2) | |
| Delete objects (exactness) | delete every other text object of two documents, both parities (238 deletions) | Pass: all truly removed, 0 collateral loss | |
| Tables: move twice / delete | analyzer-level repro + export | **Fail → fixed** (D5) | shared row operators fall back to covers (warned) |
| Rules inside tables | repro + export re-analysed | **Fail → fixed** (D8) | |
| Copy / paste across documents | real ⌘C, open another PDF, real ⌘V, export | Pass (real text, nothing else from the source page) | |
| Copy shared-operator graphics | unit repro | **Fail → fixed** (D9) | images: refused with a message |
| Find & replace all | real ⌘⌥F, typing, click; export | Pass: 8 replaced, 1 undo step, none left in file | replaced paragraph is re-typeset |
| Shortcuts while a dialog is open | real keys with Extract dialog open | **Fail → fixed** (D4) | |
| Add text / lines / shapes / footnotes / rulers / smart guides | existing unit tests; not re-driven in this audit | Unit only | |
| Export integrity | see §6 | Pass with warnings | |
| Production build | served `dist/`, opened, rotated, exported, re-opened | Pass | |
| Word → PDF conversion | — | **Not implemented** (no such feature exists) | |
| Document tabs (in-app), added after the audit | real clicks/keys: open several files at once, switch (view + undo kept per tab), copy in one tab / paste in another + export, close with unsaved-changes prompt (sources released), + new tab, drop on the tab bar, toast Undo after switching, switching while typing; `workspace.test.ts` | Pass | all tabs stay in memory until closed |

## 4. Defects found

| # | Sev | Defect | Root cause | Status |
|---|---|---|---|---|
| D1 | P1 | Clicking a moved paragraph to edit it, then clicking away without typing, silently moved it back (screen and export) | `editObject` committed removal of the move before anything was typed | Fixed: the draft records the move it `replaces`; removed only on commit, in one undo step. Tests in `model.test.ts`; verified in app |
| D2 | P1 | After editing an object via Enter/"Edit text", scrolling the page away and back (or Organize → Done) reopened a draft with the *original* text; typing produced a second overlapping replacement | effect on `[editRequest]` replayed on every page remount | Fixed: requests are served once (nonce). Verified in app |
| D3 | P1 | Deleting/replacing content that could only be covered left the original text in the file with **no warning** (e.g. a deleted ID number still extractable) | cover fallback reported only as a count in a success toast | Fixed: explicit export warning; warnings stay 12 s; README "not a redaction tool". Tests in `export-integrity.test.ts` |
| D4 | P2 | Delete / Backspace / ⌘Z / tool keys acted on the document behind modal dialogs (e.g. deleting pages while the Extract dialog showed the old selection) | global key handlers did not check for dialogs | Fixed. Verified in app |
| D5 | P1 | Moving a table twice duplicated its cell text; deleting it afterwards left the copies visible | fallback stand-ins were re-created from the original on each operation | Fixed: move/delete/copy act on existing stand-ins. `edit-regressions.test.ts` |
| D6 | P1 | Moving/deleting/replacing a paragraph also moved/deleted a foreign footnote marker inside its box — **in the export only** | export matches text by geometry; screen hides by operator | Fixed: analyzer records foreign text boxes (`foreign`), export skips them. `edit-regressions.test.ts` |
| D7 | P1 | Export threw (whole export failed) when pasted content came from a page with a malformed font `/W` array | unguarded width parsing; no try/catch around stamping | Fixed: tolerant parsing, metrics fallback, per-stamp error handling with a warning. `edit-regressions.test.ts` |
| D8 | P2 | A rule inside a table, moved on its own then with the table, was drawn twice; any table move containing a rule warned "could not be moved" | the table's catch-all path target claimed the rule first | Fixed: specific targets claim first; other moved objects are excluded from a group's stamp; screen layer dedupes. `edit-regressions.test.ts` |
| D9 | P2 | Copy silently dropped lines/rectangles/images whose operator also drew other content; Cut then deleted them | only exclusive graphics were copied | Fixed: lines/rects copied as drawn equivalents; images reported; cut refused when something can't be copied |
| D10 | P2 | Graphics marked as exclusively owning an operator that also painted a page background or specks | those primitives were not counted | Fixed in `analyze.ts` |
| D11 | P2 | Export marked edits made *during* an export as saved (unsaved work could be lost without warning) | `markSaved` used current pages, not the exported snapshot | Fixed. `model.test.ts` |
| D12 | P2 | Fillable form fields and bookmarks silently dropped on export | only pages are copied | Warning added (feature not implemented). `export-integrity.test.ts` |
| D13 | P2 | Analysis caches, image previews and parsed clipboard sources of closed documents kept in memory; background analysis continued after close | no release hooks | Fixed: `onSourceReleased` hooks; verified in app (0 cached pages after close) |
| D14 | P2 | Insert dialog: PDFs finishing loading after Cancel/Insert stayed registered forever; sample load errors unhandled | no unmount guard | Fixed (incl. a StrictMode regression caught during verification) |
| D15 | P2 | Moved image previews keyed by per-page object id: moving `img1` on page 2 could show page 1's image | id not unique across pages | Fixed: keyed by source page |
| D16 | P3 | Duplicated pages shared annotation objects (one annotation on two pages) | `copyPages` reuses refs | Fixed: later copies get their own. `export-integrity.test.ts` |
| D17 | P2 | Table grid drawn by an operator that also draws outside the table: grid moves in export, not on screen | operator vs. sub-path granularity | **Open**, documented |
| D18 | P3 | Analysis of very dense pages blocks the UI (≈ 2.3 s at 19k text items) | O(lines × blocks) pass on the main thread | **Open**, documented |
| D19 | P3 | Page-content hook keeps showing the previous page's stats until analysis lands and hides analysis errors; no `pointercancel` handling; object selection not revalidated after undo; Shift-click anchor is an index | minor state handling | **Open** |
| D20 | P3 | Insert PDF defaults to after the scrolled-to page, not the clicked thumbnail | uses `currentIndex` | **Open**, documented |
| D21 | P3 | PDF.js page proxies are cached for the document's lifetime (released on close) | no `page.cleanup()` | **Open** |
| D22 | **P0** | On a real Word-generated form (the new sample), deleting an object also removed text of a *different*, untouched paragraph in the export (2 runs lost when deleting every other object; invisible on screen) | export matched text by geometry; real documents have overlapping / tightly packed object boxes | Fixed: exact operator attribution (ordinals of the page's text-showing operators, checked against the stream), geometry only as a fallback; shared operators never removed. `delete-exactness.test.ts` on the sample form fails without it |
| D23 | P2 | 48 of 332 objects on the sample form could only be covered, not removed (stale text left in the file) | trailing spaces inside an operator and neighbour runs touching the box edge made matches look partial | Fixed (ink extent, touching neighbours ignored): 0 of 332 |
| D24 | P2 | 29 of 332 objects marked as sharing operators with a neighbour (moved by re-typesetting, deleted by covering) | the extractor attributed a run that starts exactly where an item ends to that item | Fixed: 0 false shares; genuine shared runs (one `TJ` drawing several cells) still detected |

## 5. Security and privacy

- **Data flow:** all processing is in the browser. Verified in the production build: zero requests to any other origin while
  opening, editing and exporting. Only same-origin fetches: PDF.js worker/assets and fonts.
- **Optional external flow:** `VITE_LAYOUT_SERVICE_URL` (build time) enables an "Adobe PDF Extract" option that POSTs the whole
  PDF to that URL. Off by default; must stay unset for confidential use.
- **Secrets:** none in the source or the git history (searched for key/secret/token/password patterns and env files).
  `.gitignore` covers `.env*`, `dist`, `node_modules`, fixtures.
- **Storage:** `localStorage` holds view toggles only. No IndexedDB / Cache Storage. Clipboard content shared between the
  app's open tabs via `BroadcastChannel`, in memory.
- **XSS:** one `innerHTML` sink (superscripts), input escaped; all other PDF-derived text rendered as text. PDF.js runs with
  eval and scripting disabled.
- **Redaction risk:** see D3. Documented in README.
- **Resource limits:** 300 MB file cap; 400-page document handled comfortably.
- **Dependencies:** 0 known vulnerabilities; only install script is the project's own asset copy.

## 6. PDF fidelity

Verified (exported bytes reopened with PDF.js):
- page order, count, rotation, duplication, insertion from a second document, extraction;
- overlay and removal positions on offset CropBoxes at all four rotations, and when the original content leaves the
  transformation matrix modified;
- true removal (not covering) for edited/deleted objects on the two synthetic documents, with no collateral loss;
- duplicated pages keep edits separate; annotations (links, widgets) survive; form values remain visible.

Not verified: Adobe Acrobat/Reader rendering, real client documents, Form-XObject-heavy PDFs (fall back to covers),
tagged/PDF-A documents, CJK text.

## 7. Performance

| File | Size | Observation |
|---|---|---|
| `test-fixtures/big.pdf` | 400 pages, 0.5 MB | open 266 ms; export 94 ms (untouched) / 212 ms (an edit on every page); analysis median 2 ms/page, max 33 ms |
| synthetic dense pages (analyzer review) | 5k / 9.5k / 19k text items | analysis ≈ 240 ms / 680 ms / 2.3 s (main thread) |
| memory | 400 pages scrolled end to end | JS heap ≈ 92 MB; closing a document releases its caches |

## 8. Files changed

- `src/lib/model.ts`: draft `replaces`; `markSaved` takes the exported snapshot; `SourceRef.foreign`.
- `src/components/PageOverlays.tsx`, `Viewer.tsx`, `ContentLayers.tsx`: D1, D2, D8 (screen side), D15.
- `src/App.tsx`: D4, D9 (copy messages), D11, longer warnings.
- `src/lib/export.ts`: D3, D7, D8, D12, D16.
- `src/lib/pdf/pageEdit.ts`: D6, D7, D8 (claim order, `keepOnly` exclusions).
- `src/lib/content/analyze.ts`, `content/types.ts`, `content/edits.ts`: D6, D10, D15.
- `src/lib/objects.ts`: D5, D9.
- `src/lib/pdfjs.ts`, `content/cache.ts`, `layout/cache.ts`, `clipboard.ts`: D13.
- `src/components/InsertDialog.tsx`, `GraphicBox.tsx`: D14, D15.
- Tests: `export-integrity.test.ts`, `delete-exactness.test.ts`, `edit-regressions.test.ts` (new), `model.test.ts`,
  `export.test.ts` (two tests now expect the cover warning they had been missing), `src/test/helpers.ts`.
- Docs: `README.md` (scope, security, deployment, tests, troubleshooting, extending, limitations), this file.

## 9. GitHub readiness

- [x] No secrets in source or history; `.env*` ignored
- [x] `.gitignore`: `node_modules`, `dist`, `public/pdfjs` (generated), `test-fixtures`, logs, `.DS_Store`
- [x] `package-lock.json` committed; `npm ci` reproducible
- [x] README with install, run, test, build, deploy
- [x] Font licences (SIL OFL) shipped next to the fonts in `public/fonts`
- [ ] No `LICENSE` file for the project itself (internal: decide on "proprietary, Anduin internal")
- [ ] No CI workflow (suggest: `npm ci && npm test && npm run build` on pull requests)
- [ ] No linter / formatter configured
- [ ] `.claude/launch.json` is a developer-tool file in the repo (harmless; remove if unwanted)

## 10. Deployment readiness

- Static hosting of `dist/` (no backend). Serve `.mjs` as JavaScript. Sub-path: build with `--base`.
- Put it behind SSO / VPN; the app has no authentication of its own.
- Build without `VITE_LAYOUT_SERVICE_URL`.
- Supported browser: Chromium-based (tested). Firefox/Safari untested.
- No server logs of document content are possible (nothing is sent).

## 11. Next steps (most valuable first)

1. Run the export checks (`src/lib/delete-exactness.test.ts` approach) on approved real client PDFs; add any failures as fixtures.
2. Add CI (tests + build) and ESLint with `react-hooks` rules.
3. Preserve AcroForm fields on export (rebuild `/AcroForm /Fields` from the copied widgets) — the most likely real-world need.
4. Move layout analysis to a Web Worker and make the block pass sub-quadratic (D18).
5. Close D17 (split straddling path operators per sub-path on screen) and the P3 state issues (D19-D21).
6. Test in Adobe Reader and Edge; add a Playwright smoke test for open → edit → export.
