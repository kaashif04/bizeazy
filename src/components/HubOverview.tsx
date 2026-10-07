/**
 * HubOverview.tsx — the first screen: the branch's totals, the next tap, each
 * module at a glance, then the latest invoices and payslips.
 */
import React, { useMemo } from 'react';
import { FileText, CalendarRange, Wallet, BarChart3, ChevronRight, FilePlus2, CalendarPlus, TrendingUp, Clock, Users } from 'lucide-react';
import { DatabaseState, CompanyProfile } from '../types';
import { getPaymentSummary, PAYMENT_STATUS_LABEL } from '../utils/payments';
import { activeOutlet as resolveActiveOutlet, outletLabel } from '../utils/outlets';
import { Skeleton, EmptyState } from './ui/States';

type View = 'hub' | 'invoicing' | 'quotations' | 'payroll' | 'reports';
/** A quick action can open a module straight into its new-item form. */
export type Intent = { create?: boolean };

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

const LABEL = 'text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400';
const CARD = 'rounded-2xl bg-white dark:bg-ink-900';
const ICON_WELL = 'w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-ink-50 dark:bg-ink-800 shadow-[inset_1px_1px_3px_var(--nm-sh),inset_-1px_-1px_3px_var(--nm-hl)]';

const STATUS_PILL = {
  Paid:    { pill: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300', dot: 'bg-emerald-500' },
  Partial: { pill: 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300', dot: 'bg-amber-500' },
  Unpaid:  { pill: 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', dot: 'bg-rose-500' },
} as const;

/** "2026-09-01T…" or "September 2026" → "September 2026". */
function payslipMonth(raw: string): string {
  if (/^\d{4}-\d{2}/.test(raw)) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });
  }
  return raw || '-';
}

export function HubOverview({
  db, profiles, activeBranchLocation, allowed, loading, onNavigate, onOpenInvoice, banner,
}: {
  db: DatabaseState;
  profiles: CompanyProfile[];
  activeBranchLocation: string;
  allowed: (v: View) => boolean;
  loading: boolean;
  onNavigate: (v: View, intent?: Intent) => void;
  onOpenInvoice: (invoiceId: string) => void;
  /** Anything that must sit above the fold (a load error, a recovery-code nudge). */
  banner?: React.ReactNode;
}) {
  const profile = resolveActiveOutlet(profiles, activeBranchLocation) || profiles[0];
  const branchId = profile?.id || activeBranchLocation;
  const branch = profile ? outletLabel(profile) : activeBranchLocation;
  const currency = profile?.currency_symbol || 'RM';

  const t = useMemo(() => {
    const invoices = db.invoices.filter(i => i.Company === branchId);
    let invoiced = 0, collected = 0, pending = 0, paid = 0, unpaid = 0;
    for (const i of invoices) {
      const sum = getPaymentSummary(i, db.payments);
      invoiced += Number(i.Total_Amount) || 0;
      collected += sum.paid;
      pending += sum.balance;
      if (sum.status === 'Paid') paid++; else unpaid++;
    }
    const quotations = (db.quotations || []).filter(q => q.Company === branchId);
    const todayStr = new Date().toDateString();
    const expired = quotations.filter(q => !!q.Valid_Until && new Date(q.Valid_Until) < new Date(todayStr)).length;
    const employees = (db.employees || []).filter(e => e.Assigned_Outlet === branchId);
    const payslips = (db.payslips || []).filter(p => p.Is_Saved);
    const latest = [...invoices].sort((a, b) => (b.Date || '').localeCompare(a.Date || '')).slice(0, 5);
    const recentPayslips = [...payslips].sort((a, b) => (b.Issue_Date || '').localeCompare(a.Issue_Date || '')).slice(0, 4);
    return { invoices, invoiced, collected, pending, paid, unpaid, quotations, expired, employees, payslips, latest, recentPayslips };
  }, [db, branchId]);

  const quick = QUICK.filter(q => allowed(q.view));

  const stats = [
    { label: 'Total invoiced', value: t.invoiced, sub: `${t.invoices.length} invoice${t.invoices.length === 1 ? '' : 's'}`, Icon: FileText, tone: 'text-brand-600 dark:text-brand-300' },
    { label: 'Collected', value: t.collected, sub: `${t.paid} paid`, Icon: TrendingUp, tone: 'text-emerald-600 dark:text-emerald-400' },
    { label: 'Outstanding', value: t.pending, sub: `${t.unpaid} unpaid`, Icon: Clock, tone: 'text-amber-600 dark:text-amber-400' },
    { label: 'Active staff', count: t.employees.length, sub: `${t.payslips.length} saved payslips`, Icon: Users, tone: 'text-brand-600 dark:text-brand-300' },
  ];

  const modules = ([
    { view: 'invoicing', label: 'Invoicing', desc: 'Create, manage and track invoices', Icon: FileText,
      a: ['Invoices', t.invoices.length, false], b: ['Unpaid', t.unpaid, t.unpaid > 0] },
    { view: 'quotations', label: 'Quotations', desc: 'Multi-day catering quotes and estimates', Icon: CalendarRange,
      a: ['Quotations', t.quotations.length, false], b: ['Expired', t.expired, t.expired > 0] },
    { view: 'payroll', label: 'Payroll', desc: 'Staff roster and payslips', Icon: Wallet,
      a: ['Staff', t.employees.length, false], b: ['Payslips', t.payslips.length, false] },
  ] as const).filter(m => allowed(m.view));

  return (
    <div className="max-w-6xl mx-auto space-y-6 sm:space-y-8 pb-8">
      {banner}

      {/* ── Totals for the branch ── */}
      <section aria-label={`Totals for ${branch}`} className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {stats.map(({ label, value, count, sub, Icon, tone }, i) => (
          <div key={label} style={{ animationDelay: `${i * 40}ms` }} className={`${CARD} row-enter p-4 sm:p-5 min-w-0`}>
            <span className={`${ICON_WELL} ${tone} mb-3`}><Icon className="w-4 h-4" /></span>
            {loading
              ? <Skeleton className="h-6 w-24" />
              : count !== undefined
                ? <p className="text-xl sm:text-2xl font-semibold tracking-tight leading-none text-ink-900 dark:text-white tabular-nums">{count}</p>
                : <Money value={value ?? 0} currency={currency} className="block text-xl sm:text-2xl font-semibold tracking-tight leading-none text-ink-900 dark:text-white truncate" />}
            <p className={`${LABEL} mt-2`}>{label}</p>
            {loading ? <Skeleton className="h-3 w-16 mt-1.5" /> : <p className="text-xs text-ink-500 dark:text-ink-400 mt-0.5">{sub}</p>}
          </div>
        ))}
      </section>

      {/* ── Quick actions ── */}
      {quick.length > 0 && (
        <nav aria-label="Quick actions" className="grid grid-cols-4 gap-2 sm:gap-4 max-w-md">
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

      {/* ── Each module at a glance ── */}
      {modules.length > 0 && (
        <section aria-label="Modules" className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {modules.map(({ view, label, desc, Icon, a, b }) => (
            <button key={view} type="button" onClick={() => onNavigate(view)}
              className={`${CARD} group flex flex-col justify-start p-4 sm:p-5 text-left cursor-pointer transition-shadow hover:shadow-md active:scale-[0.99] min-w-0`}>
              <span className="flex items-start justify-between mb-3">
                <span className={`${ICON_WELL} text-brand-600 dark:text-brand-300`}><Icon className="w-4 h-4" /></span>
                <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
                  Open <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </span>
              <span className="block text-sm font-bold text-ink-900 dark:text-white">{label}</span>
              <span className="block text-xs text-ink-500 dark:text-ink-400 mt-0.5 mb-4">{desc}</span>
              <span className="grid grid-cols-2 gap-2">
                {[a, b].map(([l, v, warn]) => (
                  <span key={l} className="rounded-xl px-3 py-2.5 bg-ink-50 dark:bg-ink-800 shadow-[inset_1px_1px_3px_var(--nm-sh),inset_-1px_-1px_3px_var(--nm-hl)]">
                    {loading
                      ? <Skeleton className="h-5 w-8" />
                      : <span className={`block text-lg font-semibold leading-none tabular-nums ${warn ? 'text-amber-700 dark:text-amber-300' : 'text-ink-900 dark:text-white'}`}>{v}</span>}
                    <span className={`block ${LABEL} mt-1`}>{l}</span>
                  </span>
                ))}
              </span>
            </button>
          ))}
        </section>
      )}

      {/* ── Recent activity ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {allowed('invoicing') && (
          <section aria-labelledby="recent-invoices" className={`${CARD} lg:col-span-2 min-w-0 overflow-hidden`}>
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <div>
                <h2 id="recent-invoices" className={LABEL}>Recent invoices</h2>
                <p className="text-xs text-ink-500 dark:text-ink-400">{branch}</p>
              </div>
              <button type="button" onClick={() => onNavigate('invoicing')}
                className="text-xs font-semibold text-brand-700 dark:text-brand-300 hover:underline cursor-pointer min-h-11 px-1">See all</button>
            </div>
            {loading ? (
              <div className="p-5 space-y-3">{[0, 1, 2].map(i => <div key={i}><Skeleton className="h-9" /></div>)}</div>
            ) : t.latest.length === 0 ? (
              <EmptyState compact icon={<FileText />} title="No invoices yet"
                body={`The latest invoices for ${branch} will show here.`}
                action={{ label: 'New invoice', onClick: () => onNavigate('invoicing', { create: true }) }} />
            ) : (
              <ul className="divide-y divide-ink-100 dark:divide-ink-800">
                {t.latest.map(inv => {
                  const st = getPaymentSummary(inv, db.payments).status;
                  const sp = STATUS_PILL[st];
                  return (
                    <li key={inv.Invoice_ID}>
                      <button type="button" onClick={() => onOpenInvoice(inv.Invoice_ID)}
                        className="w-full flex items-center gap-3 px-5 py-3 text-left cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800/50 transition-colors">
                        <span className={`${ICON_WELL} text-ink-500 dark:text-ink-400`}><FileText className="w-4 h-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-ink-900 dark:text-white truncate">{inv.Customer_Name || 'Walk-in'}</span>
                          <span className="block text-xs text-ink-500 dark:text-ink-400 tabular-nums truncate">{inv.Invoice_ID} · {inv.Date?.split('T')[0] || '-'}</span>
                        </span>
                        <span className="text-right shrink-0">
                          <Money value={Number(inv.Total_Amount) || 0} currency={currency} className="block text-sm font-semibold text-ink-900 dark:text-white" />
                          <span className={`inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded-full text-2xs font-bold ${sp.pill}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${sp.dot}`} />{PAYMENT_STATUS_LABEL[st]}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {allowed('payroll') && (
          <section aria-labelledby="saved-payslips" className={`${CARD} min-w-0 overflow-hidden`}>
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <h2 id="saved-payslips" className={LABEL}>Saved payslips</h2>
              <button type="button" onClick={() => onNavigate('payroll')}
                className="text-xs font-semibold text-brand-700 dark:text-brand-300 hover:underline cursor-pointer min-h-11 px-1">See all</button>
            </div>
            {loading ? (
              <div className="p-5 space-y-3">{[0, 1, 2].map(i => <div key={i}><Skeleton className="h-9" /></div>)}</div>
            ) : t.recentPayslips.length === 0 ? (
              <EmptyState compact icon={<Users />} title="No payslips yet"
                body="Generate the month's payslips in Payroll. Saved ones show here."
                action={{ label: 'Open Payroll', onClick: () => onNavigate('payroll') }} />
            ) : (
              <ul className="divide-y divide-ink-100 dark:divide-ink-800">
                {t.recentPayslips.map(ps => {
                  const emp = db.employees?.find(e => e.Employee_ID === ps.Employee_ID);
                  return (
                    <li key={ps.Payslip_ID} className="flex items-center justify-between gap-3 px-5 py-3">
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink-900 dark:text-white truncate">{emp?.Employee_Name || ps.Employee_ID}</span>
                        <span className="block text-xs text-ink-500 dark:text-ink-400">{payslipMonth(ps.Month_Year || ps.Issue_Date || '')}</span>
                      </span>
                      <Money value={Number(ps.Final_Net_Pay) || 0} currency={currency} className="text-sm font-semibold text-ink-900 dark:text-white shrink-0" />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
