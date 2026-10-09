import { Component, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RenderTask } from 'pdfjs-dist'
import { useApp } from '../context'
import { clamp } from '../lib/geom'
import { displaySize, type PageInfo, type PageModel } from '../lib/model'
import { getPdfPage, pdfjs } from '../lib/pdfjs'
import { ContentLayers } from './ContentLayers'
import { LayoutLayer } from './LayoutLayer'
import { PageOverlays } from './PageOverlays'
import { Rulers } from './Rulers'
import { SearchLayer } from './SearchLayer'
import { Rotated } from './ui'

const PAD = 28
const GAP = 18
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4
const MAX_CANVAS_PIXELS = 16_000_000

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

class PageBoundary extends Component<{ children: ReactNode; label: string }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError() {
    return { error: true }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full items-center justify-center bg-white p-6 text-center text-sm text-slate-500">
          {this.props.label} could not be displayed. Other pages are unaffected.
        </div>
      )
    }
    return this.props.children
  }
}

interface PageViewProps {
  page: PageModel
  info: PageInfo
  scale: number
  renderScale: number
}

/** Canvas + selectable text layer for one page, plus the editing overlays. */
const PageContent = memo(function PageContent({ page, info, scale, renderScale }: PageViewProps) {
  const holderRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [renderedHidden, setRenderedHidden] = useState<Set<number>>(() => new Set())
  const { tool, showBoxes, debug, search, state } = useApp()
  const replacedByDraft = state.draft?.pageId === page.id ? state.draft.replaces : undefined
  const hits = useMemo(() => search?.hits.filter((h) => h.pageId === page.id && h.rects.length) ?? [], [search, page.id])
  const edited = useMemo(() => new Set(page.overlays.flatMap((o) => (o.source ? [o.source.objectId] : []))), [page.overlays])
  // Operators whose content has been replaced by an edit: skipped when rendering (exact hiding).
  const hiddenKey = useMemo(
    () => [...new Set(page.overlays.flatMap((o) => (o.source?.exclusive ? o.source.ops : [])))].sort((a, b) => a - b).join(','),
    [page.overlays],
  )

  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null
    ;(async () => {
      try {
        const pdfPage = await getPdfPage(page.sourceId, page.srcIndex)
        if (cancelled) return
        const viewport = pdfPage.getViewport({ scale: renderScale })
        let out = Math.min(window.devicePixelRatio || 1, 2)
        while (viewport.width * viewport.height * out * out > MAX_CANVAS_PIXELS && out > 0.3) out *= 0.9
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.floor(viewport.width * out))
        canvas.height = Math.max(1, Math.floor(viewport.height * out))
        canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%'
        const hidden = new Set(hiddenKey ? hiddenKey.split(',').map(Number) : [])
        task = pdfPage.render({
          canvas,
          viewport,
          transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined,
          operationsFilter: hidden.size ? (i: number) => !hidden.has(i) : undefined,
        })
        await task.promise
        if (cancelled) return
        setRenderedHidden(hidden)
        const holder = holderRef.current
        if (!holder) return
        const old = holder.querySelector(':scope > canvas')
        if (old) old.replaceWith(canvas)
        else holder.prepend(canvas)
        setFailed(null)

        // selectable text
        let layerEl = holder.querySelector<HTMLDivElement>(':scope > .textLayer')
        if (!layerEl) {
          layerEl = document.createElement('div')
          layerEl.className = 'textLayer'
          holder.appendChild(layerEl)
        }
        layerEl.replaceChildren()
        layerEl.style.setProperty('--scale-factor', String(renderScale))
        layerEl.style.setProperty('--total-scale-factor', String(renderScale))
        textLayer = new pdfjs.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layerEl, viewport })
        await textLayer.render()
      } catch (e) {
        const err = e as { name?: string; message?: string }
        if (cancelled || err?.name === 'RenderingCancelledException' || err?.name === 'AbortException') return
        setFailed(err?.message ?? 'render error')
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
      textLayer?.cancel()
    }
  }, [page.sourceId, page.srcIndex, renderScale, hiddenKey])

  const w = info.width * scale
  const h = info.height * scale
  const k = scale / renderScale
  return (
    <Rotated w={w} h={h} rotation={page.rotation}>
      <div className="relative h-full w-full overflow-hidden bg-white" style={{ width: w, height: h }}>
        <div
          ref={holderRef}
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: info.width * renderScale, height: info.height * renderScale, transform: k !== 1 ? `scale(${k})` : undefined, pointerEvents: tool === 'select' ? 'auto' : 'none' }}
        />
        {failed && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted">This page could not be rendered ({failed}).</div>}
        <ContentLayers page={page} scale={scale} renderScale={renderScale} skip={replacedByDraft} />
        <PageOverlays page={page} info={info} scale={scale} canvasHolder={holderRef} renderedHidden={renderedHidden} />
        {(showBoxes || debug) && <LayoutLayer page={page} info={info} scale={scale} edited={edited} />}
        {hits.length > 0 && <SearchLayer hits={hits} activeId={search?.activeId ?? null} scale={scale} />}
      </div>
    </Rotated>
  )
})

export function Viewer() {
  const { state, scale: _s, setScale, zoom, setZoom, currentIndex, setCurrentIndex, scrollRequest, tool, dispatch, showRulers } = useApp()
  void _s
  const { pages, sources } = state
  const scrollRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const sizes = useMemo(() => pages.map((p) => displaySize(p, sources[p.sourceId].pages[p.srcIndex])), [pages, sources])
  const maxW = Math.max(1, ...sizes.map((s) => s.w))
  const scale = zoom.mode === 'fit' ? clamp((box.w - 2 * PAD) / maxW, MIN_ZOOM, MAX_ZOOM) : zoom.value
  const renderScale = useDebounced(scale, 160)
  useEffect(() => setScale(scale), [scale, setScale])

  const layout = useMemo(() => {
    const tops: number[] = []
    let y = PAD
    for (const s of sizes) {
      tops.push(y)
      y += s.h * scale + GAP
    }
    return { tops, total: y - GAP + PAD }
  }, [sizes, scale])
  const contentW = Math.max(box.w, maxW * scale + 2 * PAD)

  // zoom keeps the middle of the viewport in place (ignored until the viewport has been measured)
  const prevTotal = useRef(layout.total)
  const measured = useRef(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    const ready = box.w > 0
    if (el && measured.current && el.scrollTop > 0 && prevTotal.current !== layout.total && prevTotal.current > 0) {
      const mid = (el.scrollTop + el.clientHeight / 2) / prevTotal.current
      el.scrollTop = Math.max(0, mid * layout.total - el.clientHeight / 2)
    }
    measured.current = ready
    prevTotal.current = layout.total
  }, [layout.total, box.w])

  const rafRef = useRef(0)
  const onScroll = () => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => setScrollTop(scrollRef.current?.scrollTop ?? 0))
  }

  // visible window of pages (+ one screen of buffer)
  const { first, last } = useMemo(() => {
    const lo = scrollTop - box.h
    const hi = scrollTop + box.h * 2
    let f = 0
    while (f < pages.length - 1 && layout.tops[f] + sizes[f].h * scale < lo) f += 1
    let l = f
    while (l < pages.length - 1 && layout.tops[l + 1] < hi) l += 1
    return { first: f, last: l }
  }, [scrollTop, box.h, pages.length, layout, sizes, scale])

  // current page = the one under the upper part of the viewport
  useEffect(() => {
    const probe = scrollTop + box.h * 0.35
    let idx = 0
    for (let i = 0; i < pages.length; i += 1) {
      if (layout.tops[i] <= probe) idx = i
      else break
    }
    const el = scrollRef.current
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 4) idx = pages.length - 1
    if (idx !== currentIndex) setCurrentIndex(idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTop, layout, box.h, pages.length])

  // programmatic navigation
  useEffect(() => {
    if (!scrollRequest) return
    const i = clamp(scrollRequest.index, 0, pages.length - 1)
    scrollRef.current?.scrollTo({ top: Math.max(0, layout.tops[i] - PAD / 2), behavior: 'smooth' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest])

  // pinch / ctrl+wheel zoom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setZoom({ mode: 'custom', value: clamp(scale * Math.exp(-e.deltaY * 0.0025), MIN_ZOOM, MAX_ZOOM) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scale, setZoom])

  const cursor = tool === 'add-text' ? 'text' : undefined
  const viewer = (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="thin-scroll relative flex-1 overflow-auto bg-canvas"
      style={{ cursor }}
      onPointerDown={(e) => {
        const t = e.target as HTMLElement
        if (!t.closest('[data-overlay-id]') && state.selectedOverlay) dispatch({ type: 'selectOverlay', sel: null })
      }}
      aria-label="Document viewer"
    >
      <div style={{ position: 'relative', width: contentW, height: layout.total }}>
        {pages.slice(first, last + 1).map((p, k) => {
          const i = first + k
          const info = sources[p.sourceId].pages[p.srcIndex]
          const s = sizes[i]
          return (
            <div
              key={p.id}
              data-page-index={i}
              data-page-id={p.id}
              style={{ position: 'absolute', top: layout.tops[i], left: (contentW - s.w * scale) / 2, width: s.w * scale, height: s.h * scale }}
              className="bg-white shadow-[0_0_0_1px_rgba(20,20,20,0.10),0_2px_8px_-2px_rgba(20,20,20,0.12)]"
            >
              <PageBoundary label={`Page ${i + 1}`}>
                <PageContent page={p} info={info} scale={scale} renderScale={renderScale} />
              </PageBoundary>
            </div>
          )
        })}
      </div>
    </div>
  )
  // always wrapped (rulers hidden or not) so the scroll container is never remounted
  return (
    <Rulers enabled={showRulers} scrollRef={scrollRef} tops={layout.tops} contentW={contentW} sizes={sizes} scale={scale}>
      {viewer}
    </Rulers>
  )
}
