import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { ArrowUpRight, X } from 'lucide-react'

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'inverse' | 'inverse-ghost'
  size?: 'sm' | 'md' | 'lg'
}

/** Square, high-contrast buttons in the Anduin style. */
export function Button({ variant = 'secondary', size = 'md', className = '', ...rest }: BtnProps) {
  const base = 'inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap transition-colors select-none disabled:opacity-40'
  const sizes = { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3 text-[13px]', lg: 'h-11 px-5 text-[15px]' }
  const variants = {
    primary: 'bg-ink text-white hover:bg-ink-2 disabled:hover:bg-ink',
    secondary: 'bg-white text-ink border border-line hover:border-ink disabled:hover:border-line',
    ghost: 'text-ink-soft hover:bg-ink/5 hover:text-ink disabled:hover:bg-transparent',
    danger: 'bg-white text-[#c2412a] border border-line hover:border-coral hover:bg-coral-soft',
    inverse: 'bg-white text-ink hover:bg-[#ececec]',
    'inverse-ghost': 'text-white/75 hover:text-white hover:bg-white/10 disabled:hover:bg-transparent',
  }
  return <button type="button" className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest} />
}

/** The site's signature call-to-action: label + square arrow block. */
export function CtaButton({ children, dark = true, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { dark?: boolean }) {
  return (
    <button
      type="button"
      className={`group inline-flex h-10 items-center gap-4 pl-4 pr-1 text-[14px] font-medium transition-colors disabled:opacity-40 ${
        dark ? 'bg-ink text-white hover:bg-ink-2' : 'bg-white text-ink hover:bg-[#ececec]'
      } ${className}`}
      {...rest}
    >
      {children}
      <span className={`flex h-8 w-8 items-center justify-center ${dark ? 'bg-white text-ink' : 'bg-ink text-white'}`}>
        <ArrowUpRight size={16} strokeWidth={2} className="transition-transform group-hover:translate-x-px group-hover:-translate-y-px" />
      </span>
    </button>
  )
}

interface ToolBtnProps {
  icon: ReactNode
  label: string
  title?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  iconOnly?: boolean
}

export function ToolBtn({ icon, label, title, active, disabled, onClick, iconOnly }: ToolBtnProps) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 px-2 text-[13px] font-medium transition-colors disabled:opacity-35 ${
        active ? 'bg-ink text-white' : 'text-ink-soft hover:bg-ink/5 hover:text-ink disabled:hover:bg-transparent'
      }`}
    >
      {icon}
      {!iconOnly && <span className="hidden xl:inline">{label}</span>}
    </button>
  )
}

export const Divider = () => <div className="mx-1.5 h-5 w-px shrink-0 bg-line" />

export function Eyebrow({ children, sky, className = '' }: { children: ReactNode; sky?: boolean; className?: string }) {
  return <span className={`eyebrow ${sky ? 'sky' : ''} ${className}`}>{children}</span>
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[88vh] w-full flex-col border border-line bg-white shadow-[0_24px_64px_-16px_rgba(0,0,0,0.35)] outline-none ${wide ? 'max-w-3xl' : 'max-w-md'}`}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="tight text-[16px] font-semibold text-ink">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 text-muted hover:bg-ink/5 hover:text-ink">
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-wash px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

/** Small dropdown menu (used for rarely-needed developer options). */
export interface MenuItem {
  label: string
  hint?: string
  checked?: boolean
  disabled?: boolean
  /** A non-interactive section heading. */
  heading?: boolean
  onClick?: () => void
}

export function Menu({ trigger, items }: { trigger: (open: () => void) => ReactNode; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((v) => !v))}
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-40 min-w-[260px] border border-line bg-white py-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.25)]">
          {items.map((it) =>
            it.heading ? (
              <div key={it.label} className="mt-1 border-t border-line-soft px-3 pb-1 pt-2.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted first:mt-0 first:border-t-0">
                {it.label}
              </div>
            ) : (
            <button
              key={it.label}
              role="menuitemcheckbox"
              aria-checked={it.checked}
              type="button"
              disabled={it.disabled}
              onClick={() => {
                setOpen(false)
                it.onClick?.()
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-ink hover:bg-wash disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent"
            >
              <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${it.checked ? 'border-ink bg-ink' : it.checked === false ? 'border-line' : 'border-transparent'}`}>
                {it.checked && <span className="h-1.5 w-1.5 bg-white" />}
              </span>
              <span className="flex-1">{it.label}</span>
              {it.hint && <span className="font-mono text-[10.5px] text-muted">{it.hint}</span>}
            </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

/** Lays out children inside a box that is rotated with CSS, reserving the rotated footprint. */
export function Rotated({ w, h, rotation, children }: { w: number; h: number; rotation: number; children: ReactNode }) {
  const swap = rotation % 180 !== 0
  const ow = swap ? h : w
  const oh = swap ? w : h
  return (
    <div style={{ position: 'relative', width: ow, height: oh }}>
      <div
        style={{
          position: 'absolute',
          width: w,
          height: h,
          left: (ow - w) / 2,
          top: (oh - h) / 2,
          transform: rotation ? `rotate(${rotation}deg)` : undefined,
          transformOrigin: '50% 50%',
        }}
      >
        {children}
      </div>
    </div>
  )
}
