// Document model. The original PDFs are never mutated: the app keeps immutable
// `sources` (bytes live in sourceRegistry) and a list of `pages` that reference
// them, plus per-page edits (rotation, overlays). The exported PDF is generated
// from this model on demand (see export.ts).

export type Rotation = 0 | 90 | 180 | 270

export type FontFamily = 'Helvetica' | 'Times' | 'Courier'

export const FONT_LABELS: Record<FontFamily, string> = {
  Helvetica: 'Sans-serif (Helvetica)',
  Times: 'Serif (Times)',
  Courier: 'Monospace (Courier)',
}

/** Geometry of one source page, as PDF.js reports it (scale 1, intrinsic /Rotate applied). */
export interface PageInfo {
  /** Visible box in PDF user space: [x0, y0, x1, y1] (crop box ∩ media box). */
  view: [number, number, number, number]
  /** Intrinsic /Rotate of the page (0/90/180/270). */
  rotate: Rotation
  /** Width/height of the page as displayed at scale 1 (after intrinsic rotation). */
  width: number
  height: number
}

export interface SourceMeta {
  id: string
  name: string
  size: number
  numPages: number
  pages: PageInfo[]
  /** True when no text could be found in the sampled pages (likely scanned / image-only). */
  likelyScanned: boolean
}

/** Region of the original page hidden behind a replacement text (existing-text edit). */
export interface CoverRect {
  x: number
  y: number
  w: number
  h: number
  color: string
}

/**
 * Text added by the user, or a replacement for an existing text run.
 * Coordinates are in "page view space": points at scale 1, origin top-left of the
 * page *before* the user's extra rotation (so the overlay rotates with the page).
 */
export interface TextOverlay {
  id: string
  type: 'text'
  x: number
  y: number
  width: number
  text: string
  fontFamily: FontFamily
  fontSize: number
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right' | 'justify'
  color: string
  /** false = single run that never wraps (used for edits of existing text). */
  wrap: boolean
  /** Baseline-to-baseline distance as a multiple of fontSize (default LINE_HEIGHT). */
  lineHeight?: number
  underline?: boolean
  cover?: CoverRect
  /** The detected content object this text replaces (existing-text edits). */
  source?: SourceRef
}

/** Link from an edit back to the detected PDF content object it replaces. */
export interface SourceRef {
  objectId: string
  objType: string
  /** Original bounds (view space). */
  bounds: { x: number; y: number; w: number; h: number }
  /** Operator-list indices that paint the original object. */
  ops: number[]
  /** True when those operators paint nothing else, so the original can be hidden exactly. */
  exclusive: boolean
}

/** A detected line, rectangle or image that was moved, resized or deleted. */
export interface GraphicOverlay {
  id: string
  type: 'graphic'
  kind: 'line' | 'rect' | 'image'
  source: SourceRef
  /** New bounds (view space). */
  x: number
  y: number
  w: number
  h: number
  deleted: boolean
  strokeColor: string | null
  fillColor: string | null
  thickness: number
  /** Background colour used to hide the original where its operators can't be removed. */
  coverColor: string
}

export type Overlay = TextOverlay | GraphicOverlay
export const isText = (o: Overlay): o is TextOverlay => o.type === 'text'
export const isGraphic = (o: Overlay): o is GraphicOverlay => o.type === 'graphic'

export interface PageModel {
  id: string
  sourceId: string
  srcIndex: number
  /** Extra rotation chosen by the user (added to the page's intrinsic rotation). */
  rotation: Rotation
  overlays: Overlay[]
}

export const LINE_HEIGHT = 1.2

let counter = 0
export function uid(prefix = 'id'): string {
  counter += 1
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${counter}_${rand}`
}

export function makePage(sourceId: string, srcIndex: number): PageModel {
  return { id: uid('pg'), sourceId, srcIndex, rotation: 0, overlays: [] }
}

export function makeTextOverlay(x: number, y: number, patch: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: uid('tx'),
    type: 'text',
    x,
    y,
    width: 180,
    text: 'Text',
    fontFamily: 'Helvetica',
    fontSize: 12,
    bold: false,
    italic: false,
    align: 'left',
    color: '#000000',
    wrap: true,
    ...patch,
  }
}

export function normalizeRotation(r: number): Rotation {
  return ((((r % 360) + 360) % 360) as Rotation)
}

/** Size of a page as displayed (intrinsic + user rotation applied), at scale 1. */
export function displaySize(page: PageModel, info: PageInfo): { w: number; h: number } {
  const swap = page.rotation === 90 || page.rotation === 270
  return swap ? { w: info.height, h: info.width } : { w: info.width, h: info.height }
}

// ---------------------------------------------------------------------------
// Pure page operations
// ---------------------------------------------------------------------------

export function deletePages(pages: PageModel[], ids: string[]): PageModel[] {
  const drop = new Set(ids)
  return pages.filter((p) => !drop.has(p.id))
}

/** Deep-copies a page (new ids for the page and its overlays). */
export function clonePage(p: PageModel): PageModel {
  return { ...p, id: uid('pg'), overlays: p.overlays.map((o) => structuredClone({ ...o, id: uid(o.type === 'text' ? 'tx' : 'gr') })) }
}

/** Places a copy of each selected page directly after the last selected page of its run. */
export function duplicatePages(pages: PageModel[], ids: string[]): { pages: PageModel[]; created: string[] } {
  const sel = new Set(ids)
  const out: PageModel[] = []
  const created: string[] = []
  pages.forEach((p, i) => {
    out.push(p)
    if (sel.has(p.id) && !sel.has(pages[i + 1]?.id)) {
      // end of a selected run: insert copies of the whole run
      let start = i
      while (start > 0 && sel.has(pages[start - 1].id)) start -= 1
      for (let k = start; k <= i; k += 1) {
        const c = clonePage(pages[k])
        created.push(c.id)
        out.push(c)
      }
    }
  })
  return { pages: out, created }
}

export function rotatePages(pages: PageModel[], ids: string[], delta: number): PageModel[] {
  const sel = new Set(ids)
  return pages.map((p) => (sel.has(p.id) ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p))
}

/**
 * Moves the pages `ids` so they end up before the page that is at index `before`
 * of the *current* list (before === pages.length means "to the end").
 * The moved pages keep their relative order.
 */
export function movePages(pages: PageModel[], ids: string[], before: number): PageModel[] {
  const sel = new Set(ids)
  const moved = pages.filter((p) => sel.has(p.id))
  if (!moved.length) return pages
  const target = pages.slice(0, before).filter((p) => !sel.has(p.id)).length
  const rest = pages.filter((p) => !sel.has(p.id))
  return [...rest.slice(0, target), ...moved, ...rest.slice(target)]
}

export function insertPages(pages: PageModel[], index: number, incoming: PageModel[]): PageModel[] {
  const i = Math.max(0, Math.min(pages.length, index))
  return [...pages.slice(0, i), ...incoming, ...pages.slice(i)]
}

// ---------------------------------------------------------------------------
// Reducer with undo / redo
// ---------------------------------------------------------------------------

export interface DocState {
  sources: Record<string, SourceMeta>
  pages: PageModel[]
  fileName: string | null
  /** Page ids selected in the thumbnail panel. */
  selection: string[]
  /** Overlay currently selected in the viewer (not part of undo history). */
  selectedOverlay: { pageId: string; overlayId: string } | null
  /**
   * A text box that exists only on screen until the user actually changes it
   * (types, or edits a run of existing text). Keeps "click, then click away"
   * from polluting the document and the undo history.
   */
  draft: { pageId: string; overlay: TextOverlay; original: string | null } | null
  past: PageModel[][]
  future: PageModel[][]
  lastKey: string | null
  lastTime: number
  /** `pages` as of the last load/export; used to compute the "unsaved changes" flag. */
  savedPages: PageModel[]
}

export const initialState: DocState = {
  sources: {},
  pages: [],
  fileName: null,
  selection: [],
  selectedOverlay: null,
  draft: null,
  past: [],
  future: [],
  lastKey: null,
  lastTime: 0,
  savedPages: [],
}

export type Action =
  | { type: 'load'; source: SourceMeta; fileName: string }
  | { type: 'addSource'; source: SourceMeta }
  | { type: 'close' }
  | { type: 'insertPages'; index: number; pages: PageModel[] }
  | { type: 'deletePages'; ids: string[] }
  | { type: 'duplicatePages'; ids: string[] }
  | { type: 'movePages'; ids: string[]; before: number }
  | { type: 'rotatePages'; ids: string[]; delta: number }
  | { type: 'addOverlay'; pageId: string; overlay: Overlay }
  | { type: 'updateOverlay'; pageId: string; overlayId: string; patch: OverlayPatch; coalesce?: string }
  | { type: 'removeOverlay'; pageId: string; overlayId: string }
  | { type: 'startDraft'; pageId: string; overlay: TextOverlay; original: string | null }
  | { type: 'discardDraft' }
  | { type: 'setSelection'; ids: string[] }
  | { type: 'selectOverlay'; sel: { pageId: string; overlayId: string } | null }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'markSaved' }

export type OverlayPatch = Partial<Omit<TextOverlay, 'type' | 'id'>> & Partial<Omit<GraphicOverlay, 'type' | 'id'>>

const MAX_HISTORY = 100
const COALESCE_MS = 1200

function commit(state: DocState, pages: PageModel[], extra: Partial<DocState> = {}, coalesce?: string): DocState {
  if (pages === state.pages) return { ...state, ...extra }
  const now = Date.now()
  const merge = !!coalesce && state.lastKey === coalesce && now - state.lastTime < COALESCE_MS && state.past.length > 0
  const past = merge ? state.past : [...state.past, state.pages].slice(-MAX_HISTORY)
  return { ...state, draft: null, ...extra, pages, past, future: [], lastKey: coalesce ?? null, lastTime: now }
}

function validSelection(pages: PageModel[], ids: string[]) {
  const have = new Set(pages.map((p) => p.id))
  return ids.filter((id) => have.has(id))
}

function overlayStillExists(pages: PageModel[], sel: DocState['selectedOverlay']) {
  if (!sel) return null
  const page = pages.find((p) => p.id === sel.pageId)
  return page?.overlays.some((o) => o.id === sel.overlayId) ? sel : null
}

export function reducer(state: DocState, action: Action): DocState {
  switch (action.type) {
    case 'load': {
      const pages = Array.from({ length: action.source.numPages }, (_, i) => makePage(action.source.id, i))
      return {
        ...initialState,
        sources: { [action.source.id]: action.source },
        pages,
        savedPages: pages,
        fileName: action.fileName,
        selection: [],
      }
    }
    case 'addSource':
      return { ...state, sources: { ...state.sources, [action.source.id]: action.source } }
    case 'close':
      return initialState
    case 'insertPages': {
      if (!action.pages.length) return state
      const pages = insertPages(state.pages, action.index, action.pages)
      return commit(state, pages, { selection: action.pages.map((p) => p.id), selectedOverlay: null })
    }
    case 'deletePages': {
      const pages = deletePages(state.pages, action.ids)
      if (pages.length === 0 || pages.length === state.pages.length) return state
      return commit(state, pages, {
        selection: [],
        selectedOverlay: overlayStillExists(pages, state.selectedOverlay),
      })
    }
    case 'duplicatePages': {
      const r = duplicatePages(state.pages, action.ids)
      if (!r.created.length) return state
      return commit(state, r.pages, { selection: r.created })
    }
    case 'movePages': {
      const pages = movePages(state.pages, action.ids, action.before)
      const same = pages.every((p, i) => p === state.pages[i])
      return same ? state : commit(state, pages, { selection: validSelection(pages, action.ids) })
    }
    case 'rotatePages':
      return commit(state, rotatePages(state.pages, action.ids, action.delta))
    case 'addOverlay': {
      const pages = state.pages.map((p) =>
        p.id === action.pageId ? { ...p, overlays: [...p.overlays, action.overlay] } : p,
      )
      // Same coalesce key as the first typing edits, so "add + type" is a single undo step.
      return commit(state, pages, { selectedOverlay: { pageId: action.pageId, overlayId: action.overlay.id } }, `ov:${action.overlay.id}`)
    }
    case 'updateOverlay': {
      const d = state.draft
      if (d && d.overlay.id === action.overlayId) {
        const merged = { ...d.overlay, ...action.patch } as TextOverlay
        const keys = Object.keys(action.patch)
        const changed = merged.cover
          ? !(keys.every((k) => k === 'text') && merged.text === d.original)
          : merged.text !== ''
        if (!changed) return { ...state, draft: { ...d, overlay: merged } }
        const pages = state.pages.map((p) => (p.id === d.pageId ? { ...p, overlays: [...p.overlays, merged] } : p))
        return commit(state, pages, { selectedOverlay: { pageId: d.pageId, overlayId: merged.id } }, `ov:${merged.id}`)
      }
      const pages = state.pages.map((p) =>
        p.id === action.pageId
          ? { ...p, overlays: p.overlays.map((o) => (o.id === action.overlayId ? ({ ...o, ...action.patch } as Overlay) : o)) }
          : p,
      )
      return commit(state, pages, {}, action.coalesce)
    }
    case 'removeOverlay': {
      const pages = state.pages.map((p) =>
        p.id === action.pageId ? { ...p, overlays: p.overlays.filter((o) => o.id !== action.overlayId) } : p,
      )
      return commit(state, pages, { selectedOverlay: null })
    }
    case 'startDraft':
      return { ...state, draft: { pageId: action.pageId, overlay: action.overlay, original: action.original }, selectedOverlay: { pageId: action.pageId, overlayId: action.overlay.id } }
    case 'discardDraft':
      return state.draft ? { ...state, draft: null, selectedOverlay: null } : state
    case 'setSelection':
      return { ...state, selection: validSelection(state.pages, action.ids) }
    case 'selectOverlay':
      return { ...state, selectedOverlay: action.sel }
    case 'undo': {
      if (!state.past.length) return state
      const prev = state.past[state.past.length - 1]
      return {
        ...state,
        pages: prev,
        past: state.past.slice(0, -1),
        future: [state.pages, ...state.future],
        draft: null,
        lastKey: null,
        selection: validSelection(prev, state.selection),
        selectedOverlay: overlayStillExists(prev, state.selectedOverlay),
      }
    }
    case 'redo': {
      if (!state.future.length) return state
      const next = state.future[0]
      return {
        ...state,
        pages: next,
        past: [...state.past, state.pages],
        future: state.future.slice(1),
        draft: null,
        lastKey: null,
        selection: validSelection(next, state.selection),
        selectedOverlay: overlayStillExists(next, state.selectedOverlay),
      }
    }
    case 'markSaved':
      return { ...state, savedPages: state.pages }
  }
}

export const isDirty = (s: DocState) => s.pages.length > 0 && s.pages !== s.savedPages
