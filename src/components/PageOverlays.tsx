import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useApp } from '../context'
import { clamp, rotateDelta, screenToLocal } from '../lib/geom'
import { isGraphic, isLine, isMove, isPaste, isText, makeLineOverlay, makeTextOverlay, type LineOverlay, type Overlay, type OverlayPatch, type PageInfo, type PageModel, type TextOverlay } from '../lib/model'
import { getCachedContent, getPageContent, onContentAnalyzed } from '../lib/content/cache'
import {
  describeObject, graphicOverlayFromObject, imageSnapshots, isGraphicObject, isTextObject, OBJECT_LABEL, snapshotRegion, textOverlayFromObject,
} from '../lib/content/edits'
import type { Box, ContentObject, PageContent } from '../lib/content/types'
import { groupBounds, hitItem, lineStyle, marqueeSelect, pageItems, planDelete, planMove, type Item, type OverlayEdits } from '../lib/objects'
import { GraphicBox } from './GraphicBox'
import { TextBox } from './TextBox'

interface Props {
  page: PageModel
  info: PageInfo
  scale: number
  /** Element holding the page's rendered canvas (colour sampling, snapshots). */
  canvasHolder: RefObject<HTMLDivElement | null>
  /** Operators the currently displayed canvas was rendered without. */
  renderedHidden: Set<number>
}

/** Loads (and caches) the analyzed content of a page when `enabled`. */
export function usePageContent(sourceId: string, srcIndex: number, enabled: boolean): PageContent | undefined {
  const [content, setContent] = useState<PageContent | undefined>(() => getCachedContent(sourceId, srcIndex))
  useEffect(() => {
    if (!enabled) return
    let live = true
    const cached = getCachedContent(sourceId, srcIndex)
    if (cached) setContent(cached)
    else getPageContent(sourceId, srcIndex).then((c) => live && setContent(c)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [sourceId, srcIndex, enabled])
  useEffect(() => onContentAnalyzed(() => setContent((c) => c ?? getCachedContent(sourceId, srcIndex))), [sourceId, srcIndex])
  return content
}

/** On-screen box of a text overlay (its height depends on wrapping, which only the DOM knows). */
export function measureOverlay(pageId: string, overlayId: string): Box | null {
  const el = document.querySelector<HTMLElement>(`[data-page-id="${pageId}"] [data-overlay-id="${overlayId}"]`)
  const layer = el?.closest<HTMLElement>('[data-edit-layer]')
  if (!el || !layer) return null
  const k = layer.offsetWidth / Number(layer.dataset.pageWidth || layer.offsetWidth)
  return { x: el.offsetLeft / k, y: el.offsetTop / k, w: el.offsetWidth / k, h: el.offsetHeight / k }
}

function itemLabel(it: Item): string {
  if (it.obj) return describeObject(it.obj)
  const o = it.overlay!
  if (isPaste(o)) return o.items.length > 1 ? `Pasted · ${o.items.length} objects` : `Pasted ${OBJECT_LABEL[o.items[0]?.objType]?.toLowerCase() ?? 'content'}`
  if (isText(o)) return o.source ? 'Edited text' : 'Text box'
  if (isLine(o)) return 'Line'
  if (isGraphic(o)) return OBJECT_LABEL[o.source.objType] ?? 'Graphic'
  return 'Object'
}

type Press =
  | { mode: 'drag'; key: string; keys: string[]; sx: number; sy: number; moved: boolean; wasOnlySelection: boolean }
  | { mode: 'marquee'; start: { x: number; y: number }; base: string[] }

export function PageOverlays({ page, info, scale, canvasHolder, renderedHidden }: Props) {
  const { state, dispatch, tool, setTool, objSel, setObjSel, setSelectedObject, editRequest, toast } = useApp()
  const layerRef = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [caretAt, setCaretAt] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ dx: number; dy: number; ghosts: { key: string; b: Box; src: string | null }[] } | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)
  /** Line being drawn (Add Line) or an endpoint of a selected line being dragged. */
  const [drawing, setDrawing] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [endDrag, setEndDrag] = useState<{ id: string; end: 1 | 2; x: number; y: number } | null>(null)
  const content = usePageContent(page.sourceId, page.srcIndex, tool === 'edit')

  const draft = state.draft && state.draft.pageId === page.id ? state.draft : null
  const overlays: Overlay[] = draft && !page.overlays.some((o) => o.id === draft.overlay.id) ? [...page.overlays, draft.overlay] : page.overlays
  const selOverlay = state.selectedOverlay?.pageId === page.id ? state.selectedOverlay.overlayId : null
  const selKeys = useMemo(() => (objSel?.pageId === page.id ? objSel.keys : []), [objSel, page.id])
  const selSet = useMemo(() => new Set(selKeys), [selKeys])
  const canvas = () => canvasHolder.current?.querySelector<HTMLCanvasElement>(':scope > canvas')

  const items = useMemo(
    () => (tool === 'edit' ? pageItems(content, page.overlays, (id) => measureOverlay(page.id, id)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, page.overlays, page.id, tool, scale],
  )
  const itemByKey = useMemo(() => new Map(items.map((it) => [it.key, it])), [items])
  const selItems = selKeys.map((k) => itemByKey.get(k)).filter((x): x is Item => !!x)

  useEffect(() => {
    if (editingId && !overlays.some((o) => o.id === editingId)) setEditingId(null)
  }, [overlays, editingId])

  const update = useCallback(
    (id: string, patch: OverlayPatch, coalesce?: string) => dispatch({ type: 'updateOverlay', pageId: page.id, overlayId: id, patch, coalesce }),
    [dispatch, page.id],
  )
  const selectOverlay = (id: string) => {
    setObjSel(null)
    dispatch({ type: 'selectOverlay', sel: { pageId: page.id, overlayId: id } })
  }
  const apply = (r: OverlayEdits, coalesce?: string) =>
    dispatch({ type: 'editOverlays', pageId: page.id, add: r.add, update: r.update, remove: r.remove, coalesce })

  const startEdit = (id: string, at: { x: number; y: number } | null) => {
    selectOverlay(id)
    setCaretAt(at)
    setEditingId(id)
  }

  const stopEdit = (o: TextOverlay, e: React.FocusEvent | null) => {
    setEditingId((cur) => (cur === o.id ? null : cur))
    const toPanel = !!(e?.relatedTarget as HTMLElement | null)?.closest?.('[data-keep-selection]')
    if (toPanel) return
    if (draft && draft.overlay.id === o.id) dispatch({ type: 'discardDraft' })
    else if (o.text.trim() === '' && !o.cover && !o.source) dispatch({ type: 'removeOverlay', pageId: page.id, overlayId: o.id })
  }

  // ---- edit the text of a detected object -----------------------------------------------
  const editObject = useCallback(
    (objectId: string, at: { x: number; y: number } | null) => {
      if (!content) return
      const o = content.objects[objectId]
      if (!o || !isTextObject(o)) return
      const ov = textOverlayFromObject(o, content, canvas())
      // a moved object is edited where it now is (the move becomes part of the edit)
      const mv = page.overlays.find((x) => isMove(x) && x.source.objectId === objectId)
      if (mv && isMove(mv)) {
        ov.x += mv.dx
        ov.y += mv.dy
        dispatch({ type: 'editOverlays', pageId: page.id, remove: [mv.id] })
      }
      setObjSel(null)
      dispatch({ type: 'startDraft', pageId: page.id, overlay: ov, original: o.text ?? '' })
      setCaretAt(at)
      setEditingId(ov.id)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, dispatch, page.id, page.overlays, setObjSel],
  )

  useEffect(() => {
    if (editRequest && editRequest.pageId === page.id) editObject(editRequest.objectId, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest])

  // ---- keyboard / panel requests: delete, nudge, select all -------------------------------
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ pageId: string; op: 'delete' | 'nudge' | 'select-all'; dx?: number; dy?: number }>).detail
      if (d.pageId !== page.id) return
      if (d.op === 'select-all') {
        setObjSel({ pageId: page.id, keys: marqueeSelect(items, { x: -1, y: -1, w: info.width + 2, h: info.height + 2 }) })
        return
      }
      if (!selKeys.length) return
      if (d.op === 'delete') {
        apply(planDelete(page, content, selKeys, canvas()))
        setObjSel(null)
        const n = selKeys.length
        toast('info', `Deleted ${n} object${n > 1 ? 's' : ''}. Undo with ⌘Z.`)
      } else {
        const r = rotateDelta(d.dx ?? 0, d.dy ?? 0, page.rotation)
        const res = planMove(page, content, selKeys, r.x, r.y, canvas())
        apply(res, `nudge:${page.id}`)
        setObjSel({ pageId: page.id, keys: res.keys })
      }
    }
    window.addEventListener('toolbox:objects', on)
    return () => window.removeEventListener('toolbox:objects', on)
  })

  // ---- pointer: hover, click, shift-click, marquee, group drag ------------------------------
  const local = (e: { clientX: number; clientY: number }) => {
    const p = screenToLocal(e.clientX, e.clientY, layerRef.current!, page.rotation)
    return { x: p.x / scale, y: p.y / scale }
  }
  const pressRef = useRef<Press | null>(null)

  /** What is currently drawn inside `b` (main canvas + moved/pasted layers), for drag previews. */
  const snapshotAt = (b: Box): string | null => {
    const main = canvas()
    if (!main) return null
    try {
      const k = main.width / info.width
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(b.w * k))
      c.height = Math.max(1, Math.round(b.h * k))
      const ctx = c.getContext('2d')!
      ctx.drawImage(main, b.x * k, b.y * k, b.w * k, b.h * k, 0, 0, c.width, c.height)
      const layers = canvasHolder.current?.parentElement?.querySelectorAll<HTMLCanvasElement>('canvas[data-layer]') ?? []
      for (const l of layers) {
        const lk = l.width / Number(l.dataset.w)
        ctx.drawImage(l, (b.x - Number(l.dataset.dx)) * lk, (b.y - Number(l.dataset.dy)) * lk, b.w * lk, b.h * lk, 0, 0, c.width, c.height)
      }
      return c.toDataURL('image/png')
    } catch {
      return null
    }
  }

  const onPointerDownCapture = (e: React.PointerEvent) => {
    // shift-click on a text box adds it to / removes it from the selection
    if (tool !== 'edit' || !e.shiftKey) return
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-overlay-id]')?.dataset.overlayId
    if (!id || !itemByKey.has(`v:${id}`)) return
    e.preventDefault()
    e.stopPropagation()
    const key = `v:${id}`
    setObjSel({ pageId: page.id, keys: selSet.has(key) ? selKeys.filter((k) => k !== key) : [...selKeys, key] })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    if (tool === 'add-text') return onAddText(e)
    if (tool === 'add-line') {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      const p = local(e)
      setDrawing({ x1: p.x, y1: p.y, x2: p.x, y2: p.y })
      return
    }
    if (tool !== 'edit') return
    const p = local(e)
    const it = hitItem(items, p.x, p.y, 4 / scale)
    dispatch({ type: 'selectOverlay', sel: null })
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (!it) {
      pressRef.current = { mode: 'marquee', start: p, base: e.shiftKey ? selKeys : [] }
      if (!e.shiftKey) setObjSel(null)
      return
    }
    if (e.shiftKey) {
      setObjSel({ pageId: page.id, keys: selSet.has(it.key) ? selKeys.filter((k) => k !== it.key) : [...selKeys, it.key] })
      pressRef.current = null
      return
    }
    const keys = selSet.has(it.key) ? selKeys : [it.key]
    if (!selSet.has(it.key)) setObjSel({ pageId: page.id, keys })
    pressRef.current = { mode: 'drag', key: it.key, keys, sx: e.clientX, sy: e.clientY, moved: false, wasOnlySelection: selKeys.length === 1 && selKeys[0] === it.key }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (drawing) {
      const p = snapEnd(drawing.x1, drawing.y1, local(e), e.shiftKey)
      setDrawing({ ...drawing, x2: p.x, y2: p.y })
      return
    }
    if (tool !== 'edit') return
    const pr = pressRef.current
    if (pr?.mode === 'marquee') {
      const p = local(e)
      setMarquee({ x: Math.min(p.x, pr.start.x), y: Math.min(p.y, pr.start.y), w: Math.abs(p.x - pr.start.x), h: Math.abs(p.y - pr.start.y) })
      return
    }
    if (pr?.mode === 'drag') {
      if (!pr.moved && Math.hypot(e.clientX - pr.sx, e.clientY - pr.sy) < 4) return
      const d = rotateDelta(e.clientX - pr.sx, e.clientY - pr.sy, page.rotation)
      if (!pr.moved) {
        pr.moved = true
        // drawn lines follow the drag themselves (SVG); everything else gets a snapshot
        const ghosts = pr.keys
          .map((k) => itemByKey.get(k))
          .filter((x): x is Item => !!x && !(x.overlay && isLine(x.overlay)))
          .map((it) => ({ key: it.key, b: it.bounds, src: snapshotAt(it.bounds) }))
        setDrag({ dx: d.x / scale, dy: d.y / scale, ghosts })
        return
      }
      setDrag((g) => (g ? { ...g, dx: d.x / scale, dy: d.y / scale } : g))
      return
    }
    const p = local(e)
    setHover(hitItem(items, p.x, p.y, 4 / scale)?.key ?? null)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (drawing) {
      const d = drawing
      setDrawing(null)
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 3) return
      const line = makeLineOverlay(d.x1, d.y1, d.x2, d.y2, lineStyle)
      dispatch({ type: 'editOverlays', pageId: page.id, add: [line] })
      setTool('edit')
      setObjSel({ pageId: page.id, keys: [`v:${line.id}`] })
      return
    }
    const pr = pressRef.current
    pressRef.current = null
    if (!pr) return
    if (pr.mode === 'marquee') {
      const r = marquee
      setMarquee(null)
      if (r && r.w * scale > 3 && r.h * scale > 3) {
        const picked = marqueeSelect(items, r)
        setObjSel({ pageId: page.id, keys: [...new Set([...pr.base, ...picked])] })
      }
      return
    }
    if (pr.moved && drag) {
      const keys = pr.keys
      for (const k of keys) {
        const it = itemByKey.get(k)
        if (it?.obj?.type === 'IMAGE' && !imageSnapshots.has(it.obj.id)) {
          const g = drag.ghosts.find((x) => x.key === k)
          if (g?.src) imageSnapshots.set(it.obj.id, g.src)
        }
      }
      const res = planMove(page, content, keys, drag.dx, drag.dy, canvas())
      apply(res)
      setObjSel({ pageId: page.id, keys: res.keys })
      setDrag(null)
      return
    }
    setDrag(null)
    // a click on one member of a multi-selection narrows the selection to it;
    // a click on the only selected text object starts editing it
    const it = itemByKey.get(pr.key)
    if (pr.keys.length > 1) setObjSel({ pageId: page.id, keys: [pr.key] })
    else if (pr.wasOnlySelection && it?.obj && isTextObject(it.obj)) editObject(it.obj.id, { x: e.clientX, y: e.clientY })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'edit' || !content) return
    const p = local(e)
    const it = hitItem(items, p.x, p.y, 4 / scale)
    if (it?.obj && isTextObject(it.obj)) editObject(it.obj.id, { x: e.clientX, y: e.clientY })
  }

  // ---- resize handles on a single, not yet moved object (redrawn as an overlay) ------------
  const resizeRef = useRef<{ id: string; side: string; sx: number; sy: number; box: Box } | null>(null)
  const [resizeBox, setResizeBox] = useState<Box | null>(null)
  const onHandleDown = (e: React.PointerEvent, id: string, side: string) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resizeRef.current = { id, side, sx: e.clientX, sy: e.clientY, box: content!.objects[id].bounds }
  }
  const onHandleMove = (e: React.PointerEvent) => {
    const r = resizeRef.current
    if (!r) return
    const d = rotateDelta(e.clientX - r.sx, e.clientY - r.sy, page.rotation)
    const dx = d.x / scale
    const dy = d.y / scale
    const b = r.box
    let n = { ...b }
    if (r.side.includes('w')) n = { ...n, x: b.x + Math.min(dx, b.w - 4), w: Math.max(4, b.w - dx) }
    if (r.side.includes('e')) n = { ...n, w: Math.max(4, b.w + dx) }
    if (r.side.includes('n')) n = { ...n, y: b.y + Math.min(dy, b.h - 2), h: Math.max(2, b.h - dy) }
    if (r.side.includes('s')) n = { ...n, h: Math.max(2, b.h + dy) }
    setResizeBox(n)
  }
  const onHandleUp = () => {
    const r = resizeRef.current
    resizeRef.current = null
    if (r && resizeBox && content) resizeObject(content.objects[r.id], resizeBox)
    setResizeBox(null)
  }
  const resizeObject = (o: ContentObject, box: Box) => {
    if (!content) return
    const cv = canvas()
    if (isTextObject(o)) {
      const ov = textOverlayFromObject(o, content, cv)
      Object.assign(ov, { x: box.x, width: box.w, wrap: true })
      dispatch({ type: 'addOverlay', pageId: page.id, overlay: ov })
    } else if (isGraphicObject(o)) {
      if (o.type === 'IMAGE' && !imageSnapshots.has(o.id)) {
        const snap = snapshotRegion(cv, content.width, o.bounds)
        if (snap) imageSnapshots.set(o.id, snap)
      }
      const g = graphicOverlayFromObject(o, content, cv)
      Object.assign(g, { x: box.x, y: box.y, w: box.w, h: box.h })
      dispatch({ type: 'addOverlay', pageId: page.id, overlay: g })
    }
    setSelectedObject(null)
  }

  // ---- endpoints of a selected drawn line -------------------------------------------------
  const onEndDown = (e: React.PointerEvent, l: LineOverlay, end: 1 | 2) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    setEndDrag({ id: l.id, end, x: end === 1 ? l.x1 : l.x2, y: end === 1 ? l.y1 : l.y2 })
  }
  const onEndMove = (e: React.PointerEvent, l: LineOverlay) => {
    if (!endDrag) return
    const [ax, ay] = endDrag.end === 1 ? [l.x2, l.y2] : [l.x1, l.y1]
    const p = snapEnd(ax, ay, local(e), e.shiftKey)
    setEndDrag({ ...endDrag, x: p.x, y: p.y })
  }
  const onEndUp = () => {
    if (!endDrag) return
    update(endDrag.id, endDrag.end === 1 ? { x1: endDrag.x, y1: endDrag.y } : { x2: endDrag.x, y2: endDrag.y })
    setEndDrag(null)
  }

  // ---- add text -----------------------------------------------------------------------
  const onAddText = (e: React.PointerEvent) => {
    e.preventDefault()
    const p = screenToLocal(e.clientX, e.clientY, layerRef.current!, page.rotation)
    const fs = 12
    const x = clamp(p.x / scale, 0, info.width - 40)
    const y = clamp(p.y / scale - fs * 0.6, 0, info.height - fs * 1.2)
    const overlay = makeTextOverlay(x, y, { text: '', fontSize: fs, width: Math.min(200, info.width - x - 8) })
    dispatch({ type: 'startDraft', pageId: page.id, overlay, original: null })
    setCaretAt(null)
    setEditingId(overlay.id)
    setTool('select')
  }

  // ---- render -------------------------------------------------------------------------
  const S = (b: Box, pad = 0): React.CSSProperties => ({ left: (b.x - pad) * scale, top: (b.y - pad) * scale, width: (b.w + 2 * pad) * scale, height: (b.h + 2 * pad) * scale })
  const hovered = hover && !selSet.has(hover) && !drag ? itemByKey.get(hover) : undefined
  const single = selItems.length === 1 ? selItems[0] : null
  const group = selItems.length > 1 ? groupBounds(selItems) : null
  const interactive = tool === 'edit' || tool === 'select'
  const handlesFor = single?.obj && !single.move && single.obj.editable && single.obj.type !== 'TABLE' && !drag ? single.obj : null
  const tableOf = (cell: ContentObject) => (cell.parent ? content?.objects[content.objects[cell.parent]?.parent ?? ''] : undefined)

  return (
    <>
      {/* hide originals: exact (operators skipped in the render) or with a sampled-colour cover */}
      <div className="pointer-events-none absolute inset-0" style={{ zIndex: 2 }}>
        {overlays.map((o) => {
          if (isMove(o) || isPaste(o)) return null
          const hiddenExactly = o.source?.exclusive && o.source.ops.every((op) => renderedHidden.has(op))
          if (hiddenExactly) return null
          if (isText(o) && o.cover) return <div key={`c-${o.id}`} style={{ position: 'absolute', ...S(o.cover), background: o.cover.color }} />
          if (isGraphic(o)) return <div key={`c-${o.id}`} style={{ position: 'absolute', ...S(o.source.bounds, 1), background: o.coverColor }} />
          return null
        })}
        {drag?.ghosts.map((g) => <div key={`gc-${g.key}`} style={{ position: 'absolute', ...S(g.b, 1), background: '#ffffff', opacity: 0.85 }} />)}
      </div>

      <div className="pointer-events-none absolute inset-0" style={{ zIndex: 3 }}>
        {overlays.filter(isGraphic).map((o) => (
          <GraphicBox
            key={o.id}
            overlay={o}
            scale={scale}
            rotation={page.rotation}
            selected={selOverlay === o.id || selSet.has(`v:${o.id}`)}
            interactive={interactive}
            onSelect={() => selectOverlay(o.id)}
            onChange={(patch, key) => update(o.id, patch, key)}
          />
        ))}
      </div>

      {/* lines drawn with Add Line */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" style={{ zIndex: 3 }}>
        {overlays.filter(isLine).map((o) => {
          const moving = drag && selSet.has(`v:${o.id}`)
          let l = moving ? { ...o, x1: o.x1 + drag.dx, y1: o.y1 + drag.dy, x2: o.x2 + drag.dx, y2: o.y2 + drag.dy } : o
          if (endDrag?.id === o.id) l = endDrag.end === 1 ? { ...l, x1: endDrag.x, y1: endDrag.y } : { ...l, x2: endDrag.x, y2: endDrag.y }
          return <LineSvg key={o.id} l={l} scale={scale} />
        })}
        {drawing && <LineSvg l={{ ...lineStyle, ...drawing }} scale={scale} />}
      </svg>

      {/* Edit mode: hover / select / marquee / drag over cached geometry */}
      <div
        ref={layerRef}
        data-edit-layer
        data-page-width={info.width}
        className="absolute inset-0"
        style={{
          zIndex: 4,
          pointerEvents: tool === 'edit' || tool === 'add-text' || tool === 'add-line' ? 'auto' : 'none',
          cursor: tool === 'add-text' ? 'text' : tool === 'add-line' ? 'crosshair' : drag ? 'grabbing' : hovered || (hover && selSet.has(hover)) ? 'move' : undefined,
          touchAction: 'none',
        }}
        onPointerDownCapture={onPointerDownCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
      >
        {tool === 'edit' && (
          <>
            {hovered && (
              <>
                {hovered.obj?.type === 'TABLE_CELL' && tableOf(hovered.obj) && (
                  <div className="obj-hover dashed" style={S(itemByKey.get(`o:${tableOf(hovered.obj)!.id}`)?.bounds ?? tableOf(hovered.obj)!.bounds)} />
                )}
                <div className="obj-hover" style={S(hovered.bounds, hovered.obj?.type === 'LINE' ? 2 : 1)} />
                <Tag text={itemLabel(hovered)} style={{ left: hovered.bounds.x * scale, top: hovered.bounds.y * scale - 18 }} />
              </>
            )}
            {!drag && selItems.map((it) => <div key={`s-${it.key}`} className="obj-selected" style={S(it === single && resizeBox ? resizeBox : it.bounds, 2)} />)}
            {group && !drag && (
              <>
                <div className="pointer-events-none absolute" style={{ ...S(group, 5), outline: '1px dashed #1075dc' }} />
                <Tag text={`${selItems.length} objects · drag to move together`} style={{ left: (group.x - 5) * scale, top: (group.y - 5) * scale - 18 }} dark />
              </>
            )}
            {single && !drag && !hovered && <Tag text={itemLabel(single)} style={{ left: single.bounds.x * scale, top: single.bounds.y * scale - 18 }} dark />}
            {handlesFor &&
              (handlesFor.type === 'LINE' ? (handlesFor.bounds.w >= handlesFor.bounds.h ? ['w', 'e'] : ['n', 's']) : isTextObject(handlesFor) ? ['w', 'e'] : ['nw', 'ne', 'sw', 'se']).map((side) => {
                const b = resizeBox ?? handlesFor.bounds
                const px = side.includes('w') ? b.x - 2 : side.includes('e') ? b.x + b.w + 2 : b.x + b.w / 2
                const py = side.includes('n') ? b.y - 2 : side.includes('s') ? b.y + b.h + 2 : b.y + b.h / 2
                return (
                  <div
                    key={side}
                    className="handle"
                    style={{ left: px * scale - 4, top: py * scale - 4, cursor: side === 'w' || side === 'e' ? 'ew-resize' : side === 'n' || side === 's' ? 'ns-resize' : side === 'nw' || side === 'se' ? 'nwse-resize' : 'nesw-resize' }}
                    onPointerDown={(e) => onHandleDown(e, handlesFor.id, side)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                  />
                )
              })}
            {drag?.ghosts.map((g) => (
              <div
                key={`g-${g.key}`}
                className="pointer-events-none absolute"
                style={{ ...S(g.b), transform: `translate(${drag.dx * scale}px, ${drag.dy * scale}px)`, outline: '1.5px solid #1075dc', opacity: 0.92 }}
              >
                {g.src && <img src={g.src} alt="" style={{ width: '100%', height: '100%' }} draggable={false} />}
              </div>
            ))}
            {marquee && <div className="pointer-events-none absolute" style={{ ...S(marquee), outline: '1px dashed #1075dc', background: 'rgba(63,166,238,0.08)' }} />}
            {single?.overlay && isLine(single.overlay) && !drag &&
              ([1, 2] as const).map((end) => {
                const l = single.overlay as LineOverlay
                const live = endDrag?.id === l.id && endDrag.end === end
                const x = live ? endDrag.x : end === 1 ? l.x1 : l.x2
                const y = live ? endDrag.y : end === 1 ? l.y1 : l.y2
                return (
                  <div
                    key={end}
                    className="handle"
                    style={{ left: x * scale - 4, top: y * scale - 4, cursor: 'crosshair' }}
                    onPointerDown={(e) => onEndDown(e, l, end)}
                    onPointerMove={(e) => onEndMove(e, l)}
                    onPointerUp={onEndUp}
                  />
                )
              })}
          </>
        )}
        {overlays.filter(isText).map((o) => (
          <TextBox
            key={o.id}
            overlay={o}
            scale={scale}
            rotation={page.rotation}
            selected={selOverlay === o.id || selSet.has(`v:${o.id}`)}
            editing={editingId === o.id}
            caretAt={editingId === o.id ? caretAt : null}
            onSelect={() => selectOverlay(o.id)}
            onStartEdit={(at) => startEdit(o.id, at)}
            onStopEdit={(e) => stopEdit(o, e)}
            onChange={(patch, key) => update(o.id, patch, key)}
          />
        ))}
      </div>
    </>
  )
}

function Tag({ text, style, dark }: { text: string; style: React.CSSProperties; dark?: boolean }) {
  return (
    <div className={`pointer-events-none absolute z-10 whitespace-nowrap px-1.5 py-[1px] font-mono text-[10px] font-medium uppercase tracking-wide text-white ${dark ? 'bg-sky-deep' : 'bg-sky'}`} style={style}>
      {text}
    </div>
  )
}

/** Shift snaps a line to 0° / 45° / 90°. */
function snapEnd(x0: number, y0: number, p: { x: number; y: number }, snap: boolean) {
  if (!snap) return p
  const dx = p.x - x0
  const dy = p.y - y0
  const len = Math.hypot(dx, dy)
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: x0 + len * Math.cos(a), y: y0 + len * Math.sin(a) }
}

function LineSvg({ l, scale }: { l: Pick<LineOverlay, 'x1' | 'y1' | 'x2' | 'y2' | 'color' | 'thickness' | 'dash'>; scale: number }) {
  const t = Math.max(0.5, l.thickness * scale)
  return (
    <line
      x1={l.x1 * scale}
      y1={l.y1 * scale}
      x2={l.x2 * scale}
      y2={l.y2 * scale}
      stroke={l.color}
      strokeWidth={t}
      strokeDasharray={l.dash === 'dashed' ? `${4 * t} ${3 * t}` : l.dash === 'dotted' ? `0 ${2.5 * t}` : undefined}
      strokeLinecap={l.dash === 'dotted' ? 'round' : 'butt'}
    />
  )
}
