// Where an exported PDF goes. Chrome and Edge show the system "Save As" dialog (File System Access
// API: the user picks the folder and the name). Other browsers download the file; the app asks for
// the name first and the browser's own download settings decide the folder.

/** Writes the exported bytes to where the user chose. */
export interface SaveTarget {
  /** File name the user chose (shown in messages). */
  name: string
  /** True when the system dialog was used (the file goes exactly where the user picked). */
  picked: boolean
  write: (bytes: Uint8Array) => Promise<void>
}

interface FileHandle {
  name: string
  createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>
}
type ShowSaveFilePicker = (opts: {
  suggestedName: string
  id?: string
  types: { description: string; accept: Record<string, string[]> }[]
}) => Promise<FileHandle>

const picker = (): ShowSaveFilePicker | null => {
  if (typeof window === 'undefined') return null
  const fn = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker }).showSaveFilePicker
  // not available in sub-frames (the app embedded elsewhere)
  return typeof fn === 'function' && window.self === window.top ? fn.bind(window) : null
}

/** Whether the browser can show the system Save dialog. */
export const canPickSaveLocation = () => !!picker()

/** Adds ".pdf" when missing and strips characters no file system accepts. */
export function pdfFileName(name: string, fallback = 'document.pdf') {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim()
  if (!clean || /^\.+(pdf)?$/i.test(clean)) return fallback
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`
}

/**
 * Shows the system Save dialog. Must be called straight from a click or key press (before any
 * long `await`): browsers only open it in response to the user. Returns null when the user
 * cancels, 'unsupported' when the dialog cannot be shown (the caller falls back to a download).
 */
export async function pickSaveTarget(suggestedName: string): Promise<SaveTarget | null | 'unsupported'> {
  const show = picker()
  if (!show) return 'unsupported'
  let handle: FileHandle
  try {
    handle = await show({ suggestedName, id: 'anduin-pdf-export', types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') return null
    return 'unsupported' // e.g. SecurityError: no recent user gesture
  }
  return {
    name: handle.name,
    picked: true,
    write: async (bytes) => {
      const w = await handle.createWritable()
      await w.write(new Blob([bytes.slice().buffer], { type: 'application/pdf' }))
      await w.close()
    },
  }
}
