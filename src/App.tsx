import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { AppContext, type AppCtx, type ObjectSelection, type ObjectsSelection, type SearchView, type Tool, type ToastKind, type ZoomState } from './context'
import { FindBar } from './components/FindBar'
import type { Margins, Unit } from './lib/margins'
import { EmptyState } from './components/EmptyState'
import { ExtractDialog, type ExtractRequest } from './components/ExtractDialog'
import { Header } from './components/Header'
import { TabBar } from './components/TabBar'
import { OrganizePages } from './components/OrganizePages'
import { formatPageRange } from './lib/pageRange'
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
import { initialState, isDirty, isGraphic, isText, makePage, makeTextOverlay, reducer, uid, type Action, type Overlay } from './lib/model'
import { activeTab, anyDirty, defaultView, emptyTab, hasDocument, initialWorkspace, tabName, tabSources, workspaceReducer, type TabView } from './lib/workspace'
import { getClipboard, sameText, setClipboard, TAB_ID } from './lib/clipboard'
import { copySelection, pageItems } from './lib/objects'
import { measureOverlay } from './components/PageOverlays'
import { getCachedContent, prefetchContent } from './lib/content/cache'
import { getActiveProvider, setActiveProvider } from './lib/layout/cache'
import type { ProviderId } from './lib/layout/types'
import { createLayoutSuite, LAYOUT_SUITE_NAME } from './lib/testDocs'
import { getSourceBytes, hasSource, LARGE_FILE_BYTES, openPdfBytes, openPdfFile, PdfError, releaseSource } from './lib/pdfjs'
import { createSampleFund, fetchSamplePdf, SAMPLE_FUND_NAME, SAMPLE_PDF_NAME } from './lib/samples'

const TOOL_HINTS: Record<Tool, [string, string]> = {
  select: ['Select', ''],
  edit: ['Edit', 'Drag to move (pink guides snap, ⌥ = free) · drag empty space or Shift-click to select several · ⌘C ⌘V · double-click text to edit'],
  'add-text': ['Add text', 'Click on a page to place a text box · Esc to cancel'],
  'add-line': ['Add line', 'Drag on a page to draw a line · Shift = straight / 45° · Esc to cancel'],
  'add-shape': ['Add shape', 'Drag on a page to draw · Shift = square / circle · click for a default size · Esc to cancel'],
  'add-footnote': ['Footnote', 'Click right after a word: a number goes there and the note at the bottom of the page · Esc to cancel'],
}

const isPdfFile = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
}

/** A dialog owns the keyboard: document shortcuts (Delete, ⌘Z, tools, paste…) must not act behind it. */
const modalOpen = () => !!document.querySelector('[aria-modal="true"]')

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
  // Document tabs: each tab is an independent document; the active one is shown through the context.
  const [ws, wsDispatch] = useReducer(workspaceReducer, undefined, initialWorkspace)
  const wsRef = useRef(ws)
  wsRef.current = ws
  const tab = activeTab(ws)
  const state = tab.doc
  const activeRef = useRef(tab.id)
  activeRef.current = tab.id
  /** Document actions go to the tab that is active when they are dispatched (stable, like useReducer's). */
  const dispatch = useCallback((action: Action) => wsDispatch({ type: 'doc', id: activeRef.current, action }), [])
  /** For work that finishes later (export, extract, paste, toast "Undo"): stays with the tab it started in. */
  const dispatchTo = useCallback((id: string, action: Action) => wsDispatch({ type: 'doc', id, action }), [])
  const [tool, setToolRaw] = useState<Tool>('select')
  const [zoom, setZoom] = useState<ZoomState>({ mode: 'fit' })
  const [scale, setScale] = useState(1)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [scrollRequest, setScrollRequest] = useState<AppCtx['scrollRequest']>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [insertFiles, setInsertFiles] = useState<File[] | null>(null)
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState<string | null>(null)
  const [objSel, setObjSelRaw] = useState<ObjectsSelection | null>(null)
  const [organize, setOrganize] = useState(false)
  const organizeRef = useRef(organize)
  organizeRef.current = organize
  const closeOrganizeRef = useRef<() => void>(() => undefined)
  const [extractFor, setExtractFor] = useState<number[] | null>(null)
  const selectedObject = useMemo<ObjectSelection | null>(
    () => (objSel && objSel.keys.length === 1 && objSel.keys[0].startsWith('o:') ? { pageId: objSel.pageId, objectId: objSel.keys[0].slice(2) } : null),
    [objSel],
  )
  const [editRequest, setEditRequest] = useState<AppCtx['editRequest']>(null)
  const [debug, setDebug] = useState(() => readFlag('debug'))
  const [showBoxes, setShowBoxesRaw] = useState(() => readFlag('boxes'))
  const [layoutProvider, setLayoutProviderRaw] = useState<ProviderId>('local')
  const [search, setSearch] = useState<SearchView | null>(null)
  const [find, setFind] = useState<{ open: boolean; replace: boolean; nonce: number; step: { dir: 1 | -1; nonce: number } | null }>({ open: false, replace: false, nonce: 0, step: null })
  const findRef = useRef(find)
  findRef.current = find
  const [showRulers, setShowRulersRaw] = useState(() => readFlag('rulers'))
  const setShowRulers = useCallback((v: boolean) => {
    setShowRulersRaw(v)
    writeFlag('rulers', v)
  }, [])
  const showRulersRef = useRef(showRulers)
  showRulersRef.current = showRulers
  const [rulerUnit, setRulerUnitRaw] = useState<Unit>(() => {
    try {
      const u = localStorage.getItem('toolbox.rulerUnit') as Unit | null
      return u && ['in', 'cm', 'mm', 'pt'].includes(u) ? u : 'in'
    } catch {
      return 'in'
    }
  })
  const setRulerUnit = useCallback((u: Unit) => {
    setRulerUnitRaw(u)
    try {
      localStorage.setItem('toolbox.rulerUnit', u)
    } catch {
      /* per-viewer convenience only */
    }
  }, [])
  const [customMargins, setCustomMargins] = useState<Margins | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const customMarginsRef = useRef(customMargins)
  customMarginsRef.current = customMargins
  const openFind = useCallback((replace: boolean) => setFind((f) => ({ ...f, open: true, replace: replace || (f.open && f.replace), nonce: f.nonce + 1 })), [])
  const closeFind = useCallback(() => setFind((f) => ({ ...f, open: false })), [])
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
      // warnings can be about the exported file's content: give them time to be read
      setTimeout(() => dismissToast(id), kind === 'error' || kind === 'warning' ? 12000 : 5500)
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

  // ---- tabs ------------------------------------------------------------------------
  /** How the active tab is being viewed (kept with it while another tab is shown). */
  const currentView = (): TabView => ({ currentIndex: currentIndexRef.current, zoom: zoomRef.current, customMargins: customMarginsRef.current })
  /** Finishes what is in progress on the active tab before another one is shown. */
  const leaveActiveTab = (): TabView => {
    const el = document.activeElement as HTMLElement | null
    if (el && el !== document.body) el.blur() // a text box being typed in commits / discards its draft now
    dispatch({ type: 'discardDraft' })
    return currentView()
  }
  /** Per-document UI starts fresh on the newly shown tab; its own view is restored. */
  const showTab = (id: string, view: TabView) => {
    activeRef.current = id
    setObjSelRaw(null)
    setToolRaw('select')
    setOrganize(false)
    setExtractFor(null)
    setFind((f) => ({ ...f, open: false, step: null }))
    setSearch(null)
    setZoom(view.zoom)
    setCustomMargins(view.customMargins)
    setCurrentIndex(view.currentIndex)
    // the viewer remounts for the tab: scroll once it has measured itself
    setTimeout(() => scrollToPage(view.currentIndex), 60)
  }
  const activateTab = (id: string) => {
    const w = wsRef.current
    const target = w.tabs.find((t) => t.id === id)
    if (!target || id === w.active || busy) return
    wsDispatch({ type: 'activate', id, leaving: leaveActiveTab() })
    showTab(id, target.view)
  }
  const newTab = () => {
    if (busy || !hasDocument(activeTab(wsRef.current))) return // the active tab is already an empty one
    const t = emptyTab()
    wsDispatch({ type: 'open', tab: t, leaving: leaveActiveTab() })
    showTab(t.id, t.view)
  }
  const closeTab = (id: string) => {
    const w = wsRef.current
    const t = w.tabs.find((x) => x.id === id)
    if (!t) return
    if (id === w.active) leaveActiveTab()
    const action = { type: 'close' as const, id, fresh: emptyTab() }
    const next = workspaceReducer(w, action)
    wsDispatch(action)
    tabSources(t).forEach(releaseSource) // the closed document's data doesn't stay in memory
    if (id === w.active) showTab(next.active, activeTab(next).view)
  }
  const requestCloseTab = (id: string) => {
    const t = wsRef.current.tabs.find((x) => x.id === id)
    if (!t || busy) return
    if (isDirty(t.doc)) setConfirmClose(id)
    else closeTab(id)
  }

  // ---- opening documents -----------------------------------------------------
  /** Opens a document in the active tab if it is empty, otherwise in a new tab. */
  const loadDocument = useCallback(
    async (name: string, make: () => Promise<Awaited<ReturnType<typeof openPdfFile>>>) => {
      setBusy(`Opening ${name}…`)
      await new Promise((r) => setTimeout(r, 30))
      try {
        const meta = await make()
        const cur = activeTab(wsRef.current)
        const into = hasDocument(cur) ? undefined : cur.id
        const t = { ...emptyTab(), doc: reducer(initialState, { type: 'load', source: meta, fileName: meta.name }), view: defaultView() }
        wsDispatch({ type: 'open', tab: t, into, leaving: leaveActiveTab() })
        showTab(into ?? t.id, t.view)
        // parse once, analyze once: page content objects are cached in the background
        if (!meta.likelyScanned) prefetchContent(meta.id, meta.numPages)
        setScrollRequest((r) => ({ index: 0, nonce: (r?.nonce ?? 0) + 1 }))
        setBannerDismissed(null)
        if (meta.size > LARGE_FILE_BYTES) toast('warning', 'This is a large file. Some operations may be slow in the browser.')
      } catch (e) {
        toast('error', e instanceof PdfError ? e.message : 'This file could not be opened.')
      } finally {
        setBusy(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast],
  )

  const openFile = useCallback(
    (file: File): Promise<void> => {
      if (!isPdfFile(file)) {
        toast('error', `“${file.name}” is not a PDF file.`)
        return Promise.resolve()
      }
      return loadDocument(file.name, () => openPdfFile(file))
    },
    [loadDocument, toast],
  )
  /** Several files: one tab each, opened one after the other. */
  const openFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) await openFile(f)
    },
    [openFile],
  )

  const openSample = useCallback(() => void loadDocument(SAMPLE_PDF_NAME, async () => openPdfBytes(SAMPLE_PDF_NAME, await fetchSamplePdf())), [loadDocument])
  /** The synthetic fund document the README walkthrough and the tests use. */
  const openDemo = useCallback(() => void loadDocument(SAMPLE_FUND_NAME, async () => openPdfBytes(SAMPLE_FUND_NAME, await createSampleFund())), [loadDocument])

  const openTestSuite = useCallback(() => void loadDocument(LAYOUT_SUITE_NAME, async () => openPdfBytes(LAYOUT_SUITE_NAME, await createLayoutSuite())), [loadDocument])

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
    const docId = activeRef.current
    dispatch({ type: 'deletePages', ids })
    toast('info', `Deleted ${ids.length} page${ids.length > 1 ? 's' : ''}.`, { label: 'Undo', run: () => dispatchTo(docId, { type: 'undo' }) })
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
    const docId = activeRef.current
    if (!s.pages.length) return
    setBusy('Preparing your PDF…')
    await new Promise((r) => setTimeout(r, 30))
    try {
      const base = baseName(s.fileName)
      const { bytes, warnings, stats } = await buildPdf(s.pages, s.sources, getSourceBytes, { title: base })
      downloadBytes(bytes, `${base}-edited.pdf`)
      dispatchTo(docId, { type: 'markSaved', pages: s.pages })
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

  const openExtract = useCallback(() => {
    const s = stateRef.current
    setExtractFor(s.pages.flatMap((p, i) => (s.selection.includes(p.id) ? [i] : [])))
  }, [])

  const extractPages = useCallback(
    async (req: ExtractRequest) => {
      const s = stateRef.current
      const docId = activeRef.current
      const subset = req.indices.map((i) => s.pages[i]).filter(Boolean)
      if (!subset.length) return
      setExtractFor(null)
      setBusy(req.separate ? `Extracting ${subset.length} files…` : 'Extracting pages…')
      await new Promise((r) => setTimeout(r, 30))
      try {
        const base = baseName(s.fileName)
        const label = formatPageRange(req.indices).replace(/–/g, '-').replace(/, /g, '_')
        const warnings = new Set<string>()
        if (req.separate) {
          for (let k = 0; k < subset.length; k += 1) {
            const r = await buildPdf([subset[k]], s.sources, getSourceBytes, { title: `${base} (page ${req.indices[k] + 1})` })
            downloadBytes(r.bytes, `${base}-page-${req.indices[k] + 1}.pdf`)
            r.warnings.forEach((w) => warnings.add(w))
            await new Promise((res) => setTimeout(res, 250)) // browsers drop rapid-fire downloads
          }
          toast('success', `Extracted ${subset.length} page${subset.length > 1 ? 's' : ''} as separate files.`)
        } else {
          const r = await buildPdf(subset, s.sources, getSourceBytes, { title: `${base} (pages ${label})` })
          downloadBytes(r.bytes, `${base}-pages-${label}.pdf`)
          r.warnings.forEach((w) => warnings.add(w))
          toast('success', `Extracted page${subset.length > 1 ? 's' : ''} ${formatPageRange(req.indices)} to ${base}-pages-${label}.pdf.`)
        }
        warnings.forEach((w) => toast('warning', w))
        if (req.deleteAfter && subset.length < s.pages.length) {
          dispatchTo(docId, { type: 'deletePages', ids: subset.map((p) => p.id) })
          toast('info', `Removed the extracted page${subset.length > 1 ? 's' : ''} from this document.`, { label: 'Undo', run: () => dispatchTo(docId, { type: 'undo' }) })
        }
      } catch (e) {
        console.error(e)
        toast('error', `The pages could not be extracted: ${(e as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )

  closeOrganizeRef.current = () => closeOrganize()
  const openOrganize = useCallback(() => {
    setObjSelRaw(null)
    dispatch({ type: 'selectOverlay', sel: null })
    setToolRaw('select')
    setOrganize(true)
  }, [])
  const closeOrganize = useCallback(
    (openIndex?: number) => {
      setOrganize(false)
      const s = stateRef.current
      const i = openIndex ?? s.pages.findIndex((p) => s.selection.includes(p.id))
      // the viewer remounts: scroll once it has measured itself
      if (i >= 0) setTimeout(() => scrollToPage(i), 60)
    },
    [scrollToPage],
  )

  // ---- global events ----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return
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
      if (s.pages.length && !organizeRef.current && mod && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')) {
        e.preventDefault()
        openFind(e.altKey)
        return
      }
      if (s.pages.length && findRef.current.open && mod && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        const dir = e.shiftKey ? -1 : 1
        setFind((f) => ({ ...f, step: { dir, nonce: (f.step?.nonce ?? 0) + 1 } }))
        return
      }
      if (typing) return
      if (mod && e.key.toLowerCase() === 'a' && organizeRef.current) {
        e.preventDefault()
        dispatch({ type: 'setSelection', ids: s.pages.map((p) => p.id) })
        return
      }
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
      } else if (e.key === 'Escape' && organizeRef.current) {
        if (s.selection.length) dispatch({ type: 'setSelection', ids: [] })
        else closeOrganizeRef.current()
      } else if (organizeRef.current) {
        // tool shortcuts don't apply in the page grid
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
      else if (e.key === 'l' || e.key === 'L') setTool('add-line')
      else if (e.key === 's' || e.key === 'S') setTool('add-shape')
      else if (e.key === 'n' || e.key === 'N') setTool('add-footnote')
      else if (e.key === 'r' || e.key === 'R') setShowRulers(!showRulersRef.current)
      else if (e.key === 'b' || e.key === 'B') setShowBoxes(!showBoxesRef.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentIndex, deleteTargets, exportPdf, setTool, requestEdit, toggleDebug, setShowBoxes, openFind, setShowRulers])

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
      const skipped = copied.skipped ?? 0
      if (skipped && (cut || !copied.groups.length && !copied.texts.length && !copied.lines.length && !copied.shapes?.length)) {
        // never delete what couldn't be copied
        toast('warning', `${skipped} image${skipped > 1 ? 's' : ''} in the selection can't be copied (${skipped > 1 ? 'they share' : 'it shares'} drawing instructions with other content), so nothing was ${cut ? 'cut' : 'copied'}.`)
        return null
      }
      setClipboard(copied, page.id, (sid, i) => s.sources[sid].pages[i], (sid) => s.sources[sid]?.name ?? 'document')
      lastCopy = { at: Date.now(), text: copied.text }
      pasteCount.current = { id: '', n: 0 }
      const n = sel.keys.length
      if (cut) window.dispatchEvent(new CustomEvent('toolbox:objects', { detail: { pageId: page.id, op: 'delete' } }))
      toast('info', `${cut ? 'Cut' : 'Copied'} ${n} object${n > 1 ? 's' : ''}. Paste with ⌘V here, on another page, or in another document tab.`)
      if (skipped) toast('warning', `${skipped} image${skipped > 1 ? 's' : ''} in the selection could not be copied (shared drawing instructions).`)
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
      if (!(e.metaKey || e.ctrlKey) || e.altKey || isTyping(e.target) || !active() || modalOpen()) return
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
      if (isTyping(e.target) || !active() || modalOpen()) return
      window.clearTimeout(pasteTimer)
      e.preventDefault()
      void paste(e.clipboardData?.getData('text/plain') ?? '')
    }
    /** `text` = what the system clipboard holds, or null when the browser didn't tell us. */
    const paste = async (text: string | null) => {
      const s = stateRef.current
      const docId = activeRef.current
      const page = s.pages[currentIndexRef.current]
      if (!page) return
      const pending = getClipboard()
      const payload = pending ? await pending.catch(() => null) : null
      if (activeRef.current !== docId) return // another tab was shown meanwhile: don't paste into the wrong document
      const info = s.sources[page.sourceId].pages[page.srcIndex]
      if (!payload || (text !== null && !sameText(payload.sel.text, text))) {
        if (text === null) return
        // something else is on the system clipboard: paste it as a new text box
        if (!text.trim()) return
        const t = makeTextOverlay(72, 72, { text: text.slice(0, 5000), width: Math.min(360, info.width - 144) })
        dispatchTo(docId, { type: 'editOverlays', pageId: page.id, add: [t] })
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
              dispatchTo(docId, { type: 'addSource', source: meta })
              if (activeRef.current === docId) stateRef.current = { ...stateRef.current, sources: { ...stateRef.current.sources, [meta.id]: meta } }
              id = meta.id
              fragmentSources.current.set(k, id)
            }
            sourceId = id
            srcIndex = 0
          }
          add.push({ id: uid('paste'), type: 'paste', sourceId, srcIndex, items: g.items, dx: g.shift.x + tx, dy: g.shift.y + ty })
        }
        for (const t of sel.texts) add.push({ ...t, id: uid('tx'), x: t.x + tx, y: t.y + ty })
        for (const l of sel.lines ?? []) add.push({ ...l, id: uid('ln'), x1: l.x1 + tx, y1: l.y1 + ty, x2: l.x2 + tx, y2: l.y2 + ty })
        for (const sh of sel.shapes ?? []) add.push({ ...sh, id: uid('sh'), x: sh.x + tx, y: sh.y + ty })
        dispatchTo(docId, { type: 'editOverlays', pageId: page.id, add })
        if (activeRef.current !== docId) return
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
  }, [setObjSel, toast, dispatchTo])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (anyDirty(wsRef.current)) e.preventDefault()
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
      const onTabBar = !!(e.target as HTMLElement | null)?.closest?.('[data-tabbar]')
      if (stateRef.current.pages.length && !onTabBar) {
        setInsertFiles(files.filter(isPdfFile))
        if (!files.some(isPdfFile)) toast('error', 'Only PDF files can be inserted.')
      } else if (files.some(isPdfFile)) void openFiles(files.filter(isPdfFile))
      else void openFile(files[0]) // says it's not a PDF
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
  }, [openFile, openFiles, toast])

  // dev/test hook (not shipped in production builds)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__toolbox = {
      getState: () => stateRef.current,
      getWorkspace: () => wsRef.current,
      exportBytes: async () => (await buildPdf(stateRef.current.pages, stateRef.current.sources, getSourceBytes)).bytes,
      dispatch,
      openBytes: (name: string, bytes: Uint8Array) => loadDocument(name, () => openPdfBytes(name, bytes)),
    }
  }, [loadDocument])

  const ctx: AppCtx = {
    state, dispatch, tool, setTool, zoom, setZoom, scale, setScale, currentIndex, setCurrentIndex, scrollToPage, scrollRequest, toast,
    objSel, setObjSel, selectedObject, setSelectedObject, editRequest, requestEdit, debug, setDebug: toggleDebug,
    showBoxes, setShowBoxes, layoutProvider, setLayoutProvider, search, showRulers, setShowRulers, rulerUnit, setRulerUnit,
    customMargins, setCustomMargins,
  }

  // in Organize, Insert defaults to "after the last selected page" (or the end)
  const selectedPositions = state.pages.flatMap((p, i) => (state.selection.includes(p.id) ? [i] : []))
  const insertAfter = selectedPositions.length ? selectedPositions[selectedPositions.length - 1] : state.pages.length - 1
  const curSource = state.pages[currentIndex] ? state.sources[state.pages[currentIndex].sourceId] : undefined
  const showScannedBanner = !!curSource?.likelyScanned && bannerDismissed !== curSource.id

  return (
    <AppContext.Provider value={ctx}>
      <div className="flex h-full flex-col">
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length) void openFiles(files)
          }}
        />
        <Header onOpen={browse} onExport={() => void exportPdf()} exporting={!!busy} />
        {(ws.tabs.length > 1 || hasDoc) && (
          <TabBar
            tabs={ws.tabs.map((t) => ({ id: t.id, name: tabName(t), dirty: isDirty(t.doc), empty: !hasDocument(t) }))}
            active={tab.id}
            onActivate={activateTab}
            onClose={requestCloseTab}
            onNew={newTab}
            disabled={!!busy}
          />
        )}
        {/* keyed by tab: switching documents remounts the viewer, panels and their local state */}
        <Fragment key={tab.id}>
        {hasDoc && organize ? (
          <OrganizePages onClose={closeOrganize} onInsert={() => setInsertFiles([])} onExtract={openExtract} onDelete={deleteTargets} />
        ) : hasDoc ? (
          <>
            <Toolbar targetIds={targetIds} onInsert={() => setInsertFiles([])} onExtract={openExtract} onDelete={deleteTargets} onOpenTestSuite={openTestSuite} onOpenDemo={openDemo} onOrganize={openOrganize} onFind={() => openFind(false)} />
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
                {find.open && (
                  <FindBar
                    focusNonce={find.nonce}
                    replaceOpen={find.replace}
                    setReplaceOpen={(v) => setFind((f) => ({ ...f, replace: v }))}
                    stepRequest={find.step}
                    onClose={closeFind}
                    setSearch={setSearch}
                    top={showRulers ? 32 : 12}
                  />
                )}
                {tool !== 'select' && !find.open && (
                  <div className="pointer-events-none absolute left-1/2 z-20 flex w-max max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-2.5 bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-white shadow-lg" style={{ top: showRulers ? 32 : 12 }}>
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-sky">{TOOL_HINTS[tool][0]}</span>
                    {TOOL_HINTS[tool][1]}
                  </div>
                )}
              </div>
              <PropertiesPanel />
            </div>
          </>
        ) : (
          <EmptyState onBrowse={browse} onSample={openSample} dragging={dragging} />
        )}
        </Fragment>
        <StatusBar targetIds={targetIds} />
      </div>

      {insertFiles && (
        <InsertDialog
          initialFiles={insertFiles}
          pageCount={state.pages.length}
          currentIndex={organize ? insertAfter : currentIndex}
          onClose={() => setInsertFiles(null)}
          onInsert={doInsert}
        />
      )}
      {extractFor && <ExtractDialog pageCount={state.pages.length} selected={extractFor} onClose={() => setExtractFor(null)} onExtract={(r) => void extractPages(r)} />}
      {confirmClose && (() => {
        const t = ws.tabs.find((x) => x.id === confirmClose)
        if (!t) return null
        return (
          <Modal
            title={`Close “${tabName(t)}”?`}
            onClose={() => setConfirmClose(null)}
            footer={
              <>
                <Button onClick={() => setConfirmClose(null)}>Keep open</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setConfirmClose(null)
                    closeTab(t.id)
                  }}
                >
                  Close without exporting
                </Button>
              </>
            }
          >
            <p className="text-sm text-ink-soft">This document has unsaved changes. Closing its tab discards them. Export it first if you want to keep them.</p>
          </Modal>
        )
      })()}
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
