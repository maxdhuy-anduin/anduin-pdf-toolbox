import { ChevronDown, ChevronUp, Copy, Crop, Ellipsis, FileOutput, FilePlus2, LayoutGrid, MousePointer2, PencilLine, RotateCcw, RotateCw, Ruler, ScanLine, Search, Slash, SquareDashed, Superscript, Trash2, Type, ZoomIn, ZoomOut } from 'lucide-react'
import { useApp, type Tool } from '../context'
import { clamp } from '../lib/geom'
import { OPEN_SHAPES, type ShapeKind } from '../lib/model'
import { shapeStyle } from '../lib/objects'
import { shapePath, SHAPE_LABELS } from '../lib/shapes'
import { PROVIDERS } from '../lib/layout/provider'
import { Divider, Menu, ToolBtn } from './ui'
import { MAX_ZOOM, MIN_ZOOM } from './Viewer'

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]

interface Props {
  targetIds: string[]
  onInsert: () => void
  onExtract: () => void
  onDelete: () => void
  onOpenTestSuite: () => void
  onOpenDemo: () => void
  onOrganize: () => void
  onFind: () => void
}

/** Small preview of a shape kind (icons in the picker). */
export function ShapeIcon({ kind, size = 16 }: { kind: ShapeKind; size?: number }) {
  const pad = 1.5
  const w = size - 2 * pad
  const h = kind === 'rect' || kind === 'rounded' || kind === 'arrow' ? w * 0.72 : w
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <path
        d={shapePath(kind, w, h)}
        transform={`translate(${pad} ${(size - h) / 2})`}
        fill="none"
        stroke="currentColor"
        strokeWidth={OPEN_SHAPES.has(kind) ? 1.8 : 1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Toolbar({ targetIds, onInsert, onExtract, onDelete, onOpenTestSuite, onOpenDemo, onOrganize, onFind }: Props) {
  const { state, dispatch, tool, setTool, scale, setZoom, zoom, currentIndex, scrollToPage, debug, setDebug, showBoxes, setShowBoxes, layoutProvider, setLayoutProvider, showRulers, setShowRulers } = useApp()
  const n = state.pages.length
  const scanned = state.pages[currentIndex] ? state.sources[state.pages[currentIndex].sourceId]?.likelyScanned : false
  const has = targetIds.length > 0

  const zoomBy = (dir: 1 | -1) => {
    const next = dir > 0 ? STEPS.find((s) => s > scale + 0.005) : [...STEPS].reverse().find((s) => s < scale - 0.005)
    setZoom({ mode: 'custom', value: clamp(next ?? scale, MIN_ZOOM, MAX_ZOOM) })
  }

  const toolBtn = (t: Tool, icon: React.ReactNode, label: string, text: string, key: string, disabled = false, title?: string) => (
    <ToolBtn icon={icon} label={label} text={text} title={title ?? `${label} (${key})`} active={tool === t} disabled={disabled} onClick={() => setTool(t)} />
  )

  // Tools keep a short label (wide screens); page and view actions are icons with tooltips.
  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-white px-3" role="toolbar" aria-label="Tools">
      {toolBtn('select', <MousePointer2 size={16} />, 'Select', 'Select', 'V')}
      {toolBtn('edit', <PencilLine size={16} />, 'Edit', 'Edit', 'E', !!scanned, scanned ? 'Editing is unavailable: this page appears to be scanned/image-based' : 'Edit PDF content: paragraphs, tables, lines and images (E)')}
      {toolBtn('add-text', <Type size={16} />, 'Add Text', 'Text', 'T', false, 'Add a text box: click on the page (T)')}
      {toolBtn('add-line', <Slash size={16} />, 'Add Line', 'Line', 'L', false, 'Draw a line or arrow: drag on the page, hold Shift for straight / 45° (L)')}
      <Menu
        align="left"
        trigger={(toggle) => (
          <ToolBtn icon={<ShapeIcon kind={shapeStyle.shape} />} label="Shapes" title="Add a shape: rectangle, circle, triangle, star, arrow, check mark… (S)" active={tool === 'add-shape'} onClick={toggle} />
        )}
        items={[
          { label: 'Draw a shape · Shift = square / circle', heading: true },
          ...(Object.keys(SHAPE_LABELS) as ShapeKind[]).map((k) => ({
            label: SHAPE_LABELS[k],
            icon: <ShapeIcon kind={k} size={18} />,
            checked: tool === 'add-shape' && shapeStyle.shape === k,
            onClick: () => {
              shapeStyle.shape = k
              setTool('add-shape')
            },
          })),
        ]}
      />
      {toolBtn('add-footnote', <Superscript size={16} />, 'Footnote', 'Footnote', 'N', false, 'Add a footnote: click right after a word; the note goes to the bottom of the page (N)')}
      {toolBtn('crop', <Crop size={16} />, 'Crop', 'Crop', 'C', false, 'Crop pages: drag over the area to keep (C)')}
      <Divider />
      <ToolBtn icon={<LayoutGrid size={16} />} label="Organize" onClick={onOrganize} title="Organize pages: reorder by drag and drop, extract ranges, rotate, delete" />
      <ToolBtn iconOnly icon={<FilePlus2 size={16} />} label="Insert PDF" onClick={onInsert} title="Insert pages from another PDF" />
      <ToolBtn iconOnly icon={<FileOutput size={16} />} label="Extract" onClick={onExtract} title="Extract pages (selected pages or a range) into a new PDF" />
      <ToolBtn iconOnly icon={<Copy size={16} />} label="Duplicate" disabled={!has} onClick={() => dispatch({ type: 'duplicatePages', ids: targetIds })} title="Duplicate selected pages" />
      <ToolBtn iconOnly icon={<RotateCcw size={16} />} label="Rotate Left" disabled={!has} onClick={() => dispatch({ type: 'rotatePages', ids: targetIds, delta: -90 })} title="Rotate selected pages counter-clockwise" />
      <ToolBtn iconOnly icon={<RotateCw size={16} />} label="Rotate Right" disabled={!has} onClick={() => dispatch({ type: 'rotatePages', ids: targetIds, delta: 90 })} title="Rotate selected pages clockwise" />
      <ToolBtn iconOnly icon={<Trash2 size={16} />} label="Delete" disabled={!has || targetIds.length >= n} onClick={onDelete} title="Delete selected pages (Delete)" />

      <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-3">
        <ToolBtn iconOnly icon={<ChevronUp size={16} />} label="Previous page" disabled={currentIndex <= 0} onClick={() => scrollToPage(currentIndex - 1)} />
        <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap font-mono text-[12px] text-ink-soft">
          <input
            aria-label="Current page"
            className="h-7 w-10 border border-line bg-white text-center font-mono text-[12px] tabular-nums text-ink focus:border-ink focus:outline-none"
            value={currentIndex + 1}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10)
              if (!Number.isNaN(v)) scrollToPage(clamp(v - 1, 0, n - 1))
            }}
            onFocus={(e) => e.target.select()}
          />
          <span className="tabular-nums">/ {n}</span>
        </div>
        <ToolBtn iconOnly icon={<ChevronDown size={16} />} label="Next page" disabled={currentIndex >= n - 1} onClick={() => scrollToPage(currentIndex + 1)} />
        <Divider />
        <ToolBtn iconOnly icon={<ZoomOut size={16} />} label="Zoom out" onClick={() => zoomBy(-1)} disabled={scale <= MIN_ZOOM + 0.005} />
        <span className="w-11 shrink-0 text-center font-mono text-[12px] tabular-nums text-ink-soft" aria-label="Zoom level">
          {Math.round(scale * 100)}%
        </span>
        <ToolBtn iconOnly icon={<ZoomIn size={16} />} label="Zoom in" onClick={() => zoomBy(1)} disabled={scale >= MAX_ZOOM - 0.005} />
        <ToolBtn iconOnly toggle icon={<ScanLine size={16} />} label="Fit width" title="Fit page width" active={zoom.mode === 'fit'} onClick={() => setZoom({ mode: 'fit' })} />
        <Divider />
        <ToolBtn iconOnly icon={<Search size={16} />} label="Find and replace" title="Find and replace (⌘F)" onClick={onFind} />
        <ToolBtn iconOnly toggle icon={<Ruler size={16} />} label="Rulers" title="Show rulers and page margins (R)" active={showRulers} onClick={() => setShowRulers(!showRulers)} />
        <ToolBtn iconOnly toggle icon={<SquareDashed size={16} />} label="Boxes" active={showBoxes} onClick={() => setShowBoxes(!showBoxes)} title="Show bounding boxes of detected objects (B)" />
        <Menu
          trigger={(toggle) => <ToolBtn iconOnly toggle icon={<Ellipsis size={16} />} label="More options" onClick={toggle} active={debug} />}
          items={[
            { label: 'View', heading: true },
            { label: 'Show bounding boxes', hint: 'B', checked: showBoxes, onClick: () => setShowBoxes(!showBoxes) },
            { label: 'Show detected objects', hint: '⇧⌘D', checked: debug, onClick: () => setDebug(!debug) },
            { label: 'Show rulers', hint: 'R', checked: showRulers, onClick: () => setShowRulers(!showRulers) },
            { label: 'Layout engine', heading: true },
            ...PROVIDERS.map((p) => ({
              label: p.label,
              hint: p.available() ? (p.processing === 'on-device' ? 'on-device' : 'backend') : 'not configured',
              checked: layoutProvider === p.id,
              disabled: !p.available(),
              onClick: () => setLayoutProvider(p.id),
            })),
            { label: 'Samples', heading: true },
            { label: 'Open demo document (synthetic fund)', onClick: onOpenDemo },
            { label: 'Open layout test suite', onClick: onOpenTestSuite },
          ]}
        />
      </div>
    </div>
  )
}
