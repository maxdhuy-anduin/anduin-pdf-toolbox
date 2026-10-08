import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, ChevronRight, Italic, Minus, PencilLine, Plus, RotateCcw, Trash2, Underline } from 'lucide-react'
import { useApp } from '../context'
import { unsupportedChars } from '../lib/fonts'
import { FONT_LABELS, isGraphic, type FontFamily, type GraphicOverlay, type OverlayPatch, type TextOverlay } from '../lib/model'
import { getCachedContent } from '../lib/content/cache'
import { describeObject, isGraphicObject, isTextObject, OBJECT_LABEL } from '../lib/content/edits'
import type { ContentObject, PageContent } from '../lib/content/types'
import { Button, Eyebrow } from './ui'
import { usePageContent } from './PageOverlays'

const SWATCHES = ['#141414', '#162950', '#1075dc', '#c2412a', '#15803d', '#858585']

function Seg({ active, onClick, label, children }: { active?: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center border transition-colors ${active ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink-soft hover:border-ink hover:text-ink'}`}
    >
      {children}
    </button>
  )
}

const Label = ({ children }: { children: React.ReactNode }) => <span className="mb-1.5 block font-mono text-[10.5px] uppercase tracking-[0.06em] text-muted">{children}</span>
const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-3 border-b border-line-soft py-1.5 text-[12.5px] last:border-0">
    <span className="text-muted">{k}</span>
    <span className="truncate text-right text-ink">{v}</span>
  </div>
)

export function PropertiesPanel() {
  const { state, currentIndex, selectedObject } = useApp()
  const sel = state.selectedOverlay
  const page = sel ? state.pages.find((p) => p.id === sel.pageId) : undefined
  const overlay = page?.overlays.find((o) => o.id === sel?.overlayId) ?? (state.draft && state.draft.overlay.id === sel?.overlayId ? state.draft.overlay : undefined)
  const isDraft = !!overlay && !page?.overlays.some((o) => o.id === overlay.id)
  const objPage = selectedObject ? state.pages.find((p) => p.id === selectedObject.pageId) : undefined
  const objContent = objPage ? getCachedContent(objPage.sourceId, objPage.srcIndex) : undefined
  const obj = selectedObject && objContent ? objContent.objects[selectedObject.objectId] : undefined

  let title = 'Properties'
  let body: React.ReactNode
  if (overlay && page && isGraphic(overlay)) {
    title = OBJECT_LABEL[overlay.source.objType] ?? 'Graphic'
    body = <GraphicProps overlay={overlay} pageId={page.id} />
  } else if (overlay && page && !isGraphic(overlay)) {
    title = overlay.source ? 'Edited text' : 'Text box'
    body = <TextProps overlay={overlay} pageId={page.id} isDraft={isDraft} />
  } else if (obj && objContent && objPage) {
    title = describeObject(obj)
    body = <ObjectProps o={obj} content={objContent} pageId={objPage.id} />
  } else body = <Overview currentIndex={currentIndex} />

  return (
    <aside
      data-keep-selection
      className="flex w-[272px] shrink-0 flex-col border-l border-line bg-white"
      aria-label="Properties"
      onMouseDown={(e) => {
        const t = e.target as HTMLElement
        if (!t.closest('input, select, textarea')) e.preventDefault()
      }}
    >
      <div className="flex h-10 shrink-0 items-center border-b border-line px-4">
        <Eyebrow sky>{title}</Eyebrow>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto">{body}</div>
    </aside>
  )
}

// ---------------------------------------------------------------------------------------

function ObjectProps({ o, content, pageId }: { o: ContentObject; content: PageContent; pageId: string }) {
  const { setSelectedObject, requestEdit } = useApp()
  const crumbs: ContentObject[] = []
  for (let p = o.parent ? content.objects[o.parent] : undefined; p; p = p.parent ? content.objects[p.parent] : undefined) crumbs.unshift(p)
  const del = () => window.dispatchEvent(new CustomEvent('toolbox:delete-object', { detail: { pageId, objectId: o.id } }))
  return (
    <div className="space-y-4 p-4">
      {crumbs.length > 0 && (
        <nav className="flex flex-wrap items-center gap-1 text-[12px]" aria-label="Structure">
          {crumbs
            .filter((c) => c.type !== 'TABLE_ROW')
            .map((c) => (
              <span key={c.id} className="flex items-center gap-1">
                <button type="button" className="text-sky-deep underline-offset-2 hover:underline" onClick={() => setSelectedObject({ pageId, objectId: c.id })}>
                  {describeObject(c)}
                </button>
                <ChevronRight size={12} className="text-faint" />
              </span>
            ))}
          <span className="text-ink">{describeObject(o)}</span>
        </nav>
      )}
      {o.text !== undefined && (
        <div className="max-h-40 overflow-y-auto border border-line-soft bg-wash p-2.5 text-[12.5px] leading-snug text-ink-soft whitespace-pre-wrap">{o.text || <em className="text-faint">Empty cell</em>}</div>
      )}
      <div>
        {o.style && (
          <>
            <Row k="Font" v={`${o.style.fontName.replace(/^[A-Z]{6}\+/, '')}`} />
            <Row k="Size" v={`${o.style.fontSize} pt`} />
            <Row k="Style" v={[o.style.bold && 'Bold', o.style.italic && 'Italic'].filter(Boolean).join(' · ') || 'Regular'} />
            <Row k="Colour" v={<span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 border border-line" style={{ background: o.style.color ?? '#000' }} />{o.style.color ?? 'unknown'}</span>} />
            <Row k="Alignment" v={o.style.align} />
            {o.children.length > 1 && <Row k="Lines" v={`${o.children.length} · spacing ${o.style.lineHeight}`} />}
          </>
        )}
        {o.type === 'TABLE' && (
          <>
            <Row k="Size" v={`${o.rows} rows × ${o.cols} columns`} />
            <Row k="Detected from" v={o.tableKind === 'lattice' ? 'Ruled grid' : o.tableKind === 'rules' ? 'Row rules + alignment' : 'Column alignment'} />
          </>
        )}
        {o.type === 'LINE' && (
          <>
            <Row k="Thickness" v={`${o.thickness?.toFixed(2)} pt`} />
            <Row k="Colour" v={o.strokeColor ?? '—'} />
          </>
        )}
        {o.type === 'RECTANGLE' && (
          <>
            <Row k="Fill" v={o.fillColor ?? 'none'} />
            <Row k="Border" v={o.strokeColor ?? 'none'} />
          </>
        )}
        <Row k="Position" v={`${o.bounds.x.toFixed(0)}, ${o.bounds.y.toFixed(0)} · ${o.bounds.w.toFixed(0)}×${o.bounds.h.toFixed(0)} pt`} />
      </div>
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        {isTextObject(o) && (
          <Button variant="primary" onClick={() => requestEdit(pageId, o.id)}>
            <PencilLine size={14} />
            {o.text ? 'Edit text' : 'Add text to cell'}
            <span className="ml-auto font-mono text-[10px] text-white/60">ENTER</span>
          </Button>
        )}
        {o.type === 'TABLE' && <p className="text-[12.5px] text-muted">Click a cell to select it, double-click to edit its text.</p>}
        {(isTextObject(o) && o.text) || isGraphicObject(o) ? (
          <Button variant="danger" onClick={del}>
            <Trash2 size={14} />
            Delete {isGraphicObject(o) ? OBJECT_LABEL[o.type].toLowerCase() : 'text'}
            <span className="ml-auto font-mono text-[10px] text-muted">DEL</span>
          </Button>
        ) : null}
        <p className="text-[12px] leading-snug text-muted">Drag to move{o.type !== 'TABLE' ? ', or use the handles to resize' : ''}.</p>
      </div>
    </div>
  )
}

function TextProps({ overlay: o, pageId, isDraft }: { overlay: TextOverlay; pageId: string; isDraft: boolean }) {
  const { dispatch, setTool } = useApp()
  const set = (patch: OverlayPatch, prop: string) => dispatch({ type: 'updateOverlay', pageId, overlayId: o.id, patch, coalesce: `fmt:${o.id}:${prop}` })
  const bad = unsupportedChars(o.text)
  const lh = o.lineHeight ?? 1.2
  const remove = () => {
    if (isDraft) dispatch({ type: 'discardDraft' })
    else if (o.source || o.cover) {
      dispatch({ type: 'updateOverlay', pageId, overlayId: o.id, patch: { text: '' } })
      dispatch({ type: 'selectOverlay', sel: null })
    } else dispatch({ type: 'removeOverlay', pageId, overlayId: o.id })
  }

  return (
    <div className="space-y-4 p-4 text-[13px]">
      {o.source && (
        <p className="border-l-2 border-sky bg-sky-soft px-3 py-2 text-[12px] leading-snug text-ink-soft">
          Replacing a detected <strong className="font-semibold text-ink">{OBJECT_LABEL[o.source.objType]?.toLowerCase() ?? 'object'}</strong>. Formatting is matched as closely as the standard PDF fonts allow; on export the original is removed from the page content{o.source.exclusive ? '' : ' where possible (otherwise covered)'}.
        </p>
      )}
      <label className="block">
        <Label>Font</Label>
        <select className="h-8 w-full border border-line bg-white px-2 focus:border-ink focus:outline-none" value={o.fontFamily} onChange={(e) => set({ fontFamily: e.target.value as FontFamily }, 'font')}>
          {(Object.keys(FONT_LABELS) as FontFamily[]).map((f) => (
            <option key={f} value={f}>
              {FONT_LABELS[f]}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Size</Label>
          <div className="flex items-center">
            <Seg label="Decrease size" onClick={() => set({ fontSize: Math.max(4, Math.round((o.fontSize - 1) * 10) / 10) }, 'size')}>
              <Minus size={13} />
            </Seg>
            <input
              aria-label="Font size"
              type="number"
              min={4}
              max={200}
              step={0.5}
              className="h-8 w-full min-w-0 border-y border-line px-1 text-center tabular-nums focus:outline-none"
              value={o.fontSize}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (v >= 4 && v <= 200) set({ fontSize: v }, 'size')
              }}
            />
            <Seg label="Increase size" onClick={() => set({ fontSize: Math.min(200, Math.round((o.fontSize + 1) * 10) / 10) }, 'size')}>
              <Plus size={13} />
            </Seg>
          </div>
        </div>
        <div>
          <Label>Line spacing</Label>
          <select
            aria-label="Line spacing"
            className="h-8 w-full border border-line bg-white px-2 tabular-nums focus:border-ink focus:outline-none"
            value={[1, 1.15, 1.2, 1.4, 1.5, 2].includes(lh) ? lh : 'custom'}
            onChange={(e) => e.target.value !== 'custom' && set({ lineHeight: parseFloat(e.target.value) }, 'lh')}
          >
            {![1, 1.15, 1.2, 1.4, 1.5, 2].includes(lh) && <option value="custom">{lh.toFixed(2)}</option>}
            {[1, 1.15, 1.2, 1.4, 1.5, 2].map((v) => (
              <option key={v} value={v}>
                {v.toFixed(2)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Label>Style &amp; alignment</Label>
        <div className="flex flex-wrap items-center gap-1">
          <Seg label="Bold" active={o.bold} onClick={() => set({ bold: !o.bold }, 'bold')}>
            <Bold size={15} />
          </Seg>
          <Seg label="Italic" active={o.italic} onClick={() => set({ italic: !o.italic }, 'italic')}>
            <Italic size={15} />
          </Seg>
          <Seg label="Underline" active={!!o.underline} onClick={() => set({ underline: !o.underline }, 'underline')}>
            <Underline size={15} />
          </Seg>
          <span className="mx-1 h-5 w-px bg-line" />
          {(['left', 'center', 'right', 'justify'] as const).map((a) => (
            <Seg key={a} label={`Align ${a}`} active={o.align === a} onClick={() => set({ align: a, ...(a === 'justify' ? { wrap: true } : {}) }, 'align')}>
              {a === 'left' ? <AlignLeft size={15} /> : a === 'center' ? <AlignCenter size={15} /> : a === 'right' ? <AlignRight size={15} /> : <AlignJustify size={15} />}
            </Seg>
          ))}
        </div>
      </div>

      <ColorField label="Colour" value={o.color} onChange={(c) => set({ color: c }, 'color')} />

      {bad.length > 0 && (
        <p className="border-l-2 border-coral bg-coral-soft px-3 py-2 text-[12px] leading-snug text-ink-soft">
          The standard PDF fonts cannot draw {bad.slice(0, 6).map((c) => `“${c}”`).join(' ')}
          {bad.length > 6 ? '…' : ''}. These will be exported as “?”.
        </p>
      )}

      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <Button variant="danger" onClick={remove}>
          <Trash2 size={14} />
          {o.source || o.cover ? 'Delete text' : 'Delete text box'}
        </Button>
        {(o.source || o.cover) && !isDraft && (
          <Button
            onClick={() => {
              dispatch({ type: 'removeOverlay', pageId, overlayId: o.id })
              setTool('edit')
            }}
          >
            <RotateCcw size={14} />
            Restore original
          </Button>
        )}
      </div>
    </div>
  )
}

function GraphicProps({ overlay: o, pageId }: { overlay: GraphicOverlay; pageId: string }) {
  const { dispatch } = useApp()
  const set = (patch: OverlayPatch, prop: string) => dispatch({ type: 'updateOverlay', pageId, overlayId: o.id, patch, coalesce: `fmt:${o.id}:${prop}` })
  return (
    <div className="space-y-4 p-4 text-[13px]">
      {o.kind === 'line' && (
        <>
          <ColorField label="Colour" value={o.strokeColor ?? '#000000'} onChange={(c) => set({ strokeColor: c }, 'stroke')} />
          <label className="block">
            <Label>Thickness (pt)</Label>
            <input
              type="number"
              min={0.25}
              max={20}
              step={0.25}
              value={o.thickness}
              onChange={(e) => {
                const t = parseFloat(e.target.value)
                if (t > 0) set(o.w >= o.h ? { thickness: t, h: t, y: o.y + o.h / 2 - t / 2 } : { thickness: t, w: t, x: o.x + o.w / 2 - t / 2 }, 'thick')
              }}
              className="h-8 w-24 border border-line px-2 tabular-nums focus:border-ink focus:outline-none"
            />
          </label>
        </>
      )}
      {o.kind === 'rect' && (
        <>
          {o.fillColor && <ColorField label="Fill" value={o.fillColor} onChange={(c) => set({ fillColor: c }, 'fill')} />}
          {o.strokeColor && <ColorField label="Border" value={o.strokeColor} onChange={(c) => set({ strokeColor: c }, 'stroke')} />}
        </>
      )}
      {o.kind === 'image' && <p className="text-[12.5px] text-muted">Drag to move. Use the corner handles to resize.</p>}
      <Row k="Position" v={`${o.x.toFixed(0)}, ${o.y.toFixed(0)} · ${o.w.toFixed(0)}×${o.h.toFixed(0)} pt`} />
      <div className="flex flex-col gap-2 border-t border-line pt-4">
        <Button
          variant="danger"
          onClick={() => {
            set({ deleted: true }, 'del')
            dispatch({ type: 'selectOverlay', sel: null })
          }}
        >
          <Trash2 size={14} />
          Delete {o.kind === 'rect' ? 'rectangle' : o.kind}
        </Button>
        <Button onClick={() => dispatch({ type: 'removeOverlay', pageId, overlayId: o.id })}>
          <RotateCcw size={14} />
          Restore original
        </Button>
      </div>
    </div>
  )
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-1.5">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`${label} ${c}`}
            onClick={() => onChange(c)}
            className={`h-6 w-6 border ${value.toLowerCase() === c ? 'outline-2 outline-offset-1 outline-sky-deep' : 'border-line'}`}
            style={{ background: c }}
          />
        ))}
        <input aria-label={`Custom ${label.toLowerCase()}`} type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-6 w-8 cursor-pointer border border-line bg-white p-0" />
        <span className="ml-1 font-mono text-[11px] text-muted">{value}</span>
      </div>
    </div>
  )
}

const LEGEND: [string, string][] = [
  ['Text block', '#2563eb'],
  ['Text line', '#16a34a'],
  ['Table', '#9333ea'],
  ['Table cell', '#eab308'],
  ['Line / rule', '#dc2626'],
  ['Rectangle', '#0891b2'],
  ['Image', '#ea580c'],
]

function Overview({ currentIndex }: { currentIndex: number }) {
  const { state, tool, debug } = useApp()
  const page = state.pages[currentIndex]
  const src = page ? state.sources[page.sourceId] : undefined
  const content = usePageContent(page?.sourceId ?? '', page?.srcIndex ?? 0, !!page && !src?.likelyScanned)
  const s = content?.stats
  return (
    <div className="space-y-5 p-4 text-[13px] leading-relaxed text-ink-soft">
      {s && (
        <div>
          <Label>Page {currentIndex + 1} · detected content</Label>
          <div className="grid grid-cols-3 border border-line">
            {[
              ['Blocks', s.blocks],
              ['Tables', s.tables],
              ['Lines', s.rules],
              ['Shapes', s.rects],
              ['Images', s.images],
              ['Type', content.kind === 'digital' ? 'Digital' : content.kind === 'scanned' ? 'Scanned' : 'Empty'],
            ].map(([k, v], i) => (
              <div key={k as string} className={`px-2.5 py-2 ${i % 3 !== 2 ? 'border-r' : ''} ${i < 3 ? 'border-b' : ''} border-line`}>
                <div className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-muted">{k}</div>
                <div className="tight text-[17px] font-semibold text-ink">{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {debug && (
        <div>
          <Label>Detected objects legend</Label>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {LEGEND.map(([k, c]) => (
              <span key={k} className="flex items-center gap-2 text-[12px]">
                <span className="h-2.5 w-2.5 border-2" style={{ borderColor: c }} />
                {k}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[12px] text-muted">Hover the page to inspect an object. Toggle with ⇧⌘D.</p>
        </div>
      )}
      <div>
        <Label>{tool === 'edit' ? 'Edit mode' : 'Editing content'}</Label>
        <ul className="space-y-1.5">
          <li>
            <strong className="font-semibold text-ink">Edit (E)</strong>: hover to see paragraphs, headings, tables, cells, lines and images as objects. Click to select; double-click or Enter to edit text.
          </li>
          <li>Drag a selected object to move it; use the handles to resize; Delete removes it.</li>
          <li>
            <strong className="font-semibold text-ink">Add Text (T)</strong>: click anywhere to place a new text box.
          </li>
        </ul>
      </div>
      <div>
        <Label>Organising pages</Label>
        <ul className="space-y-1.5">
          <li>Drag thumbnails to reorder. Shift/Ctrl-click to select several.</li>
          <li>Delete, duplicate, rotate and extract act on the selected pages, or the current page.</li>
        </ul>
      </div>
      {src?.likelyScanned && (
        <p className="border-l-2 border-coral bg-coral-soft px-3 py-2 text-[12px] text-ink-soft">This page is image-based. Page operations and Add Text work; content editing does not.</p>
      )}
    </div>
  )
}
