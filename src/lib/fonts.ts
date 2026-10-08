const CP1252_EXTRA = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((c) => c.codePointAt(0)!))

/** Characters the standard PDF fonts (WinAnsi) can draw. */
export function isWinAnsi(ch: string): boolean {
  if (ch === '\n') return true
  const cp = ch.codePointAt(0)!
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRA.has(cp)
}

export function unsupportedChars(text: string): string[] {
  const bad = new Set<string>()
  for (const ch of text) if (!isWinAnsi(ch)) bad.add(ch)
  return [...bad]
}
