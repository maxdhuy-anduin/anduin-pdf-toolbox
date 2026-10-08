import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

export interface ToastItem {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

const styles = {
  info: { icon: Info, cls: 'text-sky-deep' },
  success: { icon: CheckCircle2, cls: 'text-emerald-600' },
  warning: { icon: AlertTriangle, cls: 'text-amber-600' },
  error: { icon: XCircle, cls: 'text-red-600' },
}

export function Toasts({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-12 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {items.map((t) => {
        const S = styles[t.kind]
        return (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex items-start gap-2.5 border border-line bg-white p-3 text-[13px] shadow-lg">
            <S.icon size={17} className={`mt-px shrink-0 ${S.cls}`} />
            <div className="min-w-0 flex-1 leading-snug text-ink">
              {t.text}
              {t.action && (
                <button type="button" className="ml-2 font-semibold text-sky-deep underline underline-offset-2" onClick={() => { t.action!.run(); dismiss(t.id) }}>
                  {t.action.label}
                </button>
              )}
            </div>
            <button type="button" aria-label="Dismiss" className="shrink-0 p-0.5 text-faint hover:bg-canvas hover:text-ink-soft" onClick={() => dismiss(t.id)}>
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
