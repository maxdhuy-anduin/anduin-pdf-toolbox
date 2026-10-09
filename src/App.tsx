import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { AppContext, type AppCtx, type ObjectSelection, type ObjectsSelection, type Tool, type ToastKind, type ZoomState } from './context'
import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { InsertDialog, type InsertRequest } from './components/InsertDialog'
import { PropertiesPanel } from './components/PropertiesPanel'
import { StatusBar } from './components/StatusBar'
import { ThumbnailPanel } from './components/ThumbnailPanel'
import { Toasts, type ToastItem } from './components/Toasts'
import { Toolbar } from './components/Toolbar'
import { Viewer } from './components/Viewer'
import { Button, Modal } from './components/ui'
import { baseName, downloadBytes } from './lib/download'
import { buildPdf } from './lib/export'
import { rotateDelta } from './lib/geom'
import { initialState, isDirty, isGraphic, isText, makePage, makeTextOverlay, reducer, uid, type Overlay } from './lib/model'
import { getClipboard, sameText, setClipboard, TAB_ID } from './lib/clipboard'
import { copySelection, pageItems } from './lib/objects'
import { measureOverlay } from './components/PageOverlays'
import { getCachedContent, prefetchContent } from './lib/content/cache'
import { getActiveProvider, setActiveProvider } from './lib/layout/cache'
import type { ProviderId } from './lib/layout/types'
import { createLayoutSuite, LAYOUT_SUITE_NAME } from './lib/testDocs'
import { getSourceBytes, hasSource, LARGE_FILE_BYTES, openPdfBytes, openPdfFile, PdfError, releaseSource } from './lib/pdfjs'
import { createSampleFund, SAMPLE_FUND_NAME } from './lib/samples'

const isPdfFile = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

/** View toggles: `?debug` / `?boxes` in the URL, else remembered per browser (convenience only). */
function readFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).has(name) || localStorage.getItem(`toolbox.${name}`) === '1'
  } catch {
    return false
  }
}
function writeFlag(name: string, v: boolean) {
  try {
    localStorage.setItem(`toolbox.${name}`, v ? '1' : '0')
  } catch {
    /* per-viewer convenience only */
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [tool, setToolRaw] = useState<Tool>('select')
  const [zoom, setZoom] = useState<ZoomState>({ mode: 'fit' })
  const [scale, setScale] = useState(1)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [scrollRequest, setScrollRequest] = useState<AppCtx['scrollRequest']>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [insertFiles, setInsertFiles] = useState<File[] | null>(null)
  const [confirmReplace, setConfirmReplace] = useState<null | (() => void)>(null)
  const [dragging, setDragging] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState<string | null>(null)
  const [objSel, setObjSelRaw] = useState<ObjectsSelection | null>(null)
  const selectedObject = useMemo<ObjectSelection | null>(
    () => (objSel && objSel.keys.length === 1 && objSel.keys[0].startsWith('o:') ? { pageId: objSel.pageId, objectId: objSel.keys[0].slice(2) } : null),
    [objSel],
  )
  const [editRequest, setEditRequest] = useState<AppCtx['editRequest']>(null)
  const [debug, setDebug] = useState(() => readFlag('debug'))
  const [showBoxes, setShowBoxesRaw] = useState(() => readFlag('boxes'))
  const [layoutProvider, setLayoutProviderRaw] = useState<ProviderId>('local')
  const selectedObjectRef = useRef(selectedObject)
  selectedObjectRef.current = selectedObject
  const objSelRef = useRef(objSel)
  objSelRef.current = objSel
  const currentIndexRef = useRef(currentIndex)
  currentIndexRef.current = currentIndex
  const toolRef = useRef(tool)
  toolRef.current = tool
  const debugRef = useRef(debug)
  debugRef.current = debug
  const fileInput = useRef<HTMLInputElement>(null)
  const toastId = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state

  const hasDoc = state.pages.length > 0
  const dirty = isDirty(state)
  useEffect(() => {
    document.title = hasDoc ? `${dirty ? '• ' : ''}${state.fileName} – Anduin PDF Toolbox` : 'Anduin PDF Toolbox'
  }, [hasDoc, dirty, state.fileName])

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const toast = useCallback(
    (kind: ToastKind, text: string, action?: ToastItem['action']) => {
      const id = (toastId.current += 1)
      setToasts((t) => [...t.slice(-3), { id, kind, text, action }])
      setTimeout(() => dismissToast(id), kind === 'error' ? 9000 : 5500)
    },
    [dismissToast],
  )

  const scrollToPage = useCallback((index: number) => {
    const n = stateRef.current.pages.length
    if (!n) return
    const i = Math.max(0, Math.min(n - 1, index))
    setCurrentIndex(i)
    setScrollRequest((r) => ({ index: i, nonce: (r?.nonce ?? 0) + 1 }))
  }, [])

  const setObjSel = useCallback((sel: ObjectsSelection | null) => {
    const next = sel && sel.keys.length ? sel : null
    setObjSelRaw(next)
    if (next) dispatch({ type: 'selectOverlay', sel: null })
  }, [])
  const setSelectedObject = useCallback(
    (sel: ObjectSelection | null) => setObjSel(sel ? { pageId: sel.pageId, keys: [`o:${sel.objectId}`] } : null),
    [setObjSel],
  )
  const requestEdit = useCallback((pageId: string, objectId: string) => setEditRequest((r) => ({ pageId, objectId, nonce: (r?.nonce ?? 0) + 1 })), [])
  const toggleDebug = useCallback((v: boolean) => {
    setDebug(v)
    writeFlag('debug', v)
  }, [])
  const setShowBoxes = useCallback((v: boolean) => {
    setShowBoxesRaw(v)
    writeFlag('boxes', v)
  }, [])
  const showBoxesRef = useRef(showBoxes)
  showBoxesRef.current = showBoxes
  const setLayoutProvider = useCallback((id: ProviderId) => {
    setActiveProvider(id)
    setLayoutProviderRaw(getActiveProvider().id)
  }, [])

  const setTool = useCallback((t: Tool) => {
    setToolRaw(t)
    setObjSelRaw(null)
    if (t !== 'select') dispatch({ type: 'setSelection', ids: [] })
  }, [])

  // ---- opening documents -----------------------------------------------------
  const loadDocument = useCallback(
    async (name: string, make: () => Promise<Awaited<ReturnType<typeof openPdfFile>>>) => {
      setBusy(`Opening ${name}…`)
      await new Promise((r) => setTimeout(r, 30))
      try {
        const meta = await make()
        const old = Object.keys(stateRef.current.sources)
        dispatch({ type: 'load', source: meta, fileName: meta.name })
        old.forEach(releaseSource)
        setObjSelRaw(null)
        // parse once, analyze once: page content objects are cached in the background
        if (!meta.likelyScanned) prefetchContent(meta.id, meta.numPages)
        setToolRaw('select')
        setZoom({ mode: 'fit' })
        setCurrentIndex(0)
        setScrollRequest((r) => ({ index: 0, nonce: (r?.nonce ?? 0) + 1 }))
        setBannerDismissed(null)
        if (meta.size > LARGE_FILE_BYTES) toast('warning', 'This is a large file. Some operations may be slow in the browser.')
      } catch (e) {
        toast('error', e instanceof PdfError ? e.message : 'This file could not be opened.')
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )

  const openFile = useCallback(
    (file: File) => {
      if (!isPdfFile(file)) return toast('error', `“${file.name}” is not a PDF file.`)
      const go = () => void loadDocument(file.name, () => openPdfFile(file))
      if (isDirty(stateRef.current)) setConfirmReplace(() => go)
      else go()
    },
    [loadDocument, toast],
  )

  const openSample = useCallback(() => {
    const go = () => void loadDocument(SAMPLE_FUND_NAME, async () => openPdfBytes(SAMPLE_FUND_NAME, await createSampleFund()))
    if (isDirty(stateRef.current)) setConfirmReplace(() => go)
    else go()
  }, [loadDocument])

  const openTestSuite = useCallback(() => {
    const go = () => void loadDocument(LAYOUT_SUITE_NAME, async () => openPdfBytes(LAYOUT_SUITE_NAME, await createLayoutSuite()))
    if (isDirty(stateRef.current)) setConfirmReplace(() => go)
    else go()
  }, [loadDocument])

  const browse = () => fileInput.current?.click()

  // ---- page actions -----------------------------------------------------------
  const targetIds = useMemo(() => {
    if (state.selection.length) return state.pages.filter((p) => state.selection.includes(p.id)).map((p) => p.id)
    const cur = state.pages[currentIndex]
    return cur ? [cur.id] : []
  }, [state.selection, state.pages, currentIndex])

  const deleteTargets = useCallback(() => {
    const s = stateRef.current
    const ids = s.selection.length ? s.selection : s.pages[currentIndex] ? [s.pages[currentIndex].id] : []
    if (!ids.length) return
    if (ids.length >= s.pages.length) return toast('warning', 'A PDF needs at least one page, so not every page can be deleted.')
    dispatch({ type: 'deletePages', ids })
    toast('info', `Deleted ${ids.length} page${ids.length > 1 ? 's' : ''}.`, { label: 'Undo', run: () => dispatch({ type: 'undo' }) })
  }, [currentIndex, toast])

  const doInsert = useCallback(
    (req: InsertRequest) => {
      for (const e of req.entries) {
        dispatch({ type: 'addSource', source: e.source })
        if (!e.source.likelyScanned) prefetchContent(e.source.id, e.source.numPages)
      }
      const pages = req.entries.flatMap((e) => e.pageIndexes.map((i) => makePage(e.source.id, i)))
      dispatch({ type: 'insertPages', index: req.at, pages })
      setInsertFiles(null)
      toast('success', `Inserted ${pages.length} page${pages.length > 1 ? 's' : ''} at position ${req.at + 1}.`)
      scrollToPage(req.at)
    },
    [scrollToPage, toast],
  )

  const exportPdf = useCallback(async () => {
    const s = stateRef.current
    if (!s.pages.length) return
    setBusy('Preparing your PDF…')
    await new Promise((r) => setTimeout(r, 30))
    try {
      const base = baseName(s.fileName)
      const { bytes, warnings, stats } = await buildPdf(s.pages, s.sources, getSourceBytes, { title: base })
      downloadBytes(bytes, `${base}-edited.pdf`)
      dispatch({ type: 'markSaved' })
      const edits = stats.removed + stats.covered
      toast(
        'success',
        `Exported ${base}-edited.pdf (${s.pages.length} pages).` +
          (edits ? ` ${stats.removed} of ${edits} edited object${edits > 1 ? 's were' : ' was'} rewritten in the page content${stats.covered ? `; ${stats.covered} could only be covered` : ''}.` : ''),
      )
      warnings.forEach((w) => toast('warning', w))
    } catch (e) {
      console.error(e)
      toast('error', `The PDF could not be exported: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [toast])

  const extractPages = useCallback(async () => {
    const s = stateRef.current
    const ids = new Set(targetIds)
    const subset = s.pages.filter((p) => ids.has(p.id))
    if (!subset.length) return
    setBusy('Extracting pages…')
    await new Promise((r) => setTimeout(r, 30))
    try {
      const base = baseName(s.fileName)
      const { bytes, warnings } = await buildPdf(subset, s.sources, getSourceBytes, { title: `${base} (extract)` })
      downloadBytes(bytes, `${base}-extracted.pdf`)
      toast('success', `Extracted ${subset.length} page${subset.length > 1 ? 's' : ''} to ${base}-extracted.pdf.`)
      warnings.forEach((w) => toast('warning', w))
    } catch (e) {
      console.error(e)
      toast('error', `The pages could not be extracted: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [targetIds, toast])

  // ---- global events ----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      const typing = isTyping(e.target)
      const s = stateRef.current
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void exportPdf()
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        toggleDebug(!debugRef.current)
        return
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        fileInput.current?.click()
        return
      }
      if (typing) return
      if (mod && e.key.toLowerCase() === 'a' && toolRef.current === 'edit') {
        e.preventDefault()
        const cur = s.pages[currentIndex]
        if (cur) window.dispatchEvent(new CustomEvent('toolbox:objects', { detail: { pageId: cur.id, op: 'select-all' } }))
        return
      }
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        dispatch({ type: 'redo' })
        return
      }
      if (!s.pages.length || mod || e.altKey) return
      const ov = s.selectedOverlay
      const page = ov ? s.pages.find((p) => p.id === ov.pageId) : undefined
      const overlay = page?.overlays.find((o) => o.id === ov?.overlayId)
      const obj = selectedObjectRef.current
      if ((e.key === 'Delete' || e.key === 'Backspace') && overlay && page) {
        e.preventDefault()
        if (isGraphic(overlay)) dispatch({ type: 'updateOverlay', pageId: page.id, overlayId: overlay.id, patch: { deleted: true } })
        else if (isText(overlay) && (overlay.cover || overlay.source)) dispatch({ type: 'updateOverlay', pageId: page.id, overlayId: overlay.id, patch: { text: '' } })
        else dispatch({ type: 'removeOverlay', pageId: page.id, overlayId: overlay.id })
        dispatch({ type: 'selectOverlay', sel: null })
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && objSelRef.current) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('toolbox:objects', { detail: { pageId: objSelRef.current.pageId, op: 'delete' } }))
      } else if (e.key.startsWith('Arrow') && objSelRef.current) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as [number, number]
        window.dispatchEvent(new CustomEvent('toolbox:objects', { detail: { pageId: objSelRef.current.pageId, op: 'nudge', dx: d[0], dy: d[1] } }))
      } else if (e.key === 'Enter' && obj) {
        e.preventDefault()
        requestEdit(obj.pageId, obj.objectId)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection.length) {
        e.preventDefault()
        deleteTargets()
      } else if (e.key.startsWith('Arrow') && overlay && page && (isText(overlay) || isGraphic(overlay))) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as [number, number]
        const r = rotateDelta(d[0], d[1], page.rotation)
        dispatch({ type: 'updateOverlay', pageId: page.id, overlayId: overlay.id, patch: { x: overlay.x + r.x, y: overlay.y + r.y }, coalesce: `mv:${overlay.id}` })
      } else if (e.key === 'Escape') {
        dispatch({ type: 'selectOverlay', sel: null })
        dispatch({ type: 'setSelection', ids: [] })
        if (objSelRef.current) setObjSelRaw(null)
        else setToolRaw('select')
      } else if (e.key === 'v' || e.key === 'V') setTool('select')
      else if (e.key === 'e' || e.key === 'E') {
        const cur = s.pages[currentIndex]
        if (!(cur && s.sources[cur.sourceId].likelyScanned)) setTool('edit')
      } else if (e.key === 't' || e.key === 'T') setTool('add-text')
      else if (e.key === 'b' || e.key === 'B') setShowBoxes(!showBoxesRef.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentIndex, deleteTargets, exportPdf, setTool, requestEdit, toggleDebug, setShowBoxes])

  // ---- copy / cut / paste of PDF objects ---------------------------------------
  const pasteCount = useRef<{ id: string; n: number }>({ id: '', n: 0 })
  const fragmentSources = useRef(new Map<string, string>())
  useEffect(() => {
    const active = () => toolRef.current === 'edit' && stateRef.current.pages.length > 0
    // ⌘C / ⌘X / ⌘V are handled on the key press (Safari sends no copy/paste events without a text
    // selection); the clipboard events, when they come, put the plain text on the system clipboard.
    let lastCopy = { at: 0, text: '' }
    let pasteTimer = 0
    const doCopy = (cut: boolean): string | null => {
      const sel = objSelRef.current
      if (!sel || !active()) return null
      const s = stateRef.current
      const page = s.pages.find((p) => p.id === sel.pageId)
      if (!page) return null
      const content = getCachedContent(page.sourceId, page.srcIndex)
      const items = pageItems(content, page.overlays, (id) => measureOverlay(page.id, id))
      const copied = copySelection(page, content, items, sel.keys)
      if (!copied) return null
      setClipboard(copied, page.id, (sid, i) => s.sources[sid].pages[i], (sid) => s.sources[sid]?.name ?? 'document')
      lastCopy = { at: Date.now(), text: copied.text }
      pasteCount.current = { id: '', n: 0 }
      const n = sel.keys.length
      if (cut) window.dispatchEvent(new CustomEvent('toolbox:objects', { detail: { pageId: page.id, op: 'delete' } }))
      toast('info', `${cut ? 'Cut' : 'Copied'} ${n} object${n > 1 ? 's' : ''}. Paste with ⌘V here, on another page, or in another document tab.`)
      return copied.text
    }
    const copy = (e: ClipboardEvent, cut: boolean) => {
      if (isTyping(e.target)) return
      const text = Date.now() - lastCopy.at < 500 ? lastCopy.text : doCopy(cut)
      if (text === null) return
      e.preventDefault()
      e.clipboardData?.setData('text/plain', text)
    }
    const onCopy = (e: ClipboardEvent) => copy(e, false)
    const onCut = (e: ClipboardEvent) => copy(e, true)
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || isTyping(e.target) || !active()) return
      const k = e.key.toLowerCase()
      if (k === 'c' || k === 'x') {
        const text = doCopy(k === 'x')
        if (text !== null) navigator.clipboard?.writeText(text).catch(() => undefined)
      } else if (k === 'v') {
        window.clearTimeout(pasteTimer)
        pasteTimer = window.setTimeout(() => void paste(null), 80)
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || !active()) return
      window.clearTimeout(pasteTimer)
      e.preventDefault()
      void paste(e.clipboardData?.getData('text/plain') ?? '')
    }
    /** `text` = what the system clipboard holds, or null when the browser didn't tell us. */
    const paste = async (text: string | null) => {
      const s = stateRef.current
      const page = s.pages[currentIndexRef.current]
      if (!page) return
      const pending = getClipboard()
      const payload = pending ? await pending.catch(() => null) : null
      const info = s.sources[page.sourceId].pages[page.srcIndex]
      if (!payload || (text !== null && !sameText(payload.sel.text, text))) {
        if (text === null) return
        // something else is on the system clipboard: paste it as a new text box
        if (!text.trim()) return
        const t = makeTextOverlay(72, 72, { text: text.slice(0, 5000), width: Math.min(360, info.width - 144) })
        dispatch({ type: 'editOverlays', pageId: page.id, add: [t] })
        setObjSel({ pageId: page.id, keys: [`v:${t.id}`] })
        return
      }
      try {
        const { sel } = payload
        // same page in the same tab: offset the copy so it's visibly a duplicate
        const samePage = payload.tab === TAB_ID && payload.pageId === page.id
        if (pasteCount.current.id !== `${payload.id}|${page.id}`) pasteCount.current = { id: `${payload.id}|${page.id}`, n: 0 }
        pasteCount.current.n += 1
        const off = samePage ? 20 * pasteCount.current.n : 0
        const tx = Math.max(0, Math.min(sel.origin.x + off, info.width - sel.size.w))
        const ty = Math.max(0, Math.min(sel.origin.y + off, info.height - sel.size.h))
        const add: Overlay[] = []
        for (const g of sel.groups) {
          let sourceId = g.sourceId
          let srcIndex = g.srcIndex
          const local = payload.tab === TAB_ID && !!stateRef.current.sources[g.sourceId] && hasSource(g.sourceId)
          if (!local) {
            // content from another document / tab: register its one-page PDF as a hidden source
            const k = `${payload.id}|${g.sourceId}|${g.srcIndex}`
            let id = fragmentSources.current.get(k)
            if (!id || !stateRef.current.sources[id]) {
              const cp = payload.pages[`${g.sourceId}|${g.srcIndex}`]
              const meta = await openPdfBytes(`${cp.name} (copied)`, cp.bytes)
              dispatch({ type: 'addSource', source: meta })
              stateRef.current = { ...stateRef.current, sources: { ...stateRef.current.sources, [meta.id]: meta } }
              id = meta.id
              fragmentSources.current.set(k, id)
            }
            sourceId = id
            srcIndex = 0
          }
          add.push({ id: uid('paste'), type: 'paste', sourceId, srcIndex, items: g.items, dx: g.shift.x + tx, dy: g.shift.y + ty })
        }
        for (const t of sel.texts) add.push({ ...t, id: uid('tx'), x: t.x + tx, y: t.y + ty })
        dispatch({ type: 'editOverlays', pageId: page.id, add })
        setObjSel({ pageId: page.id, keys: add.map((o) => `v:${o.id}`) })
        if (!samePage) toast('success', `Pasted ${add.length > 1 ? `${add.length} blocks` : 'content'} on page ${currentIndexRef.current + 1}.`)
      } catch (err) {
        console.error(err)
        toast('error', 'The copied content could not be pasted here.')
      }
    }
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCut)
      window.removeEventListener('paste', onPaste)
    }
  }, [setObjSel, toast])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty(stateRef.current)) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // drag & drop of files anywhere on the window
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth += 1
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!files.length) return
      if (stateRef.current.pages.length) {
        setInsertFiles(files.filter(isPdfFile))
        if (!files.some(isPdfFile)) toast('error', 'Only PDF files can be inserted.')
      } else openFile(files.find(isPdfFile) ?? files[0])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [openFile, toast])

  // dev/test hook (not shipped in production builds)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__toolbox = {
      getState: () => stateRef.current,
      exportBytes: async () => (await buildPdf(stateRef.current.pages, stateRef.current.sources, getSourceBytes)).bytes,
      dispatch,
      openBytes: (name: string, bytes: Uint8Array) => loadDocument(name, () => openPdfBytes(name, bytes)),
    }
  }, [loadDocument])

  const ctx: AppCtx = {
    state, dispatch, tool, setTool, zoom, setZoom, scale, setScale, currentIndex, setCurrentIndex, scrollToPage, scrollRequest, toast,
    objSel, setObjSel, selectedObject, setSelectedObject, editRequest, requestEdit, debug, setDebug: toggleDebug,
    showBoxes, setShowBoxes, layoutProvider, setLayoutProvider,
  }

  const curSource = state.pages[currentIndex] ? state.sources[state.pages[currentIndex].sourceId] : undefined
  const showScannedBanner = !!curSource?.likelyScanned && bannerDismissed !== curSource.id

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-full flex-col">
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) openFile(f)
          }}
        />
        <Header onOpen={browse} onExport={() => void exportPdf()} exporting={!!busy} />
        {hasDoc ? (
          <>
            <Toolbar targetIds={targetIds} onInsert={() => setInsertFiles([])} onExtract={() => void extractPages()} onDelete={deleteTargets} onOpenTestSuite={openTestSuite} />
            {showScannedBanner && (
              <div role="status" className="flex items-center gap-2.5 border-b border-line bg-coral-soft px-4 py-2 text-[13px] text-ink">
                <AlertTriangle size={15} className="shrink-0 text-coral" />
                <span className="flex-1">
                  This PDF can be viewed, but some editing features are unavailable because it appears to contain scanned/image-based content. You can still
                  reorder, rotate, insert, extract and add text.
                </span>
                <button type="button" aria-label="Dismiss" onClick={() => setBannerDismissed(curSource!.id)}>
                  <X size={15} />
                </button>
              </div>
            )}
            <div className="flex min-h-0 flex-1">
              <ThumbnailPanel />
              <div className="relative flex min-w-0 flex-1">
                <Viewer />
                {tool !== 'select' && (
                  <div className="pointer-events-none absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2.5 whitespace-nowrap bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-white shadow-lg">
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-sky">{tool === 'add-text' ? 'Add text' : 'Edit'}</span>
                    {tool === 'add-text' ? 'Click on a page to place a text box · Esc to cancel' : 'Drag to move · drag empty space or Shift-click to select several · ⌘C ⌘V · double-click text to edit'}
                  </div>
                )}
              </div>
              <PropertiesPanel />
            </div>
          </>
        ) : (
          <EmptyState onBrowse={browse} onSample={openSample} dragging={dragging} />
        )}
        <StatusBar targetIds={targetIds} />
      </div>

      {insertFiles && (
        <InsertDialog initialFiles={insertFiles} pageCount={state.pages.length} currentIndex={currentIndex} onClose={() => setInsertFiles(null)} onInsert={doInsert} />
      )}
      {confirmReplace && (
        <Modal
          title="Replace current document?"
          onClose={() => setConfirmReplace(null)}
          footer={
            <>
              <Button onClick={() => setConfirmReplace(null)}>Keep editing</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const go = confirmReplace
                  setConfirmReplace(null)
                  go()
                }}
              >
                Discard changes and open
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-soft">You have unsaved changes in {state.fileName}. Opening another document will discard them. Export first if you want to keep them.</p>
        </Modal>
      )}
      {dragging && hasDoc && (
        <div className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-ink/30">
          <div className="border-2 border-dashed border-sky bg-white px-8 py-6 text-center shadow-xl">
            <div className="tight text-base font-semibold text-ink">Drop PDF to insert its pages</div>
            <div className="mt-1 text-sm text-muted">You’ll choose which pages and where they go.</div>
          </div>
        </div>
      )}
      {busy && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-white/55 backdrop-blur-[1px]" role="alert" aria-busy="true">
          <div className="flex items-center gap-3 border border-line bg-white px-5 py-3 text-sm font-medium text-ink shadow-lg">
            <Loader2 size={18} className="animate-spin text-sky-deep" />
            {busy}
          </div>
        </div>
      )}
      <Toasts items={toasts} dismiss={dismissToast} />
    </AppContext.Provider>
  )
}
