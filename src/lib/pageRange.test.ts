import { describe, expect, it } from 'vitest'
import { formatPageRange, parsePageRange } from './pageRange'

const idx = (s: string, n = 10) => {
  const r = parsePageRange(s, n)
  return r.ok ? r.indices : r.error
}

describe('page ranges', () => {
  it('parses lists, ranges and open ends', () => {
    expect(idx('1-3, 5')).toEqual([0, 1, 2, 4])
    expect(idx('8-')).toEqual([7, 8, 9])
    expect(idx('-2')).toEqual([8, 9])
    expect(idx('3–1 3')).toEqual([0, 1, 2])
    expect(idx('2, last')).toEqual([1, 9])
    expect(idx('all', 3)).toEqual([0, 1, 2])
    expect(idx('odd', 5)).toEqual([0, 2, 4])
    expect(idx('even', 5)).toEqual([1, 3])
  })
  it('explains bad input', () => {
    expect(idx('')).toMatch(/Enter pages/)
    expect(idx('0')).toMatch(/pages 1–10/)
    expect(idx('12')).toMatch(/pages 1–10/)
    expect(idx('abc')).toMatch(/not a page/)
  })
  it('formats indices compactly', () => {
    expect(formatPageRange([0, 1, 2, 4, 6, 7])).toBe('1–3, 5, 7–8')
    expect(formatPageRange([])).toBe('')
  })
})
