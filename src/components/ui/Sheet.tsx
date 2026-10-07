/**
 * Sheet.tsx — one dialog for the whole product.
 *
 * Phone: a bottom sheet. It rises from the thumb, keeps its header and its
 * actions pinned, and scrolls only the body, so Save is reachable without
 * scrolling a long form to the end and without the on-screen keyboard burying
 * it. Tablet and up: a centred card, which is what a pointer expects.
 *
 * It portals to <body> because several of these open from inside scrolling
 * panels, where a positioned overlay gets clipped by its ancestor.
 */
import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type MaxWidth = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl';

const MAX_W: Record<MaxWidth, string> = {
  sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-lg',
  xl: 'sm:max-w-xl', '2xl': 'sm:max-w-2xl', '3xl': 'sm:max-w-3xl',
  '4xl': 'sm:max-w-4xl', '5xl': 'sm:max-w-5xl', '6xl': 'sm:max-w-6xl',
};

export function Sheet({
  title, subtitle, icon, onClose, footer, maxWidth = 'lg',
  dismissOnBackdrop = true, children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  maxWidth?: MaxWidth;
  dismissOnBackdrop?: boolean;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Lock the page behind the sheet. Without this, iOS scrolls the page under
    // the sheet and the user loses their place in a long list.
    const { overflow, paddingRight } = document.body.style;
    const gutter = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (gutter > 0) document.body.style.paddingRight = `${gutter}px`;

    // Focus the first real control, not the close button, so keyboard users
    // land where the work is.
    const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );
    const first = Array.from<HTMLElement>(focusables || []).find(el => !el.hasAttribute('data-sheet-close'));
    (first || panelRef.current)?.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !focusables?.length) return;
      // Keep Tab inside the dialog; a dialog that lets focus wander behind the
      // backdrop is unusable with a keyboard or a screen reader.
      const list = Array.from<HTMLElement>(
        panelRef.current!.querySelectorAll<HTMLElement>(
          'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(el => el.offsetParent !== null);
      if (!list.length) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [onClose]);

  return createPortal(
    <div
      data-chrome
      className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4"
      onMouseDown={e => { if (dismissOnBackdrop && e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-ink-950/60 backdrop-blur-[2px] animate-fade-in" aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`
          relative w-full ${MAX_W[maxWidth]}
          flex flex-col max-h-[92dvh] sm:max-h-[88dvh]
          bg-ink-50 dark:bg-ink-900
          border-t border-ink-200 dark:border-ink-800
          sm:border sm:rounded-2xl
          rounded-t-[var(--radius-sheet)]
          shadow-sheet sm:shadow-xl
          animate-sheet-up sm:animate-sheet-in
          focus:outline-none
        `}
      >
        {/* Grab affordance — phone only. It says "this came from the bottom and
            can go back there", which a centred card never needs to say. */}
        <div className="sm:hidden pt-2.5 pb-1 flex justify-center flex-shrink-0">
          <span className="h-1 w-9 rounded-full bg-ink-300 dark:bg-ink-700" />
        </div>

        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 pt-2 sm:pt-4 pb-3 border-b border-ink-200 dark:border-ink-800 flex-shrink-0">
          <div className="flex items-start gap-2 min-w-0">
            {icon && <span className="mt-0.5 flex-shrink-0 text-brand-600 dark:text-brand-300">{icon}</span>}
            <div className="min-w-0">
              <h2 id={titleId} className="text-sm font-bold text-ink-900 dark:text-ink-50 truncate">{title}</h2>
              {subtitle && (
                <p className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5">{subtitle}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            data-sheet-close
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="tap -mr-2 -mt-1 flex items-center justify-center rounded-lg text-ink-500 dark:text-ink-400 hover:text-ink-900 dark:hover:text-ink-50 hover:bg-ink-100 dark:hover:bg-ink-800 transition-colors cursor-pointer flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-5 py-4">
          {children}
        </div>

        {footer && (
          <div className="flex-shrink-0 px-4 sm:px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3 border-t border-ink-200 dark:border-ink-800 bg-ink-100/80 dark:bg-ink-950/50 backdrop-blur-sm rounded-b-2xl">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The two button shapes every sheet footer uses, so Save looks the same everywhere. */
export const sheetBtn = {
  primary:
    'inline-flex items-center justify-center gap-1.5 tap px-4 py-2.5 rounded-full bg-brand-600 hover:bg-brand-700 active:bg-brand-800 disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold text-xs shadow-sm transition-colors cursor-pointer',
  ghost:
    'inline-flex items-center justify-center gap-1.5 tap px-4 py-2.5 rounded-xl border border-ink-300 dark:border-ink-700 text-ink-700 dark:text-ink-200 hover:bg-ink-100 dark:hover:bg-ink-800 font-bold text-xs transition-colors cursor-pointer',
  danger:
    'inline-flex items-center justify-center gap-1.5 tap px-4 py-2.5 rounded-full bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs shadow-sm transition-colors cursor-pointer',
};
