import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useApp } from '../context'
import { clamp, rotateDelta, screenToLocal } from '../lib/geom'
import { isGraphic, isText, makeTextOverlay, type Overlay, type OverlayPatch, type PageInfo, type PageModel, type TextOverlay } from '../lib/model'
import { getCachedContent, getPageContent, onContentAnalyzed } from '../lib/content/cache'
import {
  describeObject, graphicOverlayFromObject, imageSnapshots, isGraphicObject, isTextObject, snapshotRegion, textOverlayFromObject,
} from '../lib/content/edits'
import type { Box, ContentObject, PageContent } from '../lib/content/types'
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

const DEBUG_COLORS: Record<string, string> = {
  TEXT_BLOCK: '#2563eb',
  TEXT_LINE: '#16a34a',
  TEXT_SPAN: '#86efac',
  TABLE: '#9333ea',
  TABLE_ROW: '#c4b5fd',
  TABLE_CELL: '#eab308',
  LINE: '#dc2626',
  RECTANGLE: '#0891b2',
  IMAGE: '#ea580c',
}

const inBox = (b: Box, x: number, y: number, slop = 0) => x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop

export function PageOverlays({ page, info, scale, canvasHolder, renderedHidden }: Props) {
  const { state, dispatch, tool, setTool, selectedObject, setSelectedObject, editRequest, debug } = useApp()
  const layerRef = useRef<HTMLDivElement>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [caretAt, setCaretAt] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [ghost, setGhost] = useState<{ id: string; dx: number; dy: number; src: string | null } | null>(null)
  const content = usePageContent(page.sourceId, page.srcIndex, tool === 'edit' || debug)

  const draft = state.draft && state.draft.pageId === page.id ? state.draft : null
  const overlays: Overlay[] = draft && !page.overlays.some((o) => o.id === draft.overlay.id) ? [...page.overlays, draft.overlay] : page.overlays
  const selOverlay = state.selectedOverlay?.pageId === page.id ? state.selectedOverlay.overlayId : null
  const selObject = selectedObject?.pageId === page.id ? selectedObject.objectId : null
  const canvas = () => canvasHolder.current?.querySelector('canvas')

  // objects already replaced by an edit are no longer hit-testable (their overlay is)
  const replaced = useMemo(() => new Set(overlays.flatMap((o) => (o.source ? [o.source.objectId] : []))), [overlays])

  useEffect(() => {
    if (editingId && !overlays.some((o) => o.id === editingId)) setEditingId(null)
  }, [overlays, editingId])

  const update = useCallback(
    (id: string, patch: OverlayPatch, coalesce?: string) => dispatch({ type: 'updateOverlay', pageId: page.id, overlayId: id, patch, coalesce }),
    [dispatch, page.id],
  )
  const selectOverlay = (id: string) => {
    setSelectedObject(null)
    dispatch({ type: 'selectOverlay', sel: { pageId: page.id, overlayId: id } })
  }

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

  // ---- edit a detected object ------------------------------------------------------
  const editObject = useCallback(
    (objectId: string, at: { x: number; y: number } | null) => {
      if (!content) return
      const o = content.objects[objectId]
      if (!o || !isTextObject(o)) return
      const ov = textOverlayFromObject(o, content, canvasHolder.current?.querySelector('canvas'))
      setSelectedObject(null)
      dispatch({ type: 'startDraft', pageId: page.id, overlay: ov, original: o.text ?? '' })
      setCaretAt(at)
      setEditingId(ov.id)
    },
    [content, dispatch, page.id, setSelectedObject, canvasHolder],
  )

  useEffect(() => {
    if (editRequest && editRequest.pageId === page.id) editObject(editRequest.objectId, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest])

  /** Commit a move/resize/delete of a detected object as an overlay. */
  const commitObject = (o: ContentObject, change: { dx?: number; dy?: number; box?: Box; deleted?: boolean }) => {
    if (!content) return
    const cv = canvas()
    if (isTextObject(o)) {
      const ov = textOverlayFromObject(o, content, cv)
      if (change.deleted) ov.text = ''
      ov.x += change.dx ?? 0
      ov.y += change.dy ?? 0
      if (change.box) {
        ov.x = change.box.x
        ov.width = change.box.w
        ov.wrap = true
      }
      dispatch({ type: 'addOverlay', pageId: page.id, overlay: ov })
      if (change.deleted) dispatch({ type: 'selectOverlay', sel: null })
    } else if (isGraphicObject(o)) {
      if (o.type === 'IMAGE' && !imageSnapshots.has(o.id)) {
        const snap = snapshotRegion(cv, content.width, o.bounds)
        if (snap) imageSnapshots.set(o.id, snap)
      }
      const g = graphicOverlayFromObject(o, content, cv)
      g.x += change.dx ?? 0
      g.y += change.dy ?? 0
      if (change.box) Object.assign(g, { x: change.box.x, y: change.box.y, w: change.box.w, h: change.box.h })
      g.deleted = !!change.deleted
      dispatch({ type: 'addOverlay', pageId: page.id, overlay: g })
      if (change.deleted) dispatch({ type: 'selectOverlay', sel: null })
    }
    setSelectedObject(null)
  }

  // deletion requested from the keyboard / properties panel
  useEffect(() => {
    const onDelete = (e: Event) => {
      const d = (e as CustomEvent<{ pageId: string; objectId: string }>).detail
      if (d.pageId !== page.id || !content?.objects[d.objectId]) return
      commitObject(content.objects[d.objectId], { deleted: true })
    }
    window.addEventListener('toolbox:delete-object', onDelete)
    return () => window.removeEventListener('toolbox:delete-object', onDelete)
  })

  // ---- hit testing (cached geometry only) ---------------------------------------------
  const hitTest = (x: number, y: number): string | null => {
    if (!content) return null
    const slop = 4 / scale
    for (const id of content.hitOrder) {
      if (replaced.has(id)) continue
      const o = content.objects[id]
      if (o.type === 'LINE') {
        if (inBox(o.bounds, x, y, slop)) return id
        continue
      }
      if (o.type === 'TABLE') {
        // tables are picked on their outline; the inside belongs to cells
        const b = o.bounds
        const near = inBox(b, x, y, slop) && (Math.abs(x - b.x) < slop || Math.abs(x - b.x - b.w) < slop || Math.abs(y - b.y) < slop || Math.abs(y - b.y - b.h) < slop)
        if (near) return id
        continue
      }
      if (inBox(o.bounds, x, y)) return id
    }
    return null
  }

  const local = (e: { clientX: number; clientY: number }) => {
    const p = screenToLocal(e.clientX, e.clientY, layerRef.current!, page.rotation)
    return { x: p.x / scale, y: p.y / scale }
  }

  const pressRef = useRef<{ id: string; sx: number; sy: number; moved: boolean; resize?: string; box: Box } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.objHit) return
    if (tool === 'add-text') return onAddText(e)
    if (tool !== 'edit' || !content) return
    const p = local(e)
    const id = hitTest(p.x, p.y)
    dispatch({ type: 'selectOverlay', sel: null })
    if (!id) {
      setSelectedObject(null)
      return
    }
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pressRef.current = { id, sx: e.clientX, sy: e.clientY, moved: false, box: content.objects[id].bounds }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (tool !== 'edit' || !content) return
    const pr = pressRef.current
    if (pr) {
      if (!pr.moved && Math.hypot(e.clientX - pr.sx, e.clientY - pr.sy) < 4) return
      const o = content.objects[pr.id]
      if (!o.editable || o.type === 'TABLE') return
      if (!pr.moved) {
        pr.moved = true
        setGhost({ id: pr.id, dx: 0, dy: 0, src: snapshotRegion(canvas(), content.width, o.bounds) })
      }
      const d = rotateDelta(e.clientX - pr.sx, e.clientY - pr.sy, page.rotation)
      setGhost((g) => (g ? { ...g, dx: d.x / scale, dy: d.y / scale } : g))
      return
    }
    const p = local(e)
    setHover(hitTest(p.x, p.y))
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const pr = pressRef.current
    pressRef.current = null
    if (!pr || !content) return
    const o = content.objects[pr.id]
    if (pr.moved && ghost) {
      if (o.type === 'IMAGE' && ghost.src) imageSnapshots.set(o.id, ghost.src)
      commitObject(o, { dx: ghost.dx, dy: ghost.dy })
      setGhost(null)
      return
    }
    setGhost(null)
    // click: select, or (when already selected) start editing text at the caret
    if (selObject === pr.id && isTextObject(o)) editObject(pr.id, { x: e.clientX, y: e.clientY })
    else setSelectedObject({ pageId: page.id, objectId: pr.id })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'edit' || !content) return
    const p = local(e)
    const id = hitTest(p.x, p.y)
    if (id && isTextObject(content.objects[id])) editObject(id, { x: e.clientX, y: e.clientY })
  }

  // resize handles on a selected (unchanged) object
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
    if (r && resizeBox && content) commitObject(content.objects[r.id], { box: resizeBox })
    setResizeBox(null)
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
  const hovered = hover && content && !replaced.has(hover) && hover !== selObject ? content.objects[hover] : null
  const selected = selObject && content?.objects[selObject] && !replaced.has(selObject) ? content.objects[selObject] : null
  const interactive = tool === 'edit' || tool === 'select'

  return (
    <>
      {/* hide originals: exact (operators skipped in the render) or with a sampled-colour cover */}
      <div className="pointer-events-none absolute inset-0" style={{ zIndex: 2 }}>
        {overlays.map((o) => {
          const hiddenExactly = o.source?.exclusive && o.source.ops.every((op) => renderedHidden.has(op))
          if (hiddenExactly) return null
          if (isText(o) && o.cover) return <div key={`c-${o.id}`} style={{ position: 'absolute', ...S(o.cover), background: o.cover.color }} />
          if (isGraphic(o)) return <div key={`c-${o.id}`} style={{ position: 'absolute', ...S(o.source.bounds, 1), background: o.coverColor }} />
          return null
        })}
        {ghost && content?.objects[ghost.id] && <div style={{ position: 'absolute', ...S(content.objects[ghost.id].bounds, 1), background: '#ffffff', opacity: 0.85 }} />}
      </div>

      <div className="pointer-events-none absolute inset-0" style={{ zIndex: 3 }}>
        {overlays.filter(isGraphic).map((o) => (
          <GraphicBox
            key={o.id}
            overlay={o}
            scale={scale}
            rotation={page.rotation}
            selected={selOverlay === o.id}
            interactive={interactive}
            onSelect={() => selectOverlay(o.id)}
            onChange={(patch, key) => update(o.id, patch, key)}
          />
        ))}
      </div>

      {/* Edit mode: object hover / select / drag over cached geometry */}
      <div
        ref={layerRef}
        className="absolute inset-0"
        style={{ zIndex: 4, pointerEvents: tool === 'edit' || tool === 'add-text' ? 'auto' : 'none', cursor: tool === 'add-text' ? 'text' : hovered ? (isTextObject(hovered) ? 'text' : 'move') : undefined, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onDoubleClick}
      >
        {tool === 'edit' && content && (
          <>
            {hovered && (
              <>
                {hovered.type === 'TABLE_CELL' && hovered.parent && content.objects[content.objects[hovered.parent].parent ?? ''] && (
                  <div className="obj-hover dashed" style={S(content.objects[content.objects[hovered.parent].parent!].bounds)} />
                )}
                <div className="obj-hover" style={S(hovered.bounds, hovered.type === 'LINE' ? 2 : 1)} />
                <ObjectTag o={hovered} style={{ left: hovered.bounds.x * scale, top: hovered.bounds.y * scale - 18 }} />
              </>
            )}
            {selected && !ghost && (
              <>
                <div className="obj-selected" style={S(resizeBox ?? selected.bounds, 2)} />
                {selected.editable && selected.type !== 'TABLE' && (
                  (selected.type === 'LINE' ? (selected.bounds.w >= selected.bounds.h ? ['w', 'e'] : ['n', 's']) : isTextObject(selected) ? ['w', 'e'] : ['nw', 'ne', 'sw', 'se']).map((side) => {
                    const b = resizeBox ?? selected.bounds
                    const px = side.includes('w') ? b.x - 2 : side.includes('e') ? b.x + b.w + 2 : b.x + b.w / 2
                    const py = side.includes('n') ? b.y - 2 : side.includes('s') ? b.y + b.h + 2 : b.y + b.h / 2
                    return (
                      <div
                        key={side}
                        className="handle"
                        style={{ left: px * scale - 4, top: py * scale - 4, cursor: side === 'w' || side === 'e' ? 'ew-resize' : side === 'n' || side === 's' ? 'ns-resize' : side === 'nw' || side === 'se' ? 'nwse-resize' : 'nesw-resize' }}
                        onPointerDown={(e) => onHandleDown(e, selected.id, side)}
                        onPointerMove={onHandleMove}
                        onPointerUp={onHandleUp}
                      />
                    )
                  })
                )}
              </>
            )}
            {ghost && content.objects[ghost.id] && (
              <div
                className="pointer-events-none absolute"
                style={{ ...S(content.objects[ghost.id].bounds), transform: `translate(${ghost.dx * scale}px, ${ghost.dy * scale}px)`, outline: '1.5px solid #1075dc', opacity: 0.92 }}
              >
                {ghost.src && <img src={ghost.src} alt="" style={{ width: '100%', height: '100%' }} draggable={false} />}
              </div>
            )}
          </>
        )}
        {overlays.filter(isText).map((o) => (
          <TextBox
            key={o.id}
            overlay={o}
            scale={scale}
            rotation={page.rotation}
            selected={selOverlay === o.id}
            editing={editingId === o.id}
            caretAt={editingId === o.id ? caretAt : null}
            onSelect={() => selectOverlay(o.id)}
            onStartEdit={(at) => startEdit(o.id, at)}
            onStopEdit={(e) => stopEdit(o, e)}
            onChange={(patch, key) => update(o.id, patch, key)}
          />
        ))}
      </div>

      {debug && content && <DebugLayer content={content} scale={scale} />}
    </>
  )
}

function ObjectTag({ o, style }: { o: ContentObject; style: React.CSSProperties }) {
  return (
    <div className="pointer-events-none absolute z-10 whitespace-nowrap bg-sky px-1.5 py-[1px] font-mono text-[10px] font-medium uppercase tracking-wide text-white" style={style}>
      {describeObject(o)}
    </div>
  )
}

/** Developer view: every detected object outlined by type, with an inspector for the object under the cursor. */
function DebugLayer({ content, scale }: { content: PageContent; scale: number }) {
  const [hit, setHit] = useState<{ o: ContentObject; x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const ordered = useMemo(() => Object.values(content.objects).sort((a, b) => a.bounds.w * a.bounds.h - b.bounds.w * b.bounds.h), [content])
  useEffect(() => {
    const host = ref.current?.parentElement
    if (!host) return
    const onMove = (e: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect()
      // the inspector ignores page rotation; good enough for a developer aid
      const x = (e.clientX - r.left) / scale
      const y = (e.clientY - r.top) / scale
      const o = ordered.find((ob) => ob.type !== 'TABLE_ROW' && inBox(ob.bounds, x, y, ob.type === 'LINE' ? 3 : 0))
      setHit(o ? { o, x: e.clientX - r.left, y: e.clientY - r.top } : null)
    }
    const onLeave = () => setHit(null)
    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerleave', onLeave)
    return () => {
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerleave', onLeave)
    }
  }, [ordered, scale])
  const o = hit?.o
  return (
    <div ref={ref} className="pointer-events-none absolute inset-0" style={{ zIndex: 6 }}>
      {Object.values(content.objects).map((ob) => {
        const c = DEBUG_COLORS[ob.type]
        const b = ob.bounds
        const thin = ob.type === 'TEXT_SPAN' || ob.type === 'TABLE_ROW'
        return (
          <div
            key={ob.id}
            style={{
              position: 'absolute',
              left: b.x * scale,
              top: b.y * scale,
              width: Math.max(1, b.w * scale),
              height: Math.max(1, b.h * scale),
              outline: `${ob.type === 'TEXT_BLOCK' || ob.type === 'TABLE' ? 1.5 : 1}px ${thin ? 'dotted' : 'solid'} ${c}`,
              background: ob === o ? `${c}22` : undefined,
            }}
          />
        )
      })}
      {content.roots.map((id) => {
        const ob = content.objects[id]
        if (ob.type !== 'TEXT_BLOCK' && ob.type !== 'TABLE') return null
        const tag = ob.type === 'TABLE' ? `TABLE ${ob.rows}×${ob.cols} · ${ob.tableKind}` : ({ heading: 'H', paragraph: 'P', 'list-item': 'LI', header: 'HDR', footer: 'FTR' } as Record<string, string>)[ob.role ?? 'paragraph']
        return (
          <div key={`t-${id}`} className="absolute font-mono text-[9px] font-medium leading-none text-white" style={{ left: ob.bounds.x * scale - 1, top: ob.bounds.y * scale - 11, background: DEBUG_COLORS[ob.type], padding: '1px 3px' }}>
            {tag}
          </div>
        )
      })}
      {o && hit && (
        <div
          className="absolute z-20 w-[300px] border border-ink bg-white p-2.5 font-mono text-[10.5px] leading-[1.45] text-ink shadow-xl"
          style={{ left: Math.min(hit.x + 14, ref.current!.clientWidth - 310), top: hit.y + 16 }}
        >
          <div className="mb-1 flex items-center gap-1.5 font-semibold">
            <span className="inline-block h-2 w-2" style={{ background: DEBUG_COLORS[o.type] }} />
            {o.type}
            {o.role ? ` / ${o.role}` : ''} <span className="font-normal text-muted">{o.id}</span>
          </div>
          <div>
            bounds {o.bounds.x.toFixed(1)}, {o.bounds.y.toFixed(1)} · {o.bounds.w.toFixed(1)} × {o.bounds.h.toFixed(1)} pt
          </div>
          {o.style && (
            <div>
              {o.style.fontName} → {o.style.fontFamily}
              {o.style.bold ? ' bold' : ''}
              {o.style.italic ? ' italic' : ''} · {o.style.fontSize}pt · {o.style.color ?? '?'} · {o.style.align} · lh {o.style.lineHeight}
            </div>
          )}
          {o.type === 'TABLE' && (
            <div>
              {o.rows} rows × {o.cols} cols · {o.tableKind}
            </div>
          )}
          {o.type === 'LINE' && (
            <div>
              thickness {o.thickness?.toFixed(2)} · {o.strokeColor}
            </div>
          )}
          {o.type === 'RECTANGLE' && (
            <div>
              fill {o.fillColor ?? 'none'} · stroke {o.strokeColor ?? 'none'}
            </div>
          )}
          <div className="text-muted">
            ops {o.ops.length} {o.opsExclusive ? '(exclusive)' : '(shared/unknown)'} · items {o.sourceItems.length} · z {o.zIndex}
          </div>
          {o.text !== undefined && <div className="mt-1 line-clamp-4 whitespace-pre-wrap border-t border-line-soft pt-1 font-sans text-[11px]">{o.text || '(empty)'}</div>}
        </div>
      )}
    </div>
  )
}
