# Fonts for text boxes

Served by the app (never fetched from third parties), used on screen through `@font-face` and embedded (subset) in
exported PDFs. All are licensed under the SIL Open Font License 1.1 (`OFL-*.txt`).

| App name  | File      | Source (google/fonts)  | Note |
|-----------|-----------|------------------------|------|
| Calibri   | Carlito   | ofl/carlito            | same character widths as Calibri |
| Cambria   | Caladea   | ofl/caladea            | same character widths as Cambria |
| Georgia   | Gelasio   | ofl/gelasio (variable) | designed to match Georgia; static 400/700 instances |
| Garamond  | EBGaramond| ofl/ebgaramond (variable) | static 400/700 instances |
| Open Sans | OpenSans  | ofl/opensans (variable)| static 400/700, width 100 |
| Roboto    | Roboto    | ofl/roboto (variable)  | static 400/700, width 100 |
| Lato      | Lato      | ofl/lato               | |

Prepared with fontTools: variable fonts instantiated to static Regular / Bold / Italic / BoldItalic; subset to Latin
(incl. Vietnamese), Greek, Cyrillic, punctuation, currency, arrows, math and superscripts; glyph data padded to 4 bytes,
because @pdf-lib/fontkit's subsetter corrupts fonts whose glyphs have odd byte lengths (see `features.test.ts`).
