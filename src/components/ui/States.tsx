/**
 * Loading and empty states, shared so every screen says "loading" and
 * "nothing here yet" the same way.
 *
 * Skeletons only stand in for the FIRST load. Before it lands the in-memory
 * book is empty, so a module would announce "No employees" to a company with
 * forty — a lie that looks like data loss. A later refresh keeps the old rows
 * on screen instead, which is less jarring than blanking them.
 */
import React from 'react';

/** One shimmering block. Size it with classes; it carries no meaning to a screen reader. */
export const Skeleton = ({ className = '' }: { className?: string }) => (
  <div aria-hidden="true" className={`skeleton rounded-md ${className}`} />
);

/** List rows: avatar, two lines, a trailing figure. */
export const SkeletonRows = ({ rows = 5 }: { rows?: number }) => (
  <div aria-hidden="true" className="divide-y divide-ink-100 dark:divide-ink-800">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex items-center gap-3 px-4 py-3.5">
        <Skeleton className="w-8 h-8 rounded-lg shrink-0" />
        <div className="flex-1 min-w-0 space-y-1.5">
          {/* Varied widths: identical bars read as a pattern, not as rows of text. */}
          <Skeleton className={`h-3 ${['w-2/5', 'w-1/2', 'w-1/3', 'w-3/5', 'w-2/5'][i % 5]}`} />
          <Skeleton className={`h-2.5 ${['w-1/4', 'w-1/3', 'w-1/5', 'w-1/4', 'w-2/5'][i % 5]}`} />
        </div>
        <Skeleton className="h-3 w-16 shrink-0" />
      </div>
    ))}
  </div>
);

/** A module's first paint: title, actions, filter bar, then rows. */
export const ModuleSkeleton = ({ label }: { label: string }) => (
  <div role="status" aria-live="polite" className="space-y-5">
    <span className="sr-only">Loading {label}…</span>
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-64 max-w-full" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-10 w-32 rounded-lg" />
        <Skeleton className="h-10 w-40 rounded-lg" />
      </div>
    </div>
    <Skeleton className="h-10 w-full max-w-md rounded-lg" />
    <div className="rounded-xl border border-ink-200 dark:border-ink-800 bg-white dark:bg-ink-900 overflow-hidden">
      <SkeletonRows rows={6} />
    </div>
  </div>
);

/**
 * Nothing to show. `title` says what is missing, `body` what to do about it,
 * and `action` does it — an empty screen is where a new user learns the app.
 */
export function EmptyState({
  icon, title, body, action, compact = false,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: React.ReactNode;
  action?: { label: string; onClick: () => void; icon?: React.ReactNode };
  compact?: boolean;
}) {
  return (
    <div className={`text-center px-6 ${compact ? 'py-8' : 'py-14'}`}>
      {icon && (
        <div className="mx-auto mb-3 w-11 h-11 rounded-2xl flex items-center justify-center bg-brand-50 dark:bg-brand-950/50 text-brand-600 dark:text-brand-400 [&_svg]:w-5 [&_svg]:h-5">
          {icon}
        </div>
      )}
      <p className="text-sm font-bold text-ink-900 dark:text-white">{title}</p>
      {body && <p className="text-xs text-ink-500 dark:text-ink-400 mt-1 max-w-xs mx-auto leading-relaxed">{body}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="tap mt-4 inline-flex items-center justify-center gap-1.5 px-4 rounded-full text-xs font-bold cursor-pointer transition-colors bg-brand-600 hover:bg-brand-700 active:bg-brand-800 text-white shadow-sm [&_svg]:w-3.5 [&_svg]:h-3.5"
        >
          {action.icon}
          {action.label}
        </button>
      )}
    </div>
  );
}
