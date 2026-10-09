import { useEffect, useRef } from 'react'
import type { Hit } from '../lib/search'

/** Find-bar matches in the PDF's own text (text boxes highlight their matches themselves). */
export function SearchLayer({ hits, activeId, scale }: { hits: Hit[]; activeId: string | null; scale: number }) {
  const activeRef = useRef<HTMLDivElement>(null)
  const active = hits.find((h) => h.id === activeId)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  }, [activeId, !!active])
  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 5 }} data-search-layer>
      {hits.map((h) =>
        h.rects.map((r, k) => (
          <div
            key={`${h.id}-${k}`}
            ref={h.id === activeId && k === 0 ? activeRef : undefined}
            data-hit={h.id === activeId ? 'active' : 'match'}
            style={{
              position: 'absolute',
              left: (r.x - 1) * scale,
              top: (r.y - 1) * scale,
              width: (r.w + 2) * scale,
              height: (r.h + 2) * scale,
              background: h.id === activeId ? 'rgba(255,140,0,0.42)' : 'rgba(255,204,0,0.38)',
              outline: h.id === activeId ? '1.5px solid rgba(230,110,0,0.9)' : undefined,
              mixBlendMode: 'multiply',
            }}
          />
        )),
      )}
    </div>
  )
}
