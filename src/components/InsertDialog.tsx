import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, FilePlus2, Loader2, Sparkles, Upload, X } from 'lucide-react'
import { formatBytes } from '../lib/download'
import type { SourceMeta } from '../lib/model'
import { openPdfBytes, openPdfFile, PdfError, releaseSource } from '../lib/pdfjs'
import { createSampleSupplement, SAMPLE_SUPPLEMENT_NAME } from '../lib/samples'
import { PageThumb } from './ThumbnailPanel'
import { Button, Modal } from './ui'

interface Item {
  source: SourceMeta
  selected: Set<number>
}

export interface InsertRequest {
  entries: { source: SourceMeta; pageIndexes: number[] }[]
  /** Index in the current document at which the pages are inserted. */
  at: number
}

interface Props {
  initialFiles: File[]
  pageCount: number
  currentIndex: number
  onClose: () => void
  onInsert: (req: InsertRequest) => void
}

export function InsertDialog({ initialFiles, pageCount, currentIndex, onClose, onInsert }: Props) {
  const [items, setItems] = useState<Item[]>([])
  const [loading, setLoading] = useState(0)
  const [errors, setErrors] = useState<string[]>([])
  const [at, setAt] = useState(Math.min(pageCount, currentIndex + 1))
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const committed = useRef(false)
  const itemsRef = useRef<Item[]>([])
  itemsRef.current = items

  const addMeta = useCallback((source: SourceMeta) => {
    setItems((prev) => [...prev, { source, selected: new Set(Array.from({ length: source.numPages }, (_, i) => i)) }])
  }, [])

  const loadFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
          setErrors((e) => [...e, `${f.name}: not a PDF file.`])
          continue
        }
        setLoading((n) => n + 1)
        try {
          addMeta(await openPdfFile(f))
        } catch (err) {
          setErrors((e) => [...e, `${f.name}: ${err instanceof PdfError ? err.message : 'could not be opened.'}`])
        } finally {
          setLoading((n) => n - 1)
        }
      }
    },
    [addMeta],
  )

  const loadSample = async () => {
    setLoading((n) => n + 1)
    try {
      addMeta(await openPdfBytes(SAMPLE_SUPPLEMENT_NAME, await createSampleSupplement()))
    } finally {
      setLoading((n) => n - 1)
    }
  }

  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (initialFiles.length) void loadFiles(initialFiles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // anything that was opened but not inserted must be released
  useEffect(
    () => () => {
      if (!committed.current) itemsRef.current.forEach((i) => releaseSource(i.source.id))
    },
    [],
  )

  const toggle = (sid: string, idx: number) =>
    setItems((prev) =>
      prev.map((it) => {
        if (it.source.id !== sid) return it
        const s = new Set(it.selected)
        if (s.has(idx)) s.delete(idx)
        else s.add(idx)
        return { ...it, selected: s }
      }),
    )
  const setAll = (sid: string, all: boolean) =>
    setItems((prev) => prev.map((it) => (it.source.id === sid ? { ...it, selected: new Set(all ? Array.from({ length: it.source.numPages }, (_, i) => i) : []) } : it)))
  const remove = (sid: string) => {
    releaseSource(sid)
    setItems((prev) => prev.filter((it) => it.source.id !== sid))
  }

  const total = items.reduce((n, it) => n + it.selected.size, 0)

  const confirm = () => {
    const used = items.filter((it) => it.selected.size > 0)
    items.filter((it) => it.selected.size === 0).forEach((it) => releaseSource(it.source.id))
    committed.current = true
    onInsert({ entries: used.map((it) => ({ source: it.source, pageIndexes: [...it.selected].sort((a, b) => a - b) })), at })
  }

  return (
    <Modal
      title="Insert pages from another PDF"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mr-auto text-[12.5px] text-muted">{total ? `${total} page${total > 1 ? 's' : ''} will be inserted` : 'Choose at least one page'}</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!total} onClick={confirm}>
            <Check size={15} />
            Insert {total || ''} page{total === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          void loadFiles([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setOver(true)
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOver(false)
          void loadFiles([...e.dataTransfer.files])
        }}
        className={`mb-4 flex flex-wrap items-center gap-2 border border-dashed px-4 py-3 ${over ? 'border-sky bg-sky-soft' : 'border-line bg-wash'}`}
      >
        <Upload size={16} className="text-faint" />
        <span className="text-[13px] text-ink-soft">Drop PDFs here, or</span>
        <Button size="sm" onClick={() => inputRef.current?.click()}>
          <FilePlus2 size={14} />
          Choose PDFs…
        </Button>
        <Button size="sm" onClick={() => void loadSample()}>
          <Sparkles size={14} />
          Use sample supplement
        </Button>
        {loading > 0 && (
          <span className="ml-auto flex items-center gap-1.5 text-[12.5px] text-muted">
            <Loader2 size={14} className="animate-spin" /> Reading…
          </span>
        )}
      </div>

      {errors.map((e, i) => (
        <div key={i} role="alert" className="mb-2 flex items-start gap-2 bg-coral-soft px-3 py-2 text-[12.5px] text-ink ring-1 ring-coral/40">
          <AlertTriangle size={15} className="mt-px shrink-0" />
          <span className="flex-1">{e}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setErrors((x) => x.filter((_, k) => k !== i))}>
            <X size={14} />
          </button>
        </div>
      ))}

      {items.length === 0 && loading === 0 && <p className="py-8 text-center text-sm text-faint">No PDF chosen yet. Pages from the PDFs you add will appear here.</p>}

      <div className="space-y-5">
        {items.map((it) => (
          <section key={it.source.id}>
            <div className="mb-2 flex items-center gap-2 text-[13px]">
              <span className="truncate font-medium text-ink" title={it.source.name}>
                {it.source.name}
              </span>
              <span className="shrink-0 text-faint">
                {it.source.numPages} pages · {formatBytes(it.source.size)}
              </span>
              <span className="ml-auto flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" onClick={() => setAll(it.source.id, true)}>
                  Select all
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAll(it.source.id, false)}>
                  None
                </Button>
                <Button variant="ghost" size="sm" onClick={() => remove(it.source.id)} aria-label={`Remove ${it.source.name}`}>
                  <X size={14} />
                </Button>
              </span>
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-3 bg-canvas p-3">
              {it.source.pages.map((info, idx) => {
                const on = it.selected.has(idx)
                return (
                  <button
                    key={idx}
                    type="button"
                    aria-pressed={on}
                    aria-label={`${it.source.name} page ${idx + 1}`}
                    onClick={() => toggle(it.source.id, idx)}
                    className={`relative p-1.5 text-center transition-colors ${on ? 'bg-sky-soft ring-2 ring-sky-deep' : 'opacity-60 hover:opacity-100'}`}
                  >
                    <div className="flex justify-center">
                      <PageThumb sourceId={it.source.id} srcIndex={idx} info={info} width={88} />
                    </div>
                    <span className="mt-1 block text-[11px] font-medium text-ink-soft">{idx + 1}</span>
                    {on && (
                      <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center bg-sky-deep text-white">
                        <Check size={11} strokeWidth={3} />
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-2 border-t border-line pt-4 text-[13px]">
        <label htmlFor="insert-at" className="font-medium text-ink-soft">
          Insert position
        </label>
        <select id="insert-at" className="h-8 border border-line bg-white px-2" value={at} onChange={(e) => setAt(parseInt(e.target.value, 10))}>
          <option value={0}>At the beginning (before page 1)</option>
          {Array.from({ length: pageCount }, (_, i) => (
            <option key={i} value={i + 1}>
              {i + 1 === pageCount ? `At the end (after page ${i + 1})` : `After page ${i + 1}`}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  )
}
