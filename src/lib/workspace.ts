// Document tabs. Each tab is an independent document (its own DocState: pages, sources, undo
// history, selection) plus how it was last viewed. Pure, like model.ts: the App keeps one
// Workspace and shows the active tab's DocState through the usual context.
import type { ZoomState } from '../context'
import type { Margins } from './margins'
import { initialState, isDirty, reducer, uid, type Action, type DocState } from './model'

/** How a tab was being looked at, restored when it is activated again. */
export interface TabView {
  currentIndex: number
  zoom: ZoomState
  customMargins: Margins | null
}

export interface Tab {
  id: string
  doc: DocState
  view: TabView
}

export interface Workspace {
  tabs: Tab[]
  active: string
}

export const defaultView = (): TabView => ({ currentIndex: 0, zoom: { mode: 'fit' }, customMargins: null })
export const emptyTab = (): Tab => ({ id: uid('tab'), doc: initialState, view: defaultView() })

export function initialWorkspace(): Workspace {
  const t = emptyTab()
  return { tabs: [t], active: t.id }
}

export type WorkspaceAction =
  /** A document action for one tab (not necessarily the active one: async work keeps its tab). */
  | { type: 'doc'; id: string; action: Action }
  /** Adds a tab (or fills tab `into`, an empty one) and activates it. `leaving`: view of the tab being left. */
  | { type: 'open'; tab: Tab; into?: string; leaving?: TabView }
  | { type: 'activate'; id: string; leaving?: TabView }
  /** `fresh`: the empty tab shown if this was the last one (made by the caller: reducers stay pure). */
  | { type: 'close'; id: string; fresh: Tab }

export const activeTab = (w: Workspace): Tab => w.tabs.find((t) => t.id === w.active) ?? w.tabs[0]
export const hasDocument = (t: Tab) => t.doc.pages.length > 0
export const anyDirty = (w: Workspace) => w.tabs.some((t) => isDirty(t.doc))
export const tabName = (t: Tab) => t.doc.fileName ?? 'New tab'

/** Source ids a tab's document holds (to release them when the tab is closed). */
export const tabSources = (t: Tab) => Object.keys(t.doc.sources)

function saveView(tabs: Tab[], id: string, view: TabView | undefined): Tab[] {
  return view ? tabs.map((t) => (t.id === id ? { ...t, view } : t)) : tabs
}

export function workspaceReducer(w: Workspace, a: WorkspaceAction): Workspace {
  switch (a.type) {
    case 'doc': {
      const tab = w.tabs.find((t) => t.id === a.id)
      if (!tab) return w // the tab was closed while an async action was running
      const doc = reducer(tab.doc, a.action)
      return doc === tab.doc ? w : { ...w, tabs: w.tabs.map((t) => (t.id === a.id ? { ...t, doc } : t)) }
    }
    case 'open': {
      const tabs = saveView(w.tabs, w.active, a.leaving)
      const into = a.into ? tabs.findIndex((t) => t.id === a.into && !hasDocument(t)) : -1
      if (into >= 0) return { tabs: tabs.map((t, i) => (i === into ? { ...a.tab, id: t.id } : t)), active: tabs[into].id }
      // a new tab opens right after the active one, like a browser
      const at = tabs.findIndex((t) => t.id === w.active) + 1
      return { tabs: [...tabs.slice(0, at), a.tab, ...tabs.slice(at)], active: a.tab.id }
    }
    case 'activate':
      if (a.id === w.active || !w.tabs.some((t) => t.id === a.id)) return w
      return { tabs: saveView(w.tabs, w.active, a.leaving), active: a.id }
    case 'close': {
      const i = w.tabs.findIndex((t) => t.id === a.id)
      if (i < 0) return w
      const tabs = w.tabs.filter((t) => t.id !== a.id)
      if (!tabs.length) return { tabs: [a.fresh], active: a.fresh.id }
      // closing the active tab activates its right neighbour (or the new last tab)
      const active = a.id === w.active ? tabs[Math.min(i, tabs.length - 1)].id : w.active
      return { tabs, active }
    }
  }
}
