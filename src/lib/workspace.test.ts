import { describe, expect, it } from 'vitest'
import { reducer, initialState, isDirty, type SourceMeta } from './model'
import { activeTab, anyDirty, defaultView, emptyTab, initialWorkspace, tabSources, workspaceReducer, type Tab, type Workspace } from './workspace'

const meta = (id: string, n = 3): SourceMeta => ({
  id, name: `${id}.pdf`, size: 1, numPages: n, likelyScanned: false,
  pages: Array.from({ length: n }, () => ({ view: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const, width: 612, height: 792 })),
})
const docTab = (id: string, n = 3): Tab => ({ ...emptyTab(), doc: reducer(initialState, { type: 'load', source: meta(id, n), fileName: `${id}.pdf` }) })
const names = (w: Workspace) => w.tabs.map((t) => t.doc.fileName ?? '-')
/** A workspace whose start tab holds document `id`. */
const withDoc = (id: string) => {
  const w = initialWorkspace()
  return workspaceReducer(w, { type: 'open', tab: docTab(id), into: w.active })
}

describe('workspace (document tabs)', () => {
  it('fills the empty start tab, then opens further documents in new tabs after the active one', () => {
    let w = initialWorkspace()
    const start = w.active
    w = workspaceReducer(w, { type: 'open', tab: docTab('a'), into: start })
    expect(w.tabs).toHaveLength(1)
    expect(w.active).toBe(start)
    w = workspaceReducer(w, { type: 'open', tab: docTab('b'), into: w.active }) // active isn't empty: new tab
    expect(names(w)).toEqual(['a.pdf', 'b.pdf'])
    w = workspaceReducer(w, { type: 'activate', id: w.tabs[0].id })
    w = workspaceReducer(w, { type: 'open', tab: docTab('c') })
    expect(names(w)).toEqual(['a.pdf', 'c.pdf', 'b.pdf'])
    expect(activeTab(w).doc.fileName).toBe('c.pdf')
  })

  it('routes document actions to their own tab: edits and undo history stay separate', () => {
    let w = withDoc('a')
    w = workspaceReducer(w, { type: 'open', tab: docTab('b') })
    const [a, b] = w.tabs
    w = workspaceReducer(w, { type: 'doc', id: a.id, action: { type: 'deletePages', ids: [a.doc.pages[0].id] } }) // a is not active
    expect(w.tabs[0].doc.pages).toHaveLength(2)
    expect(w.tabs[1].doc.pages).toHaveLength(3)
    expect(isDirty(w.tabs[0].doc)).toBe(true)
    expect(isDirty(w.tabs[1].doc)).toBe(false)
    expect(anyDirty(w)).toBe(true)
    w = workspaceReducer(w, { type: 'doc', id: b.id, action: { type: 'undo' } }) // nothing to undo in b
    expect(w.tabs[0].doc.pages).toHaveLength(2)
    w = workspaceReducer(w, { type: 'doc', id: a.id, action: { type: 'undo' } })
    expect(w.tabs[0].doc.pages).toHaveLength(3)
    // an action for a tab that was closed meanwhile is ignored
    const same = workspaceReducer(w, { type: 'doc', id: 'gone', action: { type: 'undo' } })
    expect(same).toBe(w)
  })

  it('remembers how each tab was viewed', () => {
    let w = withDoc('a')
    const a = w.active
    w = workspaceReducer(w, { type: 'open', tab: docTab('b'), leaving: { currentIndex: 2, zoom: { mode: 'custom', value: 1.5 }, customMargins: null } })
    const b = w.active
    w = workspaceReducer(w, { type: 'activate', id: a, leaving: { ...defaultView(), currentIndex: 1 } })
    expect(activeTab(w).view).toEqual({ currentIndex: 2, zoom: { mode: 'custom', value: 1.5 }, customMargins: null })
    expect(w.tabs.find((t) => t.id === b)!.view.currentIndex).toBe(1)
  })

  it('closing activates the right neighbour, keeps the active tab when closing another, and never leaves zero tabs', () => {
    let w = withDoc('a')
    w = workspaceReducer(w, { type: 'open', tab: docTab('b') })
    w = workspaceReducer(w, { type: 'open', tab: docTab('c') })
    const [a, b, c] = w.tabs.map((t) => t.id)
    w = workspaceReducer(w, { type: 'activate', id: b })
    w = workspaceReducer(w, { type: 'close', id: b, fresh: emptyTab() })
    expect(w.active).toBe(c)
    w = workspaceReducer(w, { type: 'close', id: a, fresh: emptyTab() })
    expect(w.active).toBe(c)
    w = workspaceReducer(w, { type: 'close', id: c, fresh: emptyTab() })
    expect(w.tabs).toHaveLength(1)
    expect(w.tabs[0].doc).toBe(initialState)
  })

  it('lists the sources a tab holds (released when it is closed)', () => {
    let t = docTab('a')
    t = { ...t, doc: reducer(t.doc, { type: 'addSource', source: meta('ins', 1) }) }
    expect(tabSources(t).sort()).toEqual(['a', 'ins'])
  })
})
