/**
 * HubOverview.tsx — the first screen: money, what needs you, and the next tap.
 *
 * The money field reads like a payment-success screen: one confident amount,
 * confirmed. Its figures come from utils/reports.ts, the same functions the
 * Reports view uses, so the Hub and Reports can never disagree.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, CalendarRange, Wallet, BarChart3, ChevronRight, FilePlus2, CalendarPlus } from 'lucide-react';
import { DatabaseState, CompanyProfile } from '../types';
import { AppNotification } from '../utils/notifications';
import { getPaymentSummary, PAYMENT_STATUS_LABEL } from '../utils/payments';
import { activeOutlet as resolveActiveOutlet, outletLabel } from '../utils/outlets';
import { lastMonths, salesByBranch, receivablesAging, payrollCost, monthTitle } from '../utils/reports';
import { Skeleton } from './ui/States';

type View = 'hub' | 'invoicing' | 'quotations' | 'payroll' | 'reports';
/** A quick action can open a module straight into its new-item form. */
export type Intent = { create?: boolean };

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Counts up to `value` once it arrives: a payment landing, not a number appearing. */
function useCountUp(value: number, ms = 300): number {
  const [shown, setShown] = useState(prefersReducedMotion() ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (prefersReducedMotion()) { setShown(value); return; }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 4);
      setShown(origin + (value - origin) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return shown;
}

/** RM 12,450.50 with the cents set smaller, as payment screens do. */
export function Money({ value, currency, className = '', centsClass = '' }: {
  value: number; currency: string; className?: string; centsClass?: string;
}) {
  const [whole, cents] = value.toFixed(2).split('.');
  return (
    <span className={`tabular-nums ${className}`}>
      <span className="text-[0.5em] font-bold align-[0.55em] mr-1 opacity-80">{currency}</span>
      {Number(whole).toLocaleString('en-MY')}
      <span className={`text-[0.55em] font-bold opacity-80 ${centsClass}`}>.{cents}</span>
    </span>
  );
}

/** A tick that draws itself — the world's one confirming gesture. */
export function DrawnTick({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="11" className="fill-current opacity-15" />
      <path d="M7 12.5l3.2 3.2L17 9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
        className="tick-draw" pathLength={1} />
    </svg>
  );
}

// Verbs, not destinations: the tab bar already goes places; these do things.
const QUICK: { view: View; label: string; Icon: React.FC<React.SVGProps<SVGSVGElement>>; create?: boolean }[] = [
  { view: 'invoicing', label: 'New invoice', Icon: FilePlus2, create: true },
  { view: 'quotations', label: 'New quote', Icon: CalendarPlus, create: true },
  { view: 'payroll', label: 'Payslips', Icon: Wallet },
  { view: 'reports', label: 'Reports', Icon: BarChart3 },
];

// Urgency: coral is late, amber is waiting, blue is just so you know.
const SEVERITY = {
  danger:  { tone: 'text-rose-700 dark:text-rose-300', pill: 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', dot: 'bg-rose-600' },
  warning: { tone: 'text-amber-800 dark:text-amber-300', pill: 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300', dot: 'bg-amber-500' },
  info:    { tone: 'text-brand-700 dark:text-brand-300', pill: 'bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300', dot: 'bg-brand-500' },
} as const;
const KIND_ICON: Record<AppNotification['kind'], React.FC<React.SVGProps<SVGSVGElement>>> = {
  'salary-due': Wallet, 'salary-overdue': Wallet, 'invoice-overdue': FileText,
  'quotation-expiring': CalendarRange, 'quotation-expired': CalendarRange,
};

export function HubOverview({
  db, profiles, activeBranchLocation, notifications, allowed, loading, onNavigate, onOpenInvoice, banner,
}: {
  db: DatabaseState;
  profiles: CompanyProfile[];
  activeBranchLocation: string;
  notifications: AppNotification[];
  allowed: (v: View) => boolean;
  loading: boolean;
  onNavigate: (v: View, intent?: Intent) => void;
  onOpenInvoice: (invoiceId: string) => void;
  /** Anything that must sit above the fold (a load error, a recovery-code nudge). */
  banner?: React.ReactNode;
}) {
  const profile = resolveActiveOutlet(profiles, activeBranchLocation) || profiles[0];
  const branch = profile ? outletLabel(profile) : activeBranchLocation;
  const currency = profile?.currency_symbol || 'RM';
  const today = useMemo(() => new Date(), []);
  const [thisMonth] = useMemo(() => lastMonths(today, 1), [today]);
  const canSales = allowed('invoicing');

  const sales = useMemo(() => salesByBranch(db, profiles, [thisMonth]), [db, profiles, thisMonth]);
  const salesRow = sales.rows.find(r => r.branch === branch) || sales.total;
  const aging = useMemo(() => receivablesAging(db, profiles, today), [db, profiles, today]);
  const owed = (aging.rows.find(r => r.branch === branch) || { total: 0, count: 0 });
  const payroll = useMemo(() => payrollCost(db, lastMonths(today, 2)), [db, today]);

  const collected = useCountUp(loading ? 0 : salesRow.collected[0]);
  const invoiced = salesRow.invoiced[0];
  // How much of THIS month's invoicing is paid. Not collected ÷ invoiced: this
  // month's collections include money for older invoices, which would overstate it.
  const paidOfThisMonth = useMemo(() => db.invoices
    .filter(i => (!profile || i.Company === profile.id) && (i.Date || '').startsWith(thisMonth))
    .reduce((sum, i) => sum + getPaymentSummary(i, db.payments).paid, 0), [db, profile, thisMonth]);
  const progress = invoiced > 0 ? Math.min(1, paidOfThisMonth / invoiced) : 0;

  const latest = useMemo(() => db.invoices
    .filter(i => !profile || i.Company === profile.id)
    .sort((a, b) => (b.Date || '').localeCompare(a.Date || ''))
    .slice(0, 5), [db.invoices, profile]);

  const quick = QUICK.filter(q => allowed(q.view));
  const needs = notifications.slice(0, 5);

  return (
    <div className="max-w-5xl mx-auto">
      {/* ── The money field ── */}
      <section
        aria-label={canSales ? `Money this month at ${branch}` : 'Payroll'}
        className="rounded-[1.75rem] bg-white dark:bg-ink-900 shadow-lg text-ink-900 dark:text-white px-5 sm:px-8 pt-6 pb-16 sm:pb-20"
      >
        <div>
          {canSales ? (
            <div className="grid gap-5 sm:grid-cols-[1.4fr_1fr_1fr] sm:items-end">
              <div>
                <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">Collected in {monthTitle(thisMonth)}</p>
                {loading
                  ? <span className="block mt-2 h-11 w-52 rounded-lg bg-ink-100 dark:bg-ink-800 animate-pulse" />
                  : <Money value={collected} currency={currency} className="block mt-2 text-[2.75rem] sm:text-6xl font-semibold leading-none tracking-[-0.03em]" />}
                <div className="mt-4 h-2.5 rounded-full bg-ink-100 dark:bg-ink-800 shadow-[inset_1px_1px_3px_var(--nm-sh),inset_-1px_-1px_3px_var(--nm-hl)] overflow-hidden" aria-hidden="true">
                  <div className="h-full rounded-full bg-brand-600 dark:bg-brand-400 origin-left progress-grow" style={{ transform: `scaleX(${progress})` }} />
                </div>
                <p className="mt-1.5 text-xs text-ink-500 dark:text-ink-400">
                  {invoiced > 0 ? `${Math.round(progress * 100)}% of this month's invoices paid` : 'No invoices raised yet this month'}
                </p>
              </div>
              <div className="flex sm:block gap-6">
                <div>
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">Owed to you</p>
                  <Money value={owed.total} currency={currency} className="block text-xl sm:text-2xl font-semibold leading-tight tracking-tight" />
                  <p className="text-xs text-ink-500 dark:text-ink-400">{owed.count} unpaid invoice{owed.count === 1 ? '' : 's'}</p>
                </div>
                <div className="sm:hidden">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">Invoiced</p>
                  <Money value={invoiced} currency={currency} className="block text-xl font-semibold leading-tight tracking-tight" />
                </div>
              </div>
              <div className="hidden sm:block">
                <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">Invoiced this month</p>
                <Money value={invoiced} currency={currency} className="block text-2xl font-semibold leading-tight tracking-tight" />
                <p className="text-xs text-ink-500 dark:text-ink-400">by invoice date</p>
              </div>
            </div>
          ) : (
            <div>
              <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">Payroll cost last month</p>
              <Money value={payroll[0].cost} currency={currency} className="block mt-2 text-[2.75rem] font-semibold leading-none tracking-[-0.03em]" />
              <p className="mt-2 text-xs text-ink-500 dark:text-ink-400">{payroll[0].staff} payslip{payroll[0].staff === 1 ? '' : 's'} saved · {monthTitle(payroll[0].month)}</p>
            </div>
          )}
        </div>
      </section>

      <div>
        {/* ── Quick actions, riding the field's edge ── */}
        {quick.length > 0 && (
          <nav aria-label="Quick actions" className="-mt-10 relative px-3 sm:px-6 grid grid-cols-4 gap-2 sm:gap-4 max-w-md">
            {quick.map(({ view, label, Icon, create }) => (
              <button key={view} type="button" onClick={() => onNavigate(view, { create })}
                className="group flex flex-col items-center gap-1.5 cursor-pointer">
                <span className="w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white dark:bg-ink-800 shadow-md flex items-center justify-center text-brand-600 dark:text-brand-300 transition-transform duration-150 ease-out group-hover:-translate-y-0.5 group-active:scale-95">
                  <Icon className="w-6 h-6" />
                </span>
                <span className="text-xs font-medium text-ink-700 dark:text-ink-200 text-center leading-tight">{label}</span>
              </button>
            ))}
          </nav>
        )}

        {banner && <div className="mt-6">{banner}</div>}

        <div className="mt-7 grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr] pb-8">
          {/* ── Needs you ── */}
          <section aria-labelledby="needs-you" className="min-w-0">
            <h2 id="needs-you" className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400 mb-3">Needs you</h2>
            {loading ? (
              <div className="space-y-2">{[0, 1, 2].map(i => <div key={i}><Skeleton className="h-16 rounded-2xl" /></div>)}</div>
            ) : needs.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl bg-white dark:bg-ink-900 shadow-sm px-4 py-4">
                <DrawnTick className="w-10 h-10 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div>
                  <p className="text-sm font-bold text-ink-900 dark:text-white">All clear</p>
                  <p className="text-xs text-ink-500 dark:text-ink-400">No salary, invoice or quotation needs you right now.</p>
                </div>
              </div>
            ) : (
              <ul className="space-y-2">
                {needs.map((n, i) => {
                  const sev = SEVERITY[n.severity];
                  const KindIcon = KIND_ICON[n.kind];
                  return (
                    <li key={n.id} style={{ animationDelay: `${i * 40}ms` }} className="row-enter">
                      <button type="button" onClick={() => onNavigate(n.view)}
                        className="w-full flex items-center gap-3 rounded-2xl bg-white dark:bg-ink-900 shadow-sm px-4 py-3.5 text-left cursor-pointer transition-shadow hover:shadow-md active:scale-[0.99]">
                        <span className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${sev.tone} bg-current/10`}>
                          <KindIcon className="w-4 h-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-bold text-ink-900 dark:text-white truncate">{n.title}</span>
                          <span className="block text-xs text-ink-500 dark:text-ink-400 truncate">{n.detail}</span>
                        </span>
                        <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-bold whitespace-nowrap ${sev.pill}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${sev.dot}`} />{n.due}
                        </span>
                        <ChevronRight className="w-4 h-4 text-ink-400 shrink-0 hidden sm:block" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Latest invoices ── */}
          {canSales && (
            <section aria-labelledby="latest-invoices" className="min-w-0">
              <div className="flex items-baseline justify-between mb-3">
                <h2 id="latest-invoices" className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400">Latest invoices</h2>
                <button type="button" onClick={() => onNavigate('invoicing')}
                  className="text-xs font-bold text-brand-700 dark:text-brand-300 hover:underline cursor-pointer min-h-11 px-1">
                  See all
                </button>
              </div>
              <div className="rounded-2xl bg-white dark:bg-ink-900 shadow-sm overflow-hidden">
                {loading ? (
                  <div className="p-4 space-y-3">{[0, 1, 2].map(i => <div key={i}><Skeleton className="h-9" /></div>)}</div>
                ) : latest.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-ink-500 dark:text-ink-400">No invoices at {branch} yet.</p>
                ) : (
                  <ul className="divide-y divide-ink-100 dark:divide-ink-800">
                    {latest.map(inv => {
                      const st = getPaymentSummary(inv, db.payments).status;
                      const pill = st === 'Paid' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                        : st === 'Partial' ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                        : 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300';
                      const dot = st === 'Paid' ? 'bg-emerald-500' : st === 'Partial' ? 'bg-amber-500' : 'bg-rose-500';
                      return (
                        <li key={inv.Invoice_ID}>
                          <button type="button" onClick={() => onOpenInvoice(inv.Invoice_ID)}
                            className="w-full flex items-center gap-3 px-4 py-3 text-left cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800/50 transition-colors">
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-bold text-ink-900 dark:text-white truncate">{inv.Customer_Name || 'Walk-in'}</span>
                              <span className="block text-xs text-ink-500 dark:text-ink-400 tabular-nums">{inv.Invoice_ID} · {inv.Date?.split('T')[0]}</span>
                            </span>
                            <span className="text-right shrink-0">
                              <Money value={Number(inv.Total_Amount) || 0} currency={currency} className="block text-sm font-extrabold text-ink-900 dark:text-white" />
                              <span className={`inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded-full text-2xs font-bold ${pill}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{PAYMENT_STATUS_LABEL[st]}
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
