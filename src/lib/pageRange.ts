// Page ranges as people type them: "1-3, 5, 8-", "all", "odd" / "even", "last" or "-2" (= last two)

export type RangeResult = { ok: true; indices: number[] } | { ok: false; error: string }

/** Parses a 1-based page range into sorted, de-duplicated 0-based indices. */
export function parsePageRange(input: string, pageCount: number): RangeResult {
  const text = input.trim().toLowerCase()
  if (!text) return { ok: false, error: 'Enter pages, e.g. 1-3, 5' }
  const all = Array.from({ length: pageCount }, (_, i) => i)
  if (text === 'all' || text === '*') return { ok: true, indices: all }
  if (text === 'odd') return { ok: true, indices: all.filter((i) => i % 2 === 0) }
  if (text === 'even') return { ok: true, indices: all.filter((i) => i % 2 === 1) }
  const out = new Set<number>()
  for (const raw of text.split(/[,;\s]+/).filter(Boolean)) {
    const part = raw.replace(/last|end/g, String(pageCount))
    const m = /^(\d*)\s*[-–—]\s*(\d*)$/.exec(part)
    let a: number
    let b: number
    if (m && (m[1] || m[2])) {
      // "-2" alone means the last two pages; "8-" means 8 to the end
      if (!m[1]) [a, b] = [Math.max(1, pageCount - Number(m[2]) + 1), pageCount]
      else [a, b] = [Number(m[1]), m[2] ? Number(m[2]) : pageCount]
    } else if (/^\d+$/.test(part)) a = b = Number(part)
    else return { ok: false, error: `“${raw}” is not a page or range` }
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) return { ok: false, error: `This document has pages 1–${pageCount}` }
    if (a > b) [a, b] = [b, a]
    for (let p = a; p <= b; p += 1) out.add(p - 1)
  }
  return { ok: true, indices: [...out].sort((x, y) => x - y) }
}

/** Compact 1-based label for indices: [0,1,2,4] → "1–3, 5". */
export function formatPageRange(indices: number[]): string {
  const s = [...new Set(indices)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < s.length; ) {
    let j = i
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j += 1
    parts.push(j > i ? `${s[i] + 1}–${s[j] + 1}` : `${s[i] + 1}`)
    i = j + 1
  }
  return parts.join(', ')
}
