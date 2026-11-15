/**
 * DocumentViewer.tsx — one viewer for every A4 document: invoice, quotation,
 * kitchen sheet, payslip.
 *
 * Phone and tablet: full screen, a slim toolbar under the status bar, the page
 * scaled to fit the width. Desktop: a large centred panel. Two actions, the same
 * everywhere: Save PDF (a real A4 file from utils/docPdf, to the share sheet on a
 * phone or tablet, downloaded on a desktop) and Print (the browser's own print,
 * with the print rules for `[data-print-root]` in index.css).
 *
 * The page itself is the child: `<div className="a4-page w-[794px] ...">`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Printer, Share, Download, Loader2 } from 'lucide-react';
import { attachA4Scale } from '../../utils/a4scale';
import { documentPdf, deliverPdf } from '../../utils/docPdf';

export function DocumentViewer({
  title, fileName, onClose, footer, children,
}: {
  title: string;
  fileName: string;
  onClose: () => void;
  /** Extra actions or status under the page, e.g. a payslip's Save. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // The PDF is drawn ahead of the tap, so the share sheet opens inside the tap:
  // iOS refuses navigator.share once the gesture has gone stale.
  const pdfRef = useRef<Blob | null>(null);
  const pending = useRef<Promise<Blob> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  const prepare = useCallback(() => {
    const page = stageRef.current?.querySelector<HTMLElement>('.a4-page');
    if (!page) return Promise.reject(new Error('Nothing to save yet.'));
    if (!pending.current) {
      const job = documentPdf(page);
      pending.current = job;
      job.then(b => { if (pending.current === job) pdfRef.current = b; }, () => { if (pending.current === job) pending.current = null; });
    }
    return pending.current;
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // The dialog itself takes focus: Escape and Tab work, and no ring is drawn
    // on the close button for a tap.
    rootRef.current?.focus({ preventScroll: true });
    // Hold the page behind still; on iOS it otherwise scrolls under the viewer.
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);

    const stage = stageRef.current;
    const page = stage?.querySelector('.a4-page');
    // Content edits (not the scaling transform, which is an attribute) make the drawn PDF stale.
    const mo = new MutationObserver(() => { pdfRef.current = null; pending.current = null; });
    if (page) mo.observe(page, { childList: true, subtree: true, characterData: true });
    const warm = window.setTimeout(() => { prepare().catch(() => { /* retried on tap */ }); }, 600);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      mo.disconnect();
      clearTimeout(warm);
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [prepare]);

  const save = async () => {
    setError('');
    try {
      let blob = pdfRef.current;
      if (!blob) { setBusy(true); blob = await prepare(); }
      await deliverPdf(blob, fileName);
    } catch {
      setError('Couldn’t make the PDF. Use Print instead, or try again.');
    } finally {
      setBusy(false);
    }
  };

  const setStage = useCallback((el: HTMLDivElement | null) => {
    stageRef.current = el;
    return attachA4Scale(el);
  }, []);

  const SaveIcon = touch ? Share : Download;

  return createPortal(
    <div
      ref={rootRef}
      data-print-root
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className="fixed inset-0 z-[60] flex bg-ink-950/70 lg:p-6 animate-fade-in focus:outline-none"
    >
      <div data-print-flow className="flex flex-col w-full h-full lg:max-w-5xl lg:mx-auto lg:rounded-2xl overflow-hidden bg-ink-800 shadow-2xl">
        <div className="no-print flex-shrink-0 bg-ink-900 text-white pt-safe">
          <div className="h-14 flex items-center gap-2 px-2 sm:px-4">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="tap flex items-center justify-center rounded-full text-ink-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
            <h2 className="flex-1 min-w-0 truncate text-sm font-bold tracking-tight">{title}</h2>
            <button
              type="button"
              onClick={() => window.print()}
              className="tap inline-flex items-center justify-center gap-1.5 px-3 rounded-full text-xs font-bold text-ink-100 hover:bg-white/10 transition-colors cursor-pointer flex-shrink-0"
            >
              <Printer className="w-4 h-4" />
              <span className="hidden sm:inline">Print</span>
              <span className="sr-only sm:hidden">Print</span>
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="tap inline-flex items-center justify-center gap-1.5 px-4 rounded-full bg-brand-500 hover:bg-brand-600 active:scale-[0.98] text-white text-xs font-bold transition disabled:opacity-70 cursor-pointer flex-shrink-0"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <SaveIcon className="w-4 h-4" />}
              {busy ? 'Preparing…' : touch ? 'Share PDF' : 'Save PDF'}
            </button>
          </div>
          {error && <p role="alert" className="px-4 pb-2 text-2xs font-semibold text-rose-300">{error}</p>}
        </div>

        <div data-print-flow ref={setStage} className="flex-1 min-h-0 overflow-auto overscroll-contain p-3 sm:p-6 lg:p-8">
          {/* The paper keeps its own palette and faces (index.css, [data-document]). */}
          <div data-print-flow data-document className="a4-spacer mx-auto">
            {children}
          </div>
        </div>

        {footer && (
          <div className="no-print flex-shrink-0 bg-ink-900 text-white px-3 sm:px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
