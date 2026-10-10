import { useCropSelection } from '../lib/cropSelection'

/** Shown while the Crop tool is active (at the bottom: the top edge of a page stays free to drag). */
export function CropBar({ pageCount, anyCropped, onCrop, onRemoveAll, onDone }: {
  pageCount: number
  anyCropped: boolean
  onCrop: (allPages: boolean) => void
  onRemoveAll: () => void
  onDone: () => void
}) {
  const sel = useCropSelection()
  const ready = !!sel && sel.box.w > 0 && sel.box.h > 0
  const btn = 'h-7 px-2.5 text-[12.5px] font-medium whitespace-nowrap transition-colors disabled:opacity-40'
  return (
    <div
      role="toolbar"
      aria-label="Crop"
      data-crop-bar
      className="absolute bottom-4 left-1/2 z-20 flex w-max max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2.5 bg-ink py-1 pl-3.5 pr-1 text-[12.5px] font-medium text-white shadow-lg"
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-sky">Crop</span>
      {/* until there is a selection, the instruction; then the buttons (the instruction too on wide screens) */}
      <span className={`whitespace-nowrap ${ready ? 'hidden xl:inline' : ''}`}>{ready ? 'Adjust the box, then crop' : 'Drag over the area to keep'}</span>
      <span className={`mx-0.5 h-4 w-px bg-white/25 ${ready ? 'hidden xl:inline' : ''}`} />
      {ready && (
        <button type="button" onClick={() => onCrop(false)} className={`${btn} bg-white text-ink hover:bg-[#ececec]`} title="Crop this page (Enter or ⌘K)">
          Crop page
        </button>
      )}
      {ready && pageCount > 1 && (
        <button type="button" onClick={() => onCrop(true)} className={`${btn} text-white/85 hover:bg-white/10 hover:text-white`} title="Apply the same crop to every page">
          Crop all
        </button>
      )}
      {anyCropped && (
        <button type="button" onClick={onRemoveAll} className={`${btn} text-white/85 hover:bg-white/10 hover:text-white`} title="Remove the crop from every page (show them in full again)">
          Remove crops
        </button>
      )}
      <button type="button" onClick={onDone} className={`${btn} text-white/85 hover:bg-white/10 hover:text-white`} title="Leave the Crop tool (Esc)">
        Done
      </button>
    </div>
  )
}
