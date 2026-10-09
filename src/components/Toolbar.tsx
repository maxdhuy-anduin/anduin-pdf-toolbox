import { ChevronDown, ChevronUp, Copy, Ellipsis, FileOutput, FilePlus2, MousePointer2, PencilLine, RotateCcw, RotateCw, ScanLine, SquareDashed, Trash2, Type, ZoomIn, ZoomOut } from 'lucide-react'
import { useApp, type Tool } from '../context'
import { clamp } from '../lib/geom'
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
}

export function Toolbar({ targetIds, onInsert, onExtract, onDelete, onOpenTestSuite }: Props) {
  const { state, dispatch, tool, setTool, scale, setZoom, zoom, currentIndex, scrollToPage, debug, setDebug, showBoxes, setShowBoxes, layoutProvider, setLayoutProvider } = useApp()
  const n = state.pages.length
  const scanned = state.pages[currentIndex] ? state.sources[state.pages[currentIndex].sourceId]?.likelyScanned : false
  const has = targetIds.length > 0

  const zoomBy = (dir: 1 | -1) => {
    const next = dir > 0 ? STEPS.find((s) => s > scale + 0.005) : [...STEPS].reverse().find((s) => s < scale - 0.005)
    setZoom({ mode: 'custom', value: clamp(next ?? scale, MIN_ZOOM, MAX_ZOOM) })
  }

  const toolBtn = (t: Tool, icon: React.ReactNode, label: string, key: string, disabled = false, title?: string) => (
    <ToolBtn icon={icon} label={label} title={title ?? `${label} (${key})`} active={tool === t} disabled={disabled} onClick={() => setTool(t)} />
  )

  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-white px-3" role="toolbar" aria-label="Tools">
      {toolBtn('select', <MousePointer2 size={16} />, 'Select', 'V')}
      {toolBtn('edit', <PencilLine size={16} />, 'Edit', 'E', !!scanned, scanned ? 'Editing is unavailable: this page appears to be scanned/image-based' : 'Edit PDF content: paragraphs, tables, lines and images (E)')}
      {toolBtn('add-text', <Type size={16} />, 'Add Text', 'T')}
      <Divider />
      <ToolBtn icon={<FilePlus2 size={16} />} label="Insert PDF" onClick={onInsert} title="Insert pages from another PDF" />
      <ToolBtn icon={<Copy size={16} />} label="Duplicate" disabled={!has} onClick={() => dispatch({ type: 'duplicatePages', ids: targetIds })} title="Duplicate selected pages" />
      <ToolBtn icon={<Trash2 size={16} />} label="Delete" disabled={!has || targetIds.length >= n} onClick={onDelete} title="Delete selected pages (Delete)" />
      <ToolBtn icon={<RotateCcw size={16} />} label="Rotate Left" disabled={!has} onClick={() => dispatch({ type: 'rotatePages', ids: targetIds, delta: -90 })} title="Rotate selected pages counter-clockwise" />
      <ToolBtn icon={<RotateCw size={16} />} label="Rotate Right" disabled={!has} onClick={() => dispatch({ type: 'rotatePages', ids: targetIds, delta: 90 })} title="Rotate selected pages clockwise" />
      <ToolBtn icon={<FileOutput size={16} />} label="Extract" disabled={!has} onClick={onExtract} title="Extract selected pages into a new PDF" />

      <div className="ml-auto flex items-center gap-0.5 pl-3">
        <ToolBtn iconOnly icon={<ChevronUp size={16} />} label="Previous page" disabled={currentIndex <= 0} onClick={() => scrollToPage(currentIndex - 1)} />
        <div className="flex items-center gap-1.5 font-mono text-[12px] text-ink-soft">
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
        <span className="w-12 text-center font-mono text-[12px] tabular-nums text-ink-soft" aria-label="Zoom level">
          {Math.round(scale * 100)}%
        </span>
        <ToolBtn iconOnly icon={<ZoomIn size={16} />} label="Zoom in" onClick={() => zoomBy(1)} disabled={scale >= MAX_ZOOM - 0.005} />
        <ToolBtn icon={<ScanLine size={16} />} label="Fit width" active={zoom.mode === 'fit'} onClick={() => setZoom({ mode: 'fit' })} />
        <Divider />
        <ToolBtn icon={<SquareDashed size={16} />} label="Boxes" active={showBoxes} onClick={() => setShowBoxes(!showBoxes)} title="Show bounding boxes of detected objects (B)" />
        <Menu
          trigger={(toggle) => <ToolBtn iconOnly icon={<Ellipsis size={16} />} label="More options" onClick={toggle} active={debug} />}
          items={[
            { label: 'View', heading: true },
            { label: 'Show bounding boxes', hint: 'B', checked: showBoxes, onClick: () => setShowBoxes(!showBoxes) },
            { label: 'Show detected objects', hint: '⇧⌘D', checked: debug, onClick: () => setDebug(!debug) },
            { label: 'Layout engine', heading: true },
            ...PROVIDERS.map((p) => ({
              label: p.label,
              hint: p.available() ? (p.processing === 'on-device' ? 'on-device' : 'backend') : 'not configured',
              checked: layoutProvider === p.id,
              disabled: !p.available(),
              onClick: () => setLayoutProvider(p.id),
            })),
            { label: 'Developer', heading: true },
            { label: 'Open layout test suite', onClick: onOpenTestSuite },
          ]}
        />
      </div>
    </div>
  )
}
