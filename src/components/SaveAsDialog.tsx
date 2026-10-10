import { useEffect, useRef, useState } from 'react'
import { Button, Modal } from './ui'

/**
 * File name for an export, in browsers without a system Save dialog (Safari, Firefox): the file
 * is then downloaded, to the folder the browser's download settings choose.
 */
export function SaveAsDialog({ suggested, onSave, onCancel }: { suggested: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(suggested)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    // select the name without its extension, like a Save dialog
    el.setSelectionRange(0, suggested.replace(/\.pdf$/i, '').length)
  }, [suggested])
  const ok = name.trim().length > 0
  return (
    <Modal
      title="Save PDF"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={() => onSave(name)}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) onSave(name)
        }}
      >
        <label htmlFor="save-as-name" className="mb-1.5 block text-[13px] font-medium text-ink">
          File name
        </label>
        <input
          id="save-as-name"
          ref={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          className="h-9 w-full border border-line bg-white px-2.5 text-[13.5px] text-ink focus:border-ink focus:outline-none"
        />
        <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted">
          This browser saves to your Downloads folder (or asks where, if that is set in its download settings). In Chrome or Edge you can pick the folder here.
        </p>
      </form>
    </Modal>
  )
}
