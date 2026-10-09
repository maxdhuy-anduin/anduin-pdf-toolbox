import { useMemo, useState } from 'react'
import { FileOutput } from 'lucide-react'
import { formatPageRange, parsePageRange } from '../lib/pageRange'
import { Button, Modal } from './ui'

export interface ExtractRequest {
  /** 0-based positions in the current page order. */
  indices: number[]
  /** One PDF per page instead of a single PDF. */
  separate: boolean
  /** Remove the extracted pages from this document afterwards. */
  deleteAfter: boolean
}

interface Props {
  pageCount: number
  /** Pages selected when the dialog opened (positions). */
  selected: number[]
  onClose: () => void
  onExtract: (r: ExtractRequest) => void
}

export function ExtractDialog({ pageCount, selected, onClose, onExtract }: Props) {
  const [mode, setMode] = useState<'selected' | 'range'>(selected.length ? 'selected' : 'range')
  const [range, setRange] = useState(selected.length ? formatPageRange(selected).replace(/–/g, '-') : `1-${pageCount}`)
  const [separate, setSeparate] = useState(false)
  const [deleteAfter, setDeleteAfter] = useState(false)

  const parsed = useMemo(() => (mode === 'range' ? parsePageRange(range, pageCount) : ({ ok: true, indices: selected } as const)), [mode, range, pageCount, selected])
  const indices = parsed.ok ? parsed.indices : []
  const deletesAll = deleteAfter && indices.length >= pageCount
  const canGo = indices.length > 0 && !deletesAll

  const radio = (value: 'selected' | 'range', label: React.ReactNode, disabled = false) => (
    <label className={`flex items-start gap-2.5 py-1.5 text-[13.5px] ${disabled ? 'text-faint' : 'text-ink'}`}>
      <input type="radio" name="extract-mode" className="mt-[3px] accent-[#141414]" checked={mode === value} disabled={disabled} onChange={() => setMode(value)} />
      <span className="flex-1">{label}</span>
    </label>
  )

  return (
    <Modal
      title="Extract pages"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canGo} onClick={() => onExtract({ indices, separate, deleteAfter })}>
            <FileOutput size={14} />
            Extract {indices.length ? `${indices.length} page${indices.length > 1 ? 's' : ''}` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          {radio('selected', <>Selected pages {selected.length ? <span className="text-muted">({formatPageRange(selected)})</span> : <span className="text-faint">(none selected)</span>}</>, !selected.length)}
          {radio(
            'range',
            <span className="flex flex-col gap-1.5">
              Page range
              <input
                aria-label="Page range"
                value={range}
                onFocus={() => setMode('range')}
                onChange={(e) => {
                  setMode('range')
                  setRange(e.target.value)
                }}
                onKeyDown={(e) => e.key === 'Enter' && canGo && onExtract({ indices, separate, deleteAfter })}
                placeholder="e.g. 1-3, 5, 8-"
                className={`h-8 w-full border bg-white px-2.5 font-mono text-[13px] text-ink focus:outline-none ${mode === 'range' && !parsed.ok ? 'border-coral' : 'border-line focus:border-ink'}`}
              />
              <span className={`text-[12px] ${mode === 'range' && !parsed.ok ? 'text-coral' : 'text-muted'}`}>
                {mode === 'range' && !parsed.ok ? parsed.error : `Of ${pageCount} pages. Examples: 1-3, 5 · 8- · odd · even · last`}
              </span>
            </span>,
          )}
        </div>
        <div className="space-y-2 border-t border-line pt-3">
          <label className="flex items-start gap-2.5 text-[13.5px] text-ink">
            <input type="checkbox" className="mt-[3px] accent-[#141414]" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
            <span>
              Extract as separate files
              <span className="block text-[12px] text-muted">One PDF per page. Your browser may ask to allow multiple downloads.</span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 text-[13.5px] text-ink">
            <input type="checkbox" className="mt-[3px] accent-[#141414]" checked={deleteAfter} onChange={(e) => setDeleteAfter(e.target.checked)} />
            <span>
              Delete pages after extracting
              <span className={`block text-[12px] ${deletesAll ? 'text-coral' : 'text-muted'}`}>
                {deletesAll ? 'A PDF needs at least one page: you can’t remove every page.' : 'Removed from this document; undo brings them back.'}
              </span>
            </span>
          </label>
        </div>
        <p className="text-[12px] text-muted">Edits on the extracted pages are included. Processing happens in your browser.</p>
      </div>
    </Modal>
  )
}
