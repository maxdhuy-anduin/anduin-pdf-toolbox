import { getPdfPage } from './pdfjs'
import type { PageInfo } from './model'

/** Thumbnails are rendered once per source page and shared by every view of it. */
export const THUMB_WIDTH = 150
const cache = new Map<string, HTMLCanvasElement>()
const pending = new Map<string, Promise<HTMLCanvasElement>>()
const waiting: (() => void)[] = []
let active = 0
const MAX_ACTIVE = 3

function pump() {
  while (active < MAX_ACTIVE && waiting.length) {
    active += 1
    waiting.shift()!()
  }
}

/** Keeps memory bounded on long documents: least-recently-used thumbnails are re-rendered on demand. */
const MAX_CACHED = 150
function touch(key: string): HTMLCanvasElement | undefined {
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

/** Two render sizes: the side panel's and a larger one for the Organize pages grid. */
const bucket = (width: number) => (width <= THUMB_WIDTH + 10 ? THUMB_WIDTH : 300)

export const getCachedThumb = (sourceId: string, srcIndex: number, width = THUMB_WIDTH) => touch(`${sourceId}:${srcIndex}:${bucket(width)}`)

export function renderThumb(sourceId: string, srcIndex: number, info: PageInfo, width = THUMB_WIDTH): Promise<HTMLCanvasElement> {
  const size = bucket(width)
  const key = `${sourceId}:${srcIndex}:${size}`
  const hit = touch(key)
  if (hit) return Promise.resolve(hit)
  const inflight = pending.get(key)
  if (inflight) return inflight
  const p = new Promise<HTMLCanvasElement>((resolve, reject) => {
    waiting.push(async () => {
      try {
        const page = await getPdfPage(sourceId, srcIndex)
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        const viewport = page.getViewport({ scale: (size * dpr) / info.width })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        await page.render({ canvas, viewport }).promise
        cache.set(key, canvas)
        while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
        resolve(canvas)
      } catch (e) {
        reject(e)
      } finally {
        pending.delete(key)
        active -= 1
        pump()
      }
    })
    pump()
  })
  pending.set(key, p)
  return p
}
