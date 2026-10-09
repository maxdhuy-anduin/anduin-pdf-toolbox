import { describe, expect, it } from 'vitest'
import {
  deletePages, duplicatePages, initialState, insertPages, isDirty, makePage, makeTextOverlay, movePages, reducer, rotatePages,
  type DocState, type Overlay, type SourceMeta, type TextOverlay,
} from './model'

const src: SourceMeta = {
  id: 's1', name: 'a.pdf', size: 1, numPages: 4, likelyScanned: false,
  pages: Array.from({ length: 4 }, () => ({ view: [0, 0, 612, 792] as [number, number, number, number], rotate: 0 as const, width: 612, height: 792 })),
}
const mk = (n: number) => Array.from({ length: n }, (_, i) => makePage('s1', i))
const order = (ps: { srcIndex: number }[]) => ps.map((p) => p.srcIndex + 1)

describe('page operations', () => {
  it('moves page 4 between 1 and 2', () => {
    const p = mk(4)
    expect(order(movePages(p, [p[3].id], 1))).toEqual([1, 4, 2, 3])
  })
  it('moves a page to the end and to the start', () => {
    const p = mk(4)
    expect(order(movePages(p, [p[0].id], 4))).toEqual([2, 3, 4, 1])
    expect(order(movePages(p, [p[2].id], 0))).toEqual([3, 1, 2, 4])
  })
  it('moves multiple pages keeping relative order', () => {
    const p = mk(5)
    expect(order(movePages(p, [p[1].id, p[3].id], 5))).toEqual([1, 3, 5, 2, 4])
    expect(order(movePages(p, [p[3].id, p[1].id], 0))).toEqual([2, 4, 1, 3, 5])
  })
  it('moving next to itself is a no-op', () => {
    const p = mk(4)
    expect(order(movePages(p, [p[1].id], 1))).toEqual([1, 2, 3, 4])
    expect(order(movePages(p, [p[1].id], 2))).toEqual([1, 2, 3, 4])
  })
  it('deletes', () => {
    const p = mk(4)
    expect(order(deletePages(p, [p[1].id, p[2].id]))).toEqual([1, 4])
  })
  it('duplicates a page right after itself, with fresh ids and overlay copies', () => {
    const p = mk(3)
    p[1] = { ...p[1], overlays: [makeTextOverlay(1, 2)] }
    const r = duplicatePages(p, [p[1].id])
    expect(order(r.pages)).toEqual([1, 2, 2, 3])
    expect(r.pages[2].id).not.toBe(p[1].id)
    expect(r.pages[2].overlays[0].id).not.toBe(p[1].overlays[0].id)
  })
  it('duplicates a contiguous run as a block', () => {
    const p = mk(4)
    expect(order(duplicatePages(p, [p[1].id, p[2].id]).pages)).toEqual([1, 2, 3, 2, 3, 4])
  })
  it('rotates modulo 360', () => {
    const p = mk(2)
    const r = rotatePages(rotatePages(p, [p[0].id], 90), [p[0].id], -180)
    expect(r[0].rotation).toBe(270)
    expect(r[1].rotation).toBe(0)
  })
  it('inserts pages at an index', () => {
    const p = mk(3)
    const extra = [makePage('s2', 0), makePage('s2', 1)]
    expect(insertPages(p, 2, extra).map((x) => `${x.sourceId}${x.srcIndex}`)).toEqual(['s10', 's11', 's20', 's21', 's12'])
  })
})

describe('reducer', () => {
  const loaded = (): DocState => reducer(initialState, { type: 'load', source: src, fileName: 'a' })

  it('loads a source as pages and is not dirty', () => {
    const s = loaded()
    expect(s.pages).toHaveLength(4)
    expect(s.pages).toBe(s.savedPages)
  })
  it('undo/redo round-trips operations', () => {
    let s = loaded()
    const ids = s.pages.map((p) => p.id)
    s = reducer(s, { type: 'deletePages', ids: [ids[0]] })
    s = reducer(s, { type: 'rotatePages', ids: [ids[1]], delta: 90 })
    expect(s.pages).toHaveLength(3)
    s = reducer(s, { type: 'undo' })
    expect(s.pages[0].rotation).toBe(0)
    s = reducer(s, { type: 'undo' })
    expect(s.pages).toHaveLength(4)
    expect(s.pages).toBe(s.savedPages) // back at the saved snapshot => clean
    s = reducer(s, { type: 'redo' })
    expect(s.pages).toHaveLength(3)
  })
  it('refuses to delete every page', () => {
    const s = loaded()
    expect(reducer(s, { type: 'deletePages', ids: s.pages.map((p) => p.id) })).toBe(s)
  })
  it('coalesces rapid overlay edits into one undo step', () => {
    let s = loaded()
    const pageId = s.pages[0].id
    const o = makeTextOverlay(10, 10)
    s = reducer(s, { type: 'addOverlay', pageId, overlay: o })
    for (const t of ['H', 'He', 'Hel', 'Hell', 'Hello']) {
      s = reducer(s, { type: 'updateOverlay', pageId, overlayId: o.id, patch: { text: t }, coalesce: `text:${o.id}` })
    }
    expect((s.pages[0].overlays[0] as TextOverlay).text).toBe('Hello')
    s = reducer(s, { type: 'undo' }) // undoes all typing at once
    expect((s.pages[0].overlays[0] as TextOverlay).text).toBe('Text')
    s = reducer(s, { type: 'undo' }) // undoes add
    expect(s.pages[0].overlays).toHaveLength(0)
  })
  it('selection follows duplicates and clears when pages disappear', () => {
    let s = loaded()
    const id = s.pages[1].id
    s = reducer(s, { type: 'duplicatePages', ids: [id] })
    expect(s.selection).toHaveLength(1)
    expect(s.selection[0]).not.toBe(id)
    s = reducer(s, { type: 'deletePages', ids: s.selection })
    expect(s.selection).toEqual([])
  })
})

describe('draft overlays', () => {
  const loaded = (): DocState => reducer(initialState, { type: 'load', source: src, fileName: 'a' })
  it('an empty new text box is not part of the document until typed into', () => {
    let s = loaded()
    const pageId = s.pages[0].id
    const o = makeTextOverlay(5, 5, { text: '' })
    s = reducer(s, { type: 'startDraft', pageId, overlay: o, original: null })
    s = reducer(s, { type: 'updateOverlay', pageId, overlayId: o.id, patch: { fontSize: 20 } })
    expect(s.pages[0].overlays).toHaveLength(0)
    expect(s.pages).toBe(s.savedPages)
    s = reducer(s, { type: 'updateOverlay', pageId, overlayId: o.id, patch: { text: 'H' }, coalesce: `ov:${o.id}` })
    expect(s.draft).toBeNull()
    expect(s.pages[0].overlays[0]).toMatchObject({ text: 'H', fontSize: 20 })
    s = reducer(s, { type: 'undo' })
    expect(s.pages[0].overlays).toHaveLength(0)
  })
  it('discarding a draft leaves no trace', () => {
    let s = loaded()
    const pageId = s.pages[0].id
    const o = makeTextOverlay(5, 5, { text: '' })
    s = reducer(s, { type: 'startDraft', pageId, overlay: o, original: null })
    s = reducer(s, { type: 'discardDraft' })
    expect(s.draft).toBeNull()
    expect(s.past).toHaveLength(0)
    expect(s.pages).toBe(s.savedPages)
  })
  it('an edit of existing text is only committed once the text differs', () => {
    let s = loaded()
    const pageId = s.pages[0].id
    const o = makeTextOverlay(5, 5, { text: 'Original', cover: { x: 0, y: 0, w: 10, h: 10, color: '#ffffff' } })
    s = reducer(s, { type: 'startDraft', pageId, overlay: o, original: 'Original' })
    s = reducer(s, { type: 'updateOverlay', pageId, overlayId: o.id, patch: { text: 'Original' } })
    expect(s.pages[0].overlays).toHaveLength(0)
    s = reducer(s, { type: 'updateOverlay', pageId, overlayId: o.id, patch: { text: 'Changed' } })
    expect((s.pages[0].overlays[0] as TextOverlay).text).toBe('Changed')
  })
  // regression: re-typing a moved object used to drop its move before anything was typed
  const moved = () => {
    let s = loaded()
    const pageId = s.pages[0].id
    const mv: Overlay = { id: 'mv1', type: 'move', source: { objectId: 'blk', objType: 'TEXT_BLOCK', bounds: { x: 0, y: 0, w: 50, h: 10 }, ops: [1], exclusive: true }, dx: 0, dy: 100, deleted: false, coverColor: '#ffffff' }
    s = reducer(s, { type: 'addOverlay', pageId, overlay: mv })
    const o = makeTextOverlay(0, 100, { text: 'Para', cover: { x: 0, y: 0, w: 50, h: 10, color: '#ffffff' } })
    s = reducer(s, { type: 'startDraft', pageId, overlay: o, original: 'Para', replaces: 'mv1' })
    return { s, pageId, o }
  }
  it('editing a moved object without changing it keeps the move', () => {
    let { s } = moved()
    expect(s.pages[0].overlays.map((x) => x.id)).toEqual(['mv1'])
    s = reducer(s, { type: 'discardDraft' })
    expect(s.pages[0].overlays.map((x) => x.id)).toEqual(['mv1'])
    expect(s.past).toHaveLength(1)
  })
  it('committing the edit of a moved object replaces the move in one undo step', () => {
    let { s, pageId, o } = moved()
    s = reducer(s, { type: 'updateOverlay', pageId, overlayId: o.id, patch: { text: 'Para 2' } })
    expect(s.pages[0].overlays.map((x) => x.type)).toEqual(['text'])
    s = reducer(s, { type: 'undo' })
    expect(s.pages[0].overlays.map((x) => x.id)).toEqual(['mv1'])
  })
})

describe('dirty flag', () => {
  it('is clean with no document, clean after load, dirty after an edit, clean after markSaved', () => {
    expect(isDirty(initialState)).toBe(false)
    let s = reducer(initialState, { type: 'load', source: src, fileName: 'a' })
    expect(isDirty(s)).toBe(false)
    s = reducer(s, { type: 'rotatePages', ids: [s.pages[0].id], delta: 90 })
    expect(isDirty(s)).toBe(true)
    s = reducer(s, { type: 'markSaved' })
    expect(isDirty(s)).toBe(false)
  })
  it('an edit made while an export was running stays unsaved', () => {
    let s = reducer(initialState, { type: 'load', source: src, fileName: 'a' })
    s = reducer(s, { type: 'rotatePages', ids: [s.pages[0].id], delta: 90 })
    const exported = s.pages
    s = reducer(s, { type: 'rotatePages', ids: [s.pages[0].id], delta: 90 })
    s = reducer(s, { type: 'markSaved', pages: exported })
    expect(isDirty(s)).toBe(true)
  })
})
