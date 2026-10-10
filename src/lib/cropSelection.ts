// The rectangle being drawn with the Crop tool (one at a time, on one page). Shared by the page
// layer that draws it and the crop bar that applies it.
import { useSyncExternalStore } from 'react'
import type { CropBox } from './model'

export interface CropSelection {
  pageId: string
  /** Canonical page space. */
  box: CropBox
}

let current: CropSelection | null = null
const listeners = new Set<() => void>()

export const getCropSelection = () => current

export function setCropSelection(next: CropSelection | null) {
  if (next === current) return
  current = next
  listeners.forEach((f) => f())
}

const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => listeners.delete(f)
}

export const useCropSelection = () => useSyncExternalStore(subscribe, getCropSelection, getCropSelection)
