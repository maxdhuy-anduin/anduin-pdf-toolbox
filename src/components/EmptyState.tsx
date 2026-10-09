import { FileText, FolderOpen, ShieldCheck, Table2, Type } from 'lucide-react'
import { CtaButton, Eyebrow } from './ui'
import { PRIVACY_NOTE } from './StatusBar'

export function EmptyState({ onBrowse, onSample, dragging }: { onBrowse: () => void; onSample: () => void; dragging: boolean }) {
  return (
    <div className="relative flex flex-1 overflow-auto bg-white">
      {/* hairline grid, echoing the anduintransact.com hero */}
      <div className="pointer-events-none absolute inset-0 hidden md:block" aria-hidden>
        <div className="absolute inset-y-0 left-[33.333%] w-px bg-line-soft" />
        <div className="absolute inset-y-0 left-[66.666%] w-px bg-line-soft" />
      </div>
      <div className="relative mx-auto flex w-full max-w-6xl flex-col justify-center px-10 py-12">
        <Eyebrow sky>Anduin PDF Toolbox</Eyebrow>
        <h1 className="mt-5 max-w-3xl text-[44px] font-medium leading-[1.08] tracking-[-0.035em] text-ink">
          Edit PDFs as documents,
          <br />
          not as pictures of documents.
        </h1>
        <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-ink-soft">
          Open a PDF and edit its paragraphs, tables, lines and images directly. Reorder, insert and extract pages. Everything runs in your browser.
        </p>

        <div
          className={`mt-9 flex max-w-3xl flex-col gap-5 border p-6 transition-colors sm:flex-row sm:items-center ${dragging ? 'border-sky bg-sky-soft' : 'border-line bg-white'}`}
          onClick={onBrowse}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onBrowse()}
        >
          <div className="flex flex-1 items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center border border-line bg-wash text-ink">
              <FolderOpen size={22} strokeWidth={1.6} />
            </div>
            <div>
              <div className="tight text-[16px] font-semibold text-ink">{dragging ? 'Drop to open' : 'Drop a PDF here'}</div>
              <div className="text-[13px] text-muted">or choose a file from your computer</div>
            </div>
          </div>
          <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <CtaButton onClick={onBrowse}>Choose PDF</CtaButton>
            <span className="h-1.5 w-1.5 bg-ink" aria-hidden />
            <button type="button" onClick={onSample} className="h-10 border border-line px-4 text-[14px] font-medium text-ink transition-colors hover:border-ink">
              Try with sample document
            </button>
          </div>
        </div>

        <div className="mt-12 grid max-w-4xl gap-px border border-line bg-line sm:grid-cols-3">
          {[
            [Type, 'Understands content', 'Paragraphs, headings, lists, tables, cells, rules and images are detected as objects you can select, edit, move and delete.'],
            [Table2, 'Built for Digitization team documents', 'Subscription documents, side letters, AML/KYC forms and more. Tables are recognised cell by cell, with or without borders.'],
            [ShieldCheck, 'Private by design', PRIVACY_NOTE],
          ].map(([Icon, title, text]) => {
            const I = Icon as typeof Type
            return (
              <div key={title as string} className="bg-white p-5">
                <I size={18} strokeWidth={1.6} className="text-sky-deep" />
                <div className="tight mt-3 text-[15px] font-semibold text-ink">{title as string}</div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{text as string}</p>
              </div>
            )
          })}
        </div>
        <p className="mt-5 flex items-center gap-2 text-[12.5px] text-muted">
          <FileText size={14} />
          Works best with digitally generated PDFs. Scanned documents can be viewed and reorganised.
        </p>
      </div>
    </div>
  )
}
