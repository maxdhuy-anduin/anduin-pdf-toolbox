import { createContext, useContext, type Dispatch } from 'react'
import type { Action, DocState } from './lib/model'
import type { ProviderId } from './lib/layout/types'
import type { Hit } from './lib/search'
import type { Margins, Unit } from './lib/margins'

/**
 * select = view & select text · edit = Acrobat-style object editing · add-text = place a new text box ·
 * add-line = draw a line · add-shape = draw a shape · add-footnote = click after a word to add a footnote
 */
export type Tool = 'select' | 'edit' | 'add-text' | 'add-line' | 'add-shape' | 'add-footnote' | 'crop'

/** Find bar results shown on the pages. */
export interface SearchView {
  hits: Hit[]
  activeId: string | null
}
export type ZoomState = { mode: 'fit' } | { mode: 'custom'; value: number }
export type ToastKind = 'info' | 'success' | 'warning' | 'error'

/** A detected content object selected in Edit mode (before it has been changed). */
export interface ObjectSelection {
  pageId: string
  objectId: string
}

export interface ObjectsSelection {
  pageId: string
  keys: string[]
}

export interface AppCtx {
  state: DocState
  dispatch: Dispatch<Action>
  tool: Tool
  setTool: (t: Tool) => void
  zoom: ZoomState
  setZoom: (z: ZoomState) => void
  /** Effective scale of the viewer (fit-width resolved). */
  scale: number
  setScale: (s: number) => void
  currentIndex: number
  setCurrentIndex: (i: number) => void
  scrollToPage: (index: number) => void
  scrollRequest: { index: number; nonce: number } | null
  toast: (kind: ToastKind, text: string) => void
  /** Selected objects on one page in Edit mode ("o:<objectId>" detected objects, "v:<overlayId>" overlays). */
  objSel: ObjectsSelection | null
  setObjSel: (s: ObjectsSelection | null) => void
  /** The single selected detected object, if exactly one is selected (properties panel, Enter to edit). */
  selectedObject: ObjectSelection | null
  setSelectedObject: (s: ObjectSelection | null) => void
  /** Ask a page to start editing a detected object (Enter / double-click / panel button). */
  editRequest: { pageId: string; objectId: string; nonce: number } | null
  requestEdit: (pageId: string, objectId: string) => void
  /** Developer view: outline every detected object, with an inspector. */
  debug: boolean
  setDebug: (v: boolean) => void
  /** Subtle bounding boxes for detected layout objects. */
  showBoxes: boolean
  setShowBoxes: (v: boolean) => void
  /** Bumped when the active layout provider changes. */
  layoutProvider: ProviderId
  setLayoutProvider: (id: ProviderId) => void
  search: SearchView | null
  /** Rulers along the viewer, with the page margins. */
  showRulers: boolean
  setShowRulers: (v: boolean) => void
  rulerUnit: Unit
  setRulerUnit: (u: Unit) => void
  /** Margins set on the ruler (all pages); null = detected per page. */
  customMargins: Margins | null
  setCustomMargins: (m: Margins | null) => void
}

export const AppContext = createContext<AppCtx | null>(null)

export function useApp(): AppCtx {
  const c = useContext(AppContext)
  if (!c) throw new Error('AppContext missing')
  return c
}
