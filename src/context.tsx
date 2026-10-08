import { createContext, useContext, type Dispatch } from 'react'
import type { Action, DocState } from './lib/model'
import type { ProviderId } from './lib/layout/types'

/** select = view & select text · edit = Acrobat-style object editing · add-text = place a new text box */
export type Tool = 'select' | 'edit' | 'add-text'
export type ZoomState = { mode: 'fit' } | { mode: 'custom'; value: number }
export type ToastKind = 'info' | 'success' | 'warning' | 'error'

/** A detected content object selected in Edit mode (before it has been changed). */
export interface ObjectSelection {
  pageId: string
  objectId: string
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
  /** Object tree panel for the current page. */
  showTree: boolean
  setShowTree: (v: boolean) => void
  /** Layout chunk highlighted from the object tree (hover or pinned). */
  treeFocus: { pageId: string; chunkId: string; pinned: boolean } | null
  setTreeFocus: (f: { pageId: string; chunkId: string; pinned: boolean } | null) => void
  /** Bumped when the active layout provider changes. */
  layoutProvider: ProviderId
  setLayoutProvider: (id: ProviderId) => void
}

export const AppContext = createContext<AppCtx | null>(null)

export function useApp(): AppCtx {
  const c = useContext(AppContext)
  if (!c) throw new Error('AppContext missing')
  return c
}
