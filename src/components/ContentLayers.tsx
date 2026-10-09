import { memo, useEffect, useMemo, useRef } from 'react'
import type { RenderTask } from 'pdfjs-dist'
import { isMove, isPaste, type PageModel } from '../lib/model'
import { getPageContent } from '../lib/content/cache'
import { getPdfPage, hasSource } from '../lib/pdfjs'

interface Layer {
  key: string
  sourceId: string
  srcIndex: number
  ops: number[]
  dx: number
  dy: number
}

/**
 * Moved and pasted objects, drawn by PDF.js from their original operators (every other painting
 * operator of their page is skipped) and shifted to their new place: same fonts, same vectors,
 * crisp at any zoom. The originals of moved objects are hidden in the main canvas.
 */
export function ContentLayers({ page, scale, renderScale, skip }: { page: PageModel; scale: number; renderScale: number; skip?: string }) {
  const layers = useMemo(() => {
    const out = new Map<string, Layer>()
    // ops of objects inside a table that have their own move (or are deleted): the table's layer skips them
    const ownMoves = new Set(
      page.overlays.flatMap((o) => (isMove(o) && o.source.objType !== 'TABLE' && (o.deleted || Math.abs(o.dx) >= 0.01 || Math.abs(o.dy) >= 0.01) ? o.source.ops : [])),
    )
    for (const o of page.overlays) {
      if (o.id === skip) continue // a move being re-typed as a text edit (the draft shows it)
      if (isMove(o)) {
        if (o.deleted || !o.source.exclusive || (Math.abs(o.dx) < 0.01 && Math.abs(o.dy) < 0.01)) continue
        const key = `m|${o.dx.toFixed(2)}|${o.dy.toFixed(2)}`
        const l = out.get(key) ?? { key, sourceId: page.sourceId, srcIndex: page.srcIndex, ops: [], dx: o.dx, dy: o.dy }
        l.ops.push(...(o.source.objType === 'TABLE' ? o.source.ops.filter((op) => !ownMoves.has(op)) : o.source.ops))
        out.set(key, l)
      } else if (isPaste(o)) {
        out.set(o.id, { key: o.id, sourceId: o.sourceId, srcIndex: o.srcIndex, ops: o.items.flatMap((i) => i.ops), dx: o.dx, dy: o.dy })
      }
    }
    return [...out.values()]
  }, [page.overlays, page.sourceId, page.srcIndex, skip])
  if (!layers.length) return null
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 2 }}>
      {layers.map((l) => (
        <OpsLayer key={l.key} layer={l} scale={scale} renderScale={renderScale} />
      ))}
    </div>
  )
}

const OpsLayer = memo(function OpsLayer({ layer, scale, renderScale }: { layer: Layer; scale: number; renderScale: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const opsKey = [...new Set(layer.ops)].sort((a, b) => a - b).join(',')
  useEffect(() => {
    let task: RenderTask | null = null
    let cancelled = false
    ;(async () => {
      if (!hasSource(layer.sourceId)) return
      const [pdfPage, content] = await Promise.all([getPdfPage(layer.sourceId, layer.srcIndex), getPageContent(layer.sourceId, layer.srcIndex)])
      const cv = ref.current
      if (cancelled || !cv) return
      const keep = new Set(opsKey.split(',').map(Number))
      const paint = new Set(content.paintOps)
      const viewport = pdfPage.getViewport({ scale: renderScale })
      const out = Math.min(window.devicePixelRatio || 1, 2)
      cv.width = Math.max(1, Math.floor(viewport.width * out))
      cv.height = Math.max(1, Math.floor(viewport.height * out))
      cv.style.width = `${viewport.width}px`
      cv.style.height = `${viewport.height}px`
      cv.dataset.w = String(content.width)
      // PDF.js would create an opaque context; ask for a transparent one first (the first call wins)
      cv.getContext('2d', { alpha: true })?.clearRect(0, 0, cv.width, cv.height)
      task = pdfPage.render({
        canvas: cv,
        viewport,
        transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined,
        background: 'rgba(0,0,0,0)',
        operationsFilter: (i: number) => !paint.has(i) || keep.has(i),
      })
      await task.promise.catch(() => undefined)
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [layer.sourceId, layer.srcIndex, opsKey, renderScale])
  return (
    <canvas
      ref={ref}
      data-layer
      data-dx={layer.dx}
      data-dy={layer.dy}
      className="absolute left-0 top-0 origin-top-left"
      style={{ transform: `translate(${layer.dx * scale}px, ${layer.dy * scale}px) scale(${scale / renderScale})` }}
    />
  )
})
