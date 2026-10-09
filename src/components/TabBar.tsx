import { FileText, Plus, X } from 'lucide-react'
import { useEffect, useRef } from 'react'

export interface TabItem {
  id: string
  name: string
  dirty: boolean
  empty: boolean
}

/**
 * Open documents, one tab each. Click to switch, the × (or middle-click) closes; + opens an empty
 * tab. PDFs dropped on the bar open in new tabs (handled by the App's drop handler: `data-tabbar`).
 */
export function TabBar({ tabs, active, onActivate, onClose, onNew, disabled }: {
  tabs: TabItem[]
  active: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  disabled?: boolean
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${active}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active, tabs.length])
  return (
    <div data-tabbar className="flex h-9 shrink-0 items-stretch border-b border-line bg-wash">
      <div ref={listRef} role="tablist" aria-label="Open documents" className="flex min-w-0 items-stretch overflow-x-auto">
        {tabs.map((t) => {
          const on = t.id === active
          return (
            <div
              key={t.id}
              data-tab-id={t.id}
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              title={t.name}
              onClick={() => !disabled && onActivate(t.id)}
              onAuxClick={(e) => e.button === 1 && !disabled && onClose(t.id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && onActivate(t.id)}
              className={`group relative flex w-[200px] min-w-[120px] shrink cursor-pointer items-center gap-2 border-r border-line pl-3 pr-1.5 text-[12.5px] ${
                on ? 'bg-white font-medium text-ink' : 'text-ink-soft hover:bg-ink/5 hover:text-ink'
              }`}
            >
              {on && <span className="absolute inset-x-0 top-0 h-[2px] bg-sky-deep" aria-hidden />}
              <FileText size={13} className={`shrink-0 ${on ? 'text-sky-deep' : 'text-muted'}`} />
              <span className={`min-w-0 flex-1 truncate ${t.empty ? 'italic text-muted' : ''}`}>{t.name}</span>
              {t.dirty && <span className="h-1.5 w-1.5 shrink-0 bg-coral" title="Unsaved changes" aria-label="Unsaved changes" />}
              <button
                type="button"
                aria-label={`Close ${t.name}`}
                title="Close tab"
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.id)
                }}
                className={`flex h-5 w-5 shrink-0 items-center justify-center text-muted hover:bg-ink/10 hover:text-ink ${on ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
              >
                <X size={13} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        type="button"
        aria-label="New tab"
        title="New tab (open another PDF)"
        disabled={disabled}
        onClick={onNew}
        className="flex w-9 shrink-0 items-center justify-center text-ink-soft hover:bg-ink/5 hover:text-ink disabled:opacity-40"
      >
        <Plus size={15} />
      </button>
    </div>
  )
}
