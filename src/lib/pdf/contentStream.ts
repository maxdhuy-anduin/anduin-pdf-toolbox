// Minimal PDF content-stream tokenizer / serializer.
//
// Parses a page's content stream into operators with their operands and the byte range they
// occupy, so an edited stream can be re-assembled from the untouched original bytes plus a few
// replaced operators (no lossy round-trip through our own printer).

export type Operand =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; bytes: Uint8Array; hex: boolean }
  | { t: 'arr'; v: Operand[] }
  | { t: 'dict'; v: Record<string, Operand> }
  | { t: 'kw'; v: string } // true / false / null

export interface Op {
  op: string
  args: Operand[]
  /** Byte range [start, end) of operands + operator in the source. */
  start: number
  end: number
  /** For inline images (BI … ID … EI): the whole raw block. */
  inline?: boolean
}

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37])

export function parseContentStream(b: Uint8Array): Op[] {
  const ops: Op[] = []
  let i = 0
  let args: Operand[] = []
  let argStart = -1
  const n = b.length

  const skipWs = () => {
    while (i < n) {
      if (WS.has(b[i])) i += 1
      else if (b[i] === 37) {
        while (i < n && b[i] !== 10 && b[i] !== 13) i += 1
      } else break
    }
  }

  const readToken = (): Operand | { t: 'op'; v: string } | null => {
    skipWs()
    if (i >= n) return null
    const c = b[i]
    if (c === 47) {
      // name
      i += 1
      let s = ''
      while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) {
        if (b[i] === 35 && i + 2 < n) {
          s += String.fromCharCode(parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16))
          i += 3
        } else s += String.fromCharCode(b[i++])
      }
      return { t: 'name', v: s }
    }
    if (c === 40) {
      // literal string with nesting and escapes
      i += 1
      let depth = 1
      const out: number[] = []
      while (i < n) {
        const ch = b[i++]
        if (ch === 92) {
          const e = b[i++]
          if (e === 110) out.push(10)
          else if (e === 114) out.push(13)
          else if (e === 116) out.push(9)
          else if (e === 98) out.push(8)
          else if (e === 102) out.push(12)
          else if (e === 13) {
            if (b[i] === 10) i += 1
          } else if (e === 10) {
            /* line continuation */
          } else if (e >= 48 && e <= 55) {
            let v = e - 48
            for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k += 1) v = v * 8 + (b[i++] - 48)
            out.push(v & 255)
          } else out.push(e)
        } else if (ch === 40) {
          depth += 1
          out.push(ch)
        } else if (ch === 41) {
          depth -= 1
          if (depth === 0) break
          out.push(ch)
        } else out.push(ch)
      }
      return { t: 'str', bytes: new Uint8Array(out), hex: false }
    }
    if (c === 60 && b[i + 1] === 60) {
      i += 2
      const v: Record<string, Operand> = {}
      for (;;) {
        skipWs()
        if (i >= n) break
        if (b[i] === 62 && b[i + 1] === 62) {
          i += 2
          break
        }
        const k = readToken()
        const val = readToken()
        if (!k || !val) break
        if (k.t === 'name' && val.t !== 'op') v[k.v] = val
      }
      return { t: 'dict', v }
    }
    if (c === 60) {
      i += 1
      let hex = ''
      while (i < n && b[i] !== 62) {
        if (!WS.has(b[i])) hex += String.fromCharCode(b[i])
        i += 1
      }
      i += 1
      if (hex.length % 2) hex += '0'
      const bytes = new Uint8Array(hex.length / 2)
      for (let k = 0; k < bytes.length; k += 1) bytes[k] = parseInt(hex.slice(2 * k, 2 * k + 2), 16) || 0
      return { t: 'str', bytes, hex: true }
    }
    if (c === 91) {
      i += 1
      const v: Operand[] = []
      for (;;) {
        skipWs()
        if (i >= n || b[i] === 93) {
          i += 1
          break
        }
        const tok = readToken()
        if (!tok) break
        if (tok.t !== 'op') v.push(tok)
      }
      return { t: 'arr', v }
    }
    if (c === 93 || c === 62 || c === 41 || c === 123 || c === 125) {
      i += 1
      return readToken()
    }
    // number or keyword/operator
    let s = ''
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) s += String.fromCharCode(b[i++])
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return { t: 'num', v: parseFloat(s) }
    if (s === 'true' || s === 'false' || s === 'null') return { t: 'kw', v: s }
    return { t: 'op', v: s }
  }

  for (;;) {
    skipWs()
    if (i >= n) break
    const tokStart = i
    const tok = readToken()
    if (!tok) break
    if (tok.t !== 'op') {
      if (argStart < 0) argStart = tokStart
      args.push(tok)
      continue
    }
    if (tok.v === 'BI') {
      // inline image: BI <dict entries> ID <data> EI
      const start = tokStart
      const dict: Record<string, Operand> = {}
      for (;;) {
        skipWs()
        const save = i
        const k = readToken()
        if (!k) break
        if (k.t === 'op' && k.v === 'ID') break
        const val = readToken()
        if (k.t === 'name' && val && val.t !== 'op') dict[k.v] = val
        if (i === save) break
      }
      i += 1 // single whitespace after ID
      // find "EI" surrounded by whitespace
      while (i < n - 1 && !(b[i] === 69 && b[i + 1] === 73 && WS.has(b[i - 1]) && (i + 2 >= n || WS.has(b[i + 2]) || DELIM.has(b[i + 2])))) i += 1
      i = Math.min(n, i + 2)
      ops.push({ op: 'BI', args: [{ t: 'dict', v: dict }], start, end: i, inline: true })
      args = []
      argStart = -1
      continue
    }
    ops.push({ op: tok.v, args, start: argStart >= 0 ? argStart : tokStart, end: i })
    args = []
    argStart = -1
  }
  return ops
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''))

export function serializeOperand(o: Operand): string {
  switch (o.t) {
    case 'num':
      return fmt(o.v)
    case 'name':
      return `/${o.v.replace(/[^!-~]|[#()<>[\]{}/%]/g, (ch) => `#${ch.charCodeAt(0).toString(16).padStart(2, '0')}`)}`
    case 'str':
      return `<${Array.from(o.bytes, (x) => x.toString(16).padStart(2, '0')).join('')}>`
    case 'arr':
      return `[${o.v.map(serializeOperand).join(' ')}]`
    case 'dict':
      return `<<${Object.entries(o.v).map(([k, v]) => `/${k} ${serializeOperand(v)}`).join(' ')}>>`
    case 'kw':
      return o.v
  }
}

/**
 * Per-operator edits: a string replaces the operator, null deletes it, and `wrap` keeps the
 * original bytes untouched (binary-safe) between a prefix and a suffix.
 */
export type Replacements = Map<number, string | null | { wrap: [string, string] }>

export function rebuildContentStream(src: Uint8Array, ops: Op[], repl: Replacements): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  let size = 0
  const push = (u: Uint8Array) => {
    parts.push(u)
    size += u.length
  }
  const nl = enc.encode('\n')
  ops.forEach((op, idx) => {
    if (repl.has(idx)) {
      const r = repl.get(idx)
      if (typeof r === 'string' && r) {
        push(enc.encode(r))
        push(nl)
      } else if (r && typeof r === 'object') {
        push(enc.encode(`${r.wrap[0]}\n`))
        push(src.subarray(op.start, op.end))
        push(enc.encode(`\n${r.wrap[1]}\n`))
      }
      return
    }
    push(src.subarray(op.start, op.end))
    push(nl)
  })
  const out = new Uint8Array(size)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
