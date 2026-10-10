import { ArrowUpRight, FolderOpen, Redo2, Undo2 } from 'lucide-react'
import { isDirty } from '../lib/model'
import { useApp } from '../context'
import { Button } from './ui'

/** The Anduin mark (transparent PNG, 5:4), served from public/brand. */
/** The Anduin mark (vector: stays sharp at any size; 5:4). */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 960 768" width={size * 1.25} height={size} aria-hidden className="block shrink-0" style={{ width: size * 1.25, height: size }}>
      <path fill="#1AB3EC" fillRule="evenodd" d="M480 0 960 768H767L672 614 576 768H384L288 614 192 768H0ZM480 302 389.5 456 480 604 570.5 456Z" />
    </svg>
  )
}

export function Header({ onOpen, onExport, exporting }: { onOpen: () => void; onExport: () => void; exporting: boolean }) {
  const { state, dispatch } = useApp()
  const hasDoc = state.pages.length > 0
  const dirty = isDirty(state)
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 bg-ink px-4 text-white">
      <div className="flex items-center gap-2.5">
        <Logo />
        <span className="tight text-[17px] font-semibold">Anduin</span>
        <span className="h-4 w-px bg-white/25" />
        <span className="font-mono text-[11.5px] uppercase tracking-[0.08em] text-white/70">PDF Toolbox</span>
      </div>
      {hasDoc && (
        <div className="ml-2 flex min-w-0 items-center gap-3 border-l border-white/15 pl-4">
          <span className="truncate text-[13px] font-medium text-white/90" title={state.fileName ?? ''}>
            {state.fileName}
          </span>
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 border px-1.5 py-[2px] font-mono text-[10px] uppercase tracking-[0.06em] ${
              dirty ? 'border-coral/60 text-[#ff9b84]' : 'border-white/20 text-white/55'
            }`}
          >
            <span className={`h-1.5 w-1.5 ${dirty ? 'bg-coral' : 'bg-white/45'}`} />
            {dirty ? 'Unsaved changes' : 'No changes'}
          </span>
        </div>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {hasDoc && (
          <>
            <Button variant="inverse-ghost" size="sm" title="Undo (Ctrl/Cmd+Z)" aria-label="Undo" disabled={!state.past.length} onClick={() => dispatch({ type: 'undo' })}>
              <Undo2 size={15} />
            </Button>
            <Button variant="inverse-ghost" size="sm" title="Redo (Ctrl/Cmd+Shift+Z)" aria-label="Redo" disabled={!state.future.length} onClick={() => dispatch({ type: 'redo' })}>
              <Redo2 size={15} />
            </Button>
            <span className="mx-1 h-5 w-px bg-white/15" />
          </>
        )}
        <button
          type="button"
          onClick={onOpen}
          title="Open a PDF (Ctrl/Cmd+O)"
          className="inline-flex h-8 items-center gap-1.5 border border-white/30 px-3 text-[13px] font-medium text-white/90 transition-colors hover:border-white hover:text-white"
        >
          <FolderOpen size={15} />
          Open
        </button>
        {hasDoc && (
          <button
            type="button"
            onClick={onExport}
            disabled={exporting}
            title="Export the edited PDF (Ctrl/Cmd+S)"
            className="group inline-flex h-8 items-center gap-3 bg-white pl-3 pr-[3px] text-[13px] font-medium text-ink transition-colors hover:bg-[#ececec] disabled:opacity-50"
          >
            Export PDF
            <span className="flex h-[26px] w-[26px] items-center justify-center bg-ink text-white">
              <ArrowUpRight size={14} className="transition-transform group-hover:-translate-y-px group-hover:translate-x-px" />
            </span>
          </button>
        )}
      </div>
    </header>
  )
}
