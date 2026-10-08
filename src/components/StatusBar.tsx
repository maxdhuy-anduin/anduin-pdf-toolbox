import { ShieldCheck } from 'lucide-react'
import { useApp } from '../context'
import { formatBytes } from '../lib/download'

export const PRIVACY_NOTE = 'PDF processing occurs locally in your browser whenever supported. Documents are not intentionally stored by this tool.'

export function StatusBar({ targetIds }: { targetIds: string[] }) {
  const { state, currentIndex, debug } = useApp()
  const n = state.pages.length
  const size = Object.values(state.sources)[0]?.size
  const targetLabel = state.selection.length ? `${state.selection.length} page${state.selection.length > 1 ? 's' : ''} selected` : n ? `page ${currentIndex + 1}` : ''
  void targetIds
  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-line bg-white px-4 font-mono text-[10.5px] uppercase tracking-[0.04em] text-muted">
      <span className="flex min-w-0 items-center gap-1.5 normal-case tracking-normal">
        <ShieldCheck size={13} className="shrink-0 text-sky-deep" />
        <span className="truncate font-sans text-[11.5px]">{PRIVACY_NOTE}</span>
      </span>
      {n > 0 && (
        <span className="ml-auto flex shrink-0 items-center gap-4 tabular-nums">
          {debug && <span className="bg-ink px-1.5 py-[1px] text-white">Debug view</span>}
          <span>
            Actions → <span className="text-ink">{targetLabel}</span>
          </span>
          <span>
            {n} pages{size ? ` · ${formatBytes(size)}` : ''}
          </span>
        </span>
      )}
    </footer>
  )
}
