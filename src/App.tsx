import React, { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import {
  loadAll, saveChanges, loadConfig, saveConfig, importSheetExport, forgetLoaded, EMPTY_DB, KINDS,
  backupJson, workbookSheets, recentChanges, Change,
  isBranchKey, payrollScopeOf, saveCompanySettings, PayrollScope,
} from './db';
import { buildXlsx, download, XLSX_TYPE } from './utils/xlsx';
import {
  Session, SessionUser, ModuleName, can, loadSession, refreshSession,
  logout as endSession, SIGNED_OUT_EVENT, recoveryStatus,
} from './auth';
import { LoginScreen, RegisterScreen } from './components/AuthScreens';
import { UsersModal } from './components/UsersModal';
import { CompanyProfilesModal, DEFAULT_TEMPLATE } from './components/CompanyProfilesModal';
import { NotificationBell } from './components/NotificationBell';
import { BottomNav } from './components/ui/BottomNav';
import { Sheet, sheetBtn } from './components/ui/Sheet';
import { Skeleton, SkeletonRows, ModuleSkeleton, EmptyState } from './components/ui/States';
import { buildNotifications } from './utils/notifications';
import { DatabaseState, CompanyProfile, TemplateCustomization, InvoiceItem } from './types';
import { getPaymentSummary, PAYMENT_STATUS_LABEL } from './utils/payments';
import {
  activeOutlet as resolveActiveOutlet, outletLabel, outletColor, outletInitials,
  newOutletId, outletUsage,
} from './utils/outlets';
import { attachA4Scale } from './utils/a4scale';
// The modules (and the PDF library invoicing pulls in) load as their own
// chunks, so the first screen paints from a small bundle. preloadModules()
// fetches them all in the background right after the first load, so by the
// time anyone taps a tab the code is already here: split for speed, never a wait.
const loadInvoicing = () => import('./components/InvoicingModule');
const loadQuotations = () => import('./components/QuotationModule');
const loadPayroll = () => import('./components/PayrollDashboard');
const loadReports = () => import('./components/ReportsView');
const InvoicingModule = lazy(loadInvoicing);
const QuotationModule = lazy(loadQuotations);
const PayrollDashboard = lazy(() => loadPayroll().then(m => ({ default: m.PayrollDashboard })));
const ReportsView = lazy(() => loadReports().then(m => ({ default: m.ReportsView })));
const preloadModules = () => { loadInvoicing(); loadQuotations(); loadPayroll(); loadReports(); };
import {
  LayoutDashboard, FileText, Users, LogOut, Moon, Sun, RefreshCw,
  Building2, TrendingUp, Clock, Loader2, X, AlertTriangle, ArrowRight,
  CreditCard, Settings, Menu, Upload, CalendarRange, UserCog, BarChart3, Info,
} from 'lucide-react';
import { HubOverview, DrawnTick, Money } from './components/HubOverview';
import { CONFIRMED_EVENT, Confirmation } from './utils/confirm';

// ─── Types ────────────────────────────────────────────────────────────────────
type AppView = 'hub' | 'invoicing' | 'payroll' | 'quotations' | 'reports';
type AuthStatus = 'loading' | 'unauthenticated' | 'authenticated';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

// ─── Invoice item grouping (for quotation-converted invoices) ──────────────────
// Invoices converted from a quotation store each line as a single flat string:
//   "<Event Date> (<Session>): <Item Name>"   e.g. "Monday, 27 July 2026 (Breakfast): Capati"
// (see buildConvertedInvoiceItems in QuotationModule). This helper parses that
// structure back out so the invoice preview/print can render the same neat
// day → session → items layout as the quotation, instead of one long flat table.
// Lines that don't carry a date prefix (extra charges like Delivery/Packaging,
// package rows, or plain manually-entered items) fall into `ungrouped` and are
// rendered as-is — so ordinary invoices look exactly as before.
interface GroupedSession { label: string; rows: InvoiceItem[]; }
interface GroupedDay { dayLabel: string; sessions: GroupedSession[]; total: number; }

function groupInvoiceItemsByDay(items: InvoiceItem[]): { grouped: GroupedDay[]; ungrouped: InvoiceItem[] } {
  const grouped: GroupedDay[] = [];
  const ungrouped: InvoiceItem[] = [];

  items.forEach(item => {
    const full = String(item.Item_Name || '');
    const colonIdx = full.indexOf(': ');
    if (colonIdx === -1) { ungrouped.push(item); return; }

    const prefix = full.slice(0, colonIdx);          // "Monday, 27 July 2026 (Breakfast)"
    const namePart = full.slice(colonIdx + 2);        // "Capati"
    const m = prefix.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    const dayLabel = (m ? m[1] : prefix).trim();
    const sessionLabel = m ? m[2].trim() : '';

    // Only treat as a day group if the prefix looks like a real date (has a
    // 4-digit year) — this keeps normal items like "Deposit: 50%" ungrouped.
    if (!/\d{4}/.test(dayLabel)) { ungrouped.push(item); return; }

    const rowItem: InvoiceItem = { ...item, Item_Name: namePart };
    const lineTotal = Number(item.Subtotal ?? (item.Quantity * item.Price)) || 0;

    let day = grouped.find(d => d.dayLabel === dayLabel);
    if (!day) { day = { dayLabel, sessions: [], total: 0 }; grouped.push(day); }
    day.total += lineTotal;

    let sess = day.sessions.find(s => s.label === sessionLabel);
    if (!sess) { sess = { label: sessionLabel, rows: [] }; day.sessions.push(sess); }
    sess.rows.push(rowItem);
  });

  return { grouped, ungrouped };
}

// ─── Constants ────────────────────────────────────────────────────────────────
// Used only until the company's own Config tab loads. A single neutral outlet:
// the id stays 'Bistro' so that if config never loads, legacy rows still match.
const DEFAULT_PROFILES: CompanyProfile[] = [
  {
    id: 'Bistro', name: 'My Outlet', store_name: 'My Outlet',
    address: '', email: '', phone: '',
    currency_symbol: 'RM', series_format: 'INV-26-',
    template: DEFAULT_TEMPLATE,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
// The original deployment stored outlets under the lowercase keys 'bistro' and
// 'nk'; later saves used 'Bistro' and 'Nasi Kandar'. Normalise so both spellings
// mean the same outlet rather than two.
const LEGACY_KEY_ALIASES: Record<string, string> = { bistro: 'Bistro', nk: 'Nasi Kandar' };

function gasConfigToProfiles(gasConfig: any): CompanyProfile[] {
  // Accept an already-mapped profiles array immediately
  if (Array.isArray(gasConfig)) return gasConfig.length ? gasConfig : DEFAULT_PROFILES;
  if (!gasConfig || typeof gasConfig !== 'object') return DEFAULT_PROFILES;

  const seen = new Set<string>();
  const profiles: CompanyProfile[] = [];

  Object.keys(gasConfig).filter(isBranchKey).forEach(key => {
    const raw = gasConfig[key] || {};
    const id = LEGACY_KEY_ALIASES[key.toLowerCase()] || key;
    if (seen.has(id)) return;        // both spellings present — first wins
    seen.add(id);
    const label = raw.store_name || raw.name || id;
    profiles.push({
      id,
      name:            label,
      store_name:      label,
      company_name:    raw.company_name || '',
      address:         raw.address || '',
      email:           raw.email || '',
      phone:           raw.phone || raw.contact || '',
      currency_symbol: raw.currency_symbol || 'RM',
      logo_url:        raw.logo_url || '',
      footer_text:     raw.footer_text || '',
      payment_info:    raw.payment_info || '',
      series_format:   raw.series_format || raw.prefix || 'INV-26-',
      template:        raw.template || DEFAULT_TEMPLATE,
    });
  });

  return profiles.length > 0 ? profiles : DEFAULT_PROFILES;
}

// ─── Toast Container ──────────────────────────────────────────────────────────
function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  if (toasts.length === 0) return null;
  const tone: Record<Toast['type'], string> = {
    success: 'text-emerald-600 dark:text-emerald-400',
    error: 'text-rose-600 dark:text-rose-400',
    warning: 'text-amber-600 dark:text-amber-400',
    info: 'text-brand-600 dark:text-brand-300',
  };
  return (
    // Phone: centred just above the tab bar, under the thumb. Desktop: bottom right.
    <div aria-live="polite" className="fixed z-[9999] left-3 right-3 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] md:left-auto md:right-5 md:bottom-5 flex flex-col items-center md:items-end gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          role={t.type === 'error' ? 'alert' : 'status'}
          className="toast-in flex items-center gap-3 pl-3 pr-2 py-2.5 rounded-2xl shadow-xl bg-white dark:bg-ink-800 text-ink-900 dark:text-white text-sm font-semibold w-full max-w-sm pointer-events-auto"
        >
          <span className={`shrink-0 ${tone[t.type]}`}>
            {t.type === 'success'
              ? <DrawnTick className="w-7 h-7" />
              : t.type === 'info'
                ? <Info className="w-6 h-6" />
                : <AlertTriangle className="w-6 h-6" />}
          </span>
          <span className="flex-1 leading-snug">{t.message}</span>
          <button onClick={() => onRemove(t.id)} aria-label="Dismiss"
            className="tap flex items-center justify-center rounded-xl text-ink-500 hover:text-ink-900 dark:text-ink-400 dark:hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The payment-confirmed moment: amount large, tick drawing, gone in ~1.4s. It
 * never takes focus or blocks a tap; it only confirms what already happened.
 */
function ConfirmedMoment() {
  const [shown, setShown] = useState<(Confirmation & { key: number }) | null>(null);
  useEffect(() => {
    let timer = 0;
    const onConfirm = (e: Event) => {
      setShown({ ...(e as CustomEvent<Confirmation>).detail, key: Date.now() });
      clearTimeout(timer);
      timer = window.setTimeout(() => setShown(null), 1400);
    };
    window.addEventListener(CONFIRMED_EVENT, onConfirm);
    return () => { window.removeEventListener(CONFIRMED_EVENT, onConfirm); clearTimeout(timer); };
  }, []);
  if (!shown) return null;
  return (
    <div className="fixed inset-0 z-[9998] grid place-items-center pointer-events-none p-6" role="status" aria-live="polite">
      <div key={shown.key} className="confirm-in w-full max-w-xs rounded-3xl bg-white dark:bg-ink-800 shadow-xl px-6 py-7 text-center">
        <DrawnTick className="w-16 h-16 mx-auto text-emerald-600 dark:text-emerald-400" />
        <p className="mt-3 text-sm font-bold text-ink-600 dark:text-ink-300">{shown.title}</p>
        <Money value={shown.amount} currency={shown.currency || 'RM'} className="block mt-1 text-4xl font-extrabold tracking-tight text-ink-900 dark:text-white" />
        {shown.note && <p className="mt-2 text-xs text-ink-500 dark:text-ink-400 truncate">{shown.note}</p>}
      </div>
    </div>
  );
}

const KIND_LABELS: Record<typeof KINDS[number], string> = {
  invoices: 'Invoices', invoice_items: 'Invoice lines', payments: 'Payments', customers: 'Customers',
  employees: 'Employees', payslips: 'Payslips', quotations: 'Quotations',
  quotation_days: 'Quotation days', quotation_items: 'Quotation lines',
};

/** Where the company's data lives, and the one-time move from Google Sheets. */
const ago = (iso: string): string => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Where the company's data lives: backups, restoring or importing, and who changed what. */
function DataModal({
  companyName, canImport, db, onClose, onImported,
}: {
  companyName: string;
  canImport: boolean;
  db: DatabaseState;
  onClose: () => void;
  onImported: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof importSheetExport>> | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);

  useEffect(() => { recentChanges().then(setChanges).catch(() => setChanges([])); }, []);

  const stamp = new Date().toISOString().slice(0, 10);
  const fileBase = `${(companyName || 'bizeazy').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}-${stamp}`;

  const downloadExcel = async () => {
    setBusy(true); setError(null);
    try {
      download(`${fileBase}.xlsx`, buildXlsx(workbookSheets(db, await loadConfig())), XLSX_TYPE);
    } catch (err: any) { setError(err.message || 'Could not build the Excel file.'); }
    finally { setBusy(false); }
  };
  const downloadBackup = async () => {
    setBusy(true); setError(null);
    try {
      download(`${fileBase}-backup.json`, backupJson(db, await loadConfig(), companyName), 'application/json');
    } catch (err: any) { setError(err.message || 'Could not build the backup.'); }
    finally { setBusy(false); }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const done = await importSheetExport(await file.text(), gasConfigToProfiles);
      setResult(done);
      onImported();
    } catch (err: any) {
      setError(err.message || 'The import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title="Data & Import"
      icon={<Upload className="w-4 h-4" />}
      onClose={onClose}
      maxWidth="md"
      footer={<div className="flex justify-end"><button type="button" onClick={onClose} className={sheetBtn.ghost}>Done</button></div>}
    >
      <div className="space-y-5">
        <div className="rounded-lg border border-ink-200 dark:border-ink-800 bg-ink-50 dark:bg-ink-950 px-3 py-2.5">
          <p className="text-xs font-bold text-ink-900 dark:text-white">{companyName || 'Your company'}</p>
          <p className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5">
            Stored in Supabase. Every save goes straight to the database, and only what changed is sent.
          </p>
        </div>

        {canImport && (
          <div>
            <h4 className="text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300 mb-1.5">Back up</h4>
            <p className="text-xs text-ink-600 dark:text-ink-300 leading-relaxed">
              <span className="font-bold">Excel</span> has a sheet for each type of record, for your accountant or your own checks.
              The <span className="font-bold">backup file</span> holds everything and can be restored below.
            </p>
            <div className="flex flex-wrap gap-2 mt-2.5">
              <button type="button" onClick={downloadExcel} disabled={busy} className={sheetBtn.ghost}>Download Excel</button>
              <button type="button" onClick={downloadBackup} disabled={busy} className={sheetBtn.ghost}>Download backup file</button>
            </div>
          </div>
        )}

        <div>
          <h4 className="text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300 mb-1.5">Restore or import</h4>
          {!canImport ? (
            <p className="text-xs text-ink-500 dark:text-ink-400">Only an administrator can import data.</p>
          ) : (
            <>
              <p className="text-xs text-ink-600 dark:text-ink-300 leading-relaxed mb-2">
                Choose a <span className="font-bold">backup file</span> from above to restore it, or an export from the old Google Sheets version:
              </p>
              <ol className="text-xs text-ink-600 dark:text-ink-300 space-y-1 list-decimal pl-4 leading-relaxed">
                <li>In your Apps Script project, open <span className="font-mono">Code.gs</span>, paste your spreadsheet link into <span className="font-mono">exportForBizEazy()</span> and run it.</li>
                <li>It saves <span className="font-mono">bizeazy-export-….json</span> to your Google Drive. Download it.</li>
                <li>Choose that file below.</li>
              </ol>
              <p className="text-2xs text-ink-500 dark:text-ink-400 mt-2 leading-relaxed">
                Branches and every record in the file are written back. Records created since are left alone,
                and running it twice updates rather than duplicates.
              </p>
              <label className={`tap mt-3 inline-flex items-center justify-center gap-1.5 px-4 rounded-lg text-xs font-bold cursor-pointer transition-colors bg-brand-600 hover:bg-brand-700 text-white ${busy ? 'opacity-60 pointer-events-none' : ''}`}>
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {busy ? 'Working…' : 'Choose file to restore or import'}
                <input type="file" accept=".json,application/json" className="sr-only" disabled={busy}
                  onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs font-semibold text-rose-700 dark:text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}
            </p>
          )}
          {result && (
            <div role="status" className="mt-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-3">
              <p className="text-xs font-bold text-emerald-800 dark:text-emerald-200">
                Imported {result.branches} branch{result.branches === 1 ? '' : 'es'} and:
              </p>
              <ul className="mt-1 grid grid-cols-2 gap-x-4 text-2xs text-emerald-800 dark:text-emerald-300 tabular-nums">
                {KINDS.map(k => <li key={k}>{KIND_LABELS[k]}: <span className="font-bold">{result.counts[k]}</span></li>)}
              </ul>
            </div>
          )}
        </div>

        <div>
          <h4 className="text-2xs font-bold uppercase tracking-wider text-ink-600 dark:text-ink-300 mb-1.5">Recent changes</h4>
          {changes === null ? (
            <SkeletonRows rows={3} />
          ) : changes.length === 0 ? (
            <p className="text-xs text-ink-500 dark:text-ink-400">Nothing yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800 border border-ink-100 dark:border-ink-800 rounded-lg max-h-64 overflow-y-auto">
              {changes.map(c => (
                <li key={`${c.kind}|${c.id}`} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 text-xs text-ink-800 dark:text-ink-200 truncate">
                    <span className="font-bold">{KIND_LABELS[c.kind]}</span>{' '}
                    {/* Child rows are keyed under their parent; show the parent's number. */}
                    <span className="font-mono">{c.id.split('|')[0]}</span>
                    <span className="text-ink-500 dark:text-ink-400"> · {c.by}</span>
                  </span>
                  <span className="shrink-0 text-2xs text-ink-500 dark:text-ink-400 tabular-nums">{ago(c.at)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1.5">Edits and additions; a deleted record leaves no entry.</p>
        </div>
      </div>
    </Sheet>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const NAV_ITEMS: { view: AppView; Icon: React.FC<React.SVGProps<SVGSVGElement>>; label: string }[] = [
  { view: 'hub', Icon: LayoutDashboard, label: 'Hub Overview' },
  { view: 'invoicing', Icon: FileText, label: 'Invoicing' },
  { view: 'quotations', Icon: CalendarRange, label: 'Quotations' },
  { view: 'payroll', Icon: Users, label: 'Payroll' },
  { view: 'reports', Icon: BarChart3, label: 'Reports' },
];

function Sidebar({
  activeView, setActiveView, profiles, activeBranchLocation, setActiveBranchLocation,
  isDark, setIsDark, isDataLoading, onRefresh, onSignOut, onOpenSettings, onOpenProfiles,
  onOpenUsers, user, companyName, allowed,
  isMobileOpen, onMobileClose,
}: {
  activeView: AppView;
  setActiveView: (v: AppView) => void;
  profiles: CompanyProfile[];
  activeBranchLocation: string;
  setActiveBranchLocation: (v: string) => void;
  isDark: boolean;
  setIsDark: (v: boolean) => void;
  isDataLoading: boolean;
  onRefresh: () => void;
  onSignOut: () => void;
  onOpenSettings: () => void;
  onOpenProfiles: () => void;
  onOpenUsers: () => void;
  user: SessionUser | null;
  companyName: string;
  allowed: (v: AppView | ModuleName) => boolean;
  isMobileOpen: boolean;
  onMobileClose: () => void;
}) {
  return (
    <aside className={`
      fixed inset-y-0 left-0 z-50 w-60
      transform transition-transform duration-300 ease-in-out
      ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'}
      md:relative md:translate-x-0 md:flex-shrink-0
      bg-white dark:bg-ink-950 border-r border-ink-200 dark:border-ink-800 flex flex-col h-screen md:sticky md:top-0
    `}>
      {/* Brand: the world's confirming tick, in the payment blue */}
      <div className="px-4 pt-5 pb-4 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-brand-600 rounded-xl flex items-center justify-center flex-shrink-0 shadow-md">
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-white" fill="none" aria-hidden="true">
              <path d="M6 12.5l4 4L18 8" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="text-base font-extrabold tracking-tight text-ink-900 dark:text-white leading-none">BizEazy</div>
            <div className="text-xs text-ink-500 dark:text-ink-400 font-semibold truncate mt-1">{companyName || 'Operations Hub'}</div>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-3 py-2 space-y-1 overflow-y-auto">
        {NAV_ITEMS.filter(({ view }) => allowed(view)).map(({ view, Icon, label }) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              onClick={() => setActiveView(view)}
              aria-current={active ? 'page' : undefined}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-colors duration-150 cursor-pointer ${
                active
                  ? 'bg-brand-600 text-white shadow-md'
                  : 'text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800/70 hover:text-ink-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-[18px] h-[18px] flex-shrink-0" />
              {label}
            </button>
          );
        })}
      </nav>

      {/* Branch selector */}
      <div className="px-3 py-3 border-t border-ink-100 dark:border-ink-800 flex-shrink-0">
        <div className="text-xs font-bold text-ink-500 dark:text-ink-400 px-2 mb-1.5">Branch</div>
        <div className="space-y-0.5">
          {profiles.map((p, idx) => {
            const branchName = outletLabel(p);
            const isActive = activeBranchLocation.toLowerCase() === branchName.toLowerCase();
            return (
              <button
                key={p.id}
                onClick={() => setActiveBranchLocation(branchName)}
                aria-pressed={isActive}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-brand-50 dark:bg-brand-950/70 text-brand-800 dark:text-brand-200 font-bold'
                    : 'text-ink-600 dark:text-ink-300 font-semibold hover:bg-ink-100 dark:hover:bg-ink-800'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: outletColor(p, idx) }} />
                <span className="truncate">{branchName}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Utility actions */}
      <div className="px-3 py-2 border-t border-ink-100 dark:border-ink-800 space-y-0.5 flex-shrink-0">
        <button
          onClick={onRefresh}
          disabled={isDataLoading}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800/70 transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 flex-shrink-0 ${isDataLoading ? 'animate-spin' : ''}`} />
          {isDataLoading ? 'Syncing…' : 'Refresh Data'}
        </button>
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800/70 transition-colors cursor-pointer"
        >
          <Settings className="w-3.5 h-3.5 flex-shrink-0" />
          Data & Import
        </button>
        {allowed('settings') && (
          <button
            onClick={onOpenProfiles}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800/70 transition-colors cursor-pointer"
          >
            <Building2 className="w-3.5 h-3.5 flex-shrink-0" />
            Company Profiles
          </button>
        )}
        <button
          onClick={onOpenUsers}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800/70 transition-colors cursor-pointer"
        >
          <UserCog className="w-3.5 h-3.5 flex-shrink-0" />
          {user?.role === 'admin' ? 'Users & Access' : 'My Password'}
        </button>
        <button
          onClick={() => setIsDark(!isDark)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-ink-600 dark:text-ink-300 hover:bg-ink-100 dark:hover:bg-ink-800/70 transition-colors cursor-pointer"
        >
          {isDark ? <Sun className="w-3.5 h-3.5 flex-shrink-0" /> : <Moon className="w-3.5 h-3.5 flex-shrink-0" />}
          {isDark ? 'Light Mode' : 'Dark Mode'}
        </button>
        <button
          onClick={onSignOut}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-500 dark:text-ink-400 hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5 flex-shrink-0" />
          Sign Out
        </button>
      </div>

      {/* User chip */}
      <div className="px-3 py-2.5 border-t border-ink-100 dark:border-ink-800 bg-ink-50/50 dark:bg-ink-900/50 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-brand-100 dark:bg-brand-950 flex items-center justify-center text-2xs font-black text-brand-700 dark:text-brand-300 flex-shrink-0 uppercase">
            {(user?.full_name || user?.user_id || '?').charAt(0)}
          </div>
          <div className="min-w-0">
            <div className="text-2xs font-semibold text-ink-900 dark:text-white truncate">
              {user?.full_name || user?.user_id || 'User'}
            </div>
            <div className="text-2xs text-ink-500 dark:text-ink-400 truncate">
              {user?.role === 'admin' ? 'Admin' : 'Member'} · {companyName}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [authView, setAuthView] = useState<'login' | 'register'>('login');
  // Modules still take these Sheets-era props; the company id fills the first,
  // and the token is unused — supabase-js carries the session itself.
  const spreadsheetId = session?.company.company_id || '';
  const accessToken = '';
  const [db, setDb] = useState<DatabaseState>(EMPTY_DB);
  const [profiles, setProfiles] = useState<CompanyProfile[]>(DEFAULT_PROFILES);
  const [payrollScope, setPayrollScope] = useState<PayrollScope>('company');
  const [activeView, setActiveView] = useState<AppView>('hub');
  const [isDark, setIsDark] = useState(() => localStorage.getItem('bizeazy_dark') === 'true');

  // Keep DOM class and a lightweight localStorage flag in sync with the theme state
  useEffect(() => {
    try {
      document.documentElement.classList.toggle('dark', isDark);
    } catch (e) {
      // server-side render or restricted environment — ignore
    }
    localStorage.setItem('is_dark_mode', String(isDark));
  }, [isDark]);

  const [activeBranchLocation, setActiveBranchLocation] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [isDataLoading, setIsDataLoading] = useState(false);
  // Until the first load lands, db is empty rather than "no records": screens
  // show skeletons, not empty states (see ui/States.tsx). A failed first load
  // shows the error with a retry instead of an empty book.
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const firstLoad = !hasLoaded && !loadError;
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfilesOpen, setIsProfilesOpen] = useState(false);
  const [isUsersOpen, setIsUsersOpen] = useState(false);
  /** Set by a Hub quick action: the module opens straight into its new-item form. */
  const [createIn, setCreateIn] = useState<AppView | null>(null);

  // An admin with no recovery code is one forgotten password away from a locked
  // company: nag on the hub until there is one. Rechecked when Users & Access closes.
  const [needsRecoveryCode, setNeedsRecoveryCode] = useState(false);
  const isAdminSession = session?.user.role === 'admin';
  useEffect(() => {
    if (!isAdminSession || isUsersOpen) return;
    recoveryStatus().then(r => setNeedsRecoveryCode(!r.exists)).catch(() => { /* offline: no nag */ });
  }, [isAdminSession, isUsersOpen]);
  const [previewInvoiceId, setPreviewInvoiceId] = useState<string | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  // Design (colors/fonts/layout) now lives entirely on each CompanyProfile's `template`
  // field, edited in Settings → Company Profiles and persisted to Google Sheets — no
  // local React state or localStorage seeding needed here anymore.
  const downloadPremiumPDF = (
    invoiceId: string,
    _db: DatabaseState,
    _profiles: CompanyProfile[],
    _styles: TemplateCustomization,
    toast: (msg: string, type: Toast['type']) => void,
  ) => {
    setPreviewInvoiceId(invoiceId);
    setIsPreviewOpen(true);
    toast('Invoice preview opened. Use Print / Save A4 to export PDF.', 'info');
  };


  const triggerToast = useCallback((message: string, type: Toast['type']) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const removeToast = useCallback((id: string) => setToasts(prev => prev.filter(t => t.id !== id)), []);

  useEffect(() => {
    localStorage.setItem('bizeazy_dark', String(isDark));
  }, [isDark]);

  const loadData = useCallback(async (companyId: string) => {
    if (!companyId) return;
    setIsDataLoading(true);
    setLoadError(null);
    try {
      let resolvedProfiles = DEFAULT_PROFILES;
      try {
        const config = await loadConfig();
        resolvedProfiles = gasConfigToProfiles(config);
        setProfiles(resolvedProfiles);
        setPayrollScope(payrollScopeOf(config));
      } catch {
        // Fall back to a neutral outlet; the records below still load.
      }
      const data = await loadAll();
      setDb(data);
      setHasLoaded(true);
      setActiveBranchLocation(prev => {
        // Keep the user's branch if it still exists; otherwise fall to the first.
        const stillThere = prev && resolvedProfiles.some(p => outletLabel(p) === prev);
        return stillThere ? prev : (resolvedProfiles[0] ? outletLabel(resolvedProfiles[0]) : '');
      });
    } catch (err: any) {
      triggerToast(`Data load failed: ${err.message}`, 'error');
      setLoadError(err.message || 'Could not reach the server.');
    } finally {
      setIsDataLoading(false);
    }
  }, [triggerToast]);

  // A remembered session renders straight away so a reload is not a login
  // screen, then gets confirmed against the server — a token that was revoked
  // or expired while the tab was closed must not keep working offline.
  useEffect(() => {
    const stored = loadSession();
    if (!stored) { setAuthStatus('unauthenticated'); return; }
    setSession(stored);
    setAuthStatus('authenticated');
    loadData(stored.company.company_id);
    refreshSession()
      .then(fresh => setSession(fresh))
      .catch(() => { /* an expired session already fired SIGNED_OUT_EVENT; offline keeps the cached one */ });
  }, [loadData]);

  // Any call that comes back with an expired session drops us here.
  useEffect(() => {
    const onSignedOut = () => {
      setSession(null);
      forgetLoaded();
      setDb(EMPTY_DB);
      setHasLoaded(false);
      setActiveView('hub');
      setAuthStatus('unauthenticated');
      triggerToast('Your session has expired. Please sign in again.', 'warning');
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [triggerToast]);

  const handleSignedIn = (next: Session) => {
    setSession(next);
    setAuthStatus('authenticated');
    setAuthView('login');
    loadData(next.company.company_id);
  };

  const handleSignOut = async () => {
    await endSession();
    setSession(null);
    forgetLoaded();
    setDb(EMPTY_DB);
    setHasLoaded(false);
    setActiveView('hub');
    setAuthStatus('unauthenticated');
  };

  const notifications = useMemo(() => buildNotifications(db, profiles), [db, profiles]);

  useEffect(() => {
    if (!hasLoaded) return;
    const idle = (window as any).requestIdleCallback as ((cb: () => void) => number) | undefined;
    if (idle) idle(preloadModules); else setTimeout(preloadModules, 300);
  }, [hasLoaded]);

  /** Hub is always open; every other view is a module the account must carry. */
  const allowed = useCallback(
    (v: AppView | ModuleName): boolean => v === 'hub'
      // Reports holds sales and payroll sections, each shown only to its module.
      || (v === 'reports' ? can(session, 'invoicing') || can(session, 'payroll') : can(session, v as ModuleName)),
    [session],
  );

  // Belt to the server's braces: if a user lands on (or is left sitting in) a
  // module they may not open, put them back on the hub.
  useEffect(() => {
    if (activeView !== 'hub' && !allowed(activeView)) setActiveView('hub');
  }, [activeView, allowed]);

  // Modules still call this with the Sheets-era arguments; only the records matter now.
  const handleSync = useCallback(async (
    _companyId: string, _token: string,
    nextDb: DatabaseState, _profiles: CompanyProfile[], _branch: string,
  ) => {
    await saveChanges(nextDb);
  }, []);

  const handleProfilesSave = async (updated: CompanyProfile[]) => {
    try {
      const gasConfig = updated.reduce<Record<string, any>>((acc, p) => {
        acc[p.id] = {
          store_name: p.store_name || p.name,
          address: p.address,
          email: p.email,
          phone: p.phone,
          currency_symbol: p.currency_symbol,
          series_format: p.series_format,
          logo_url: p.logo_url || '',
          footer_text: p.footer_text || '',
          payment_info: p.payment_info || '',
          company_name: p.company_name || '',
          template: p.template || DEFAULT_TEMPLATE,
        };
        return acc;
      }, {});
      // Company settings live beside the branches; a branch save must keep them.
      const current = await loadConfig();
      const kept = Object.fromEntries(Object.entries(current).filter(([k]) => !isBranchKey(k)));
      await saveConfig({ ...kept, ...gasConfig });
      setProfiles(updated);
      setIsProfilesOpen(false);
      triggerToast('Company profiles saved.', 'success');
    } catch (err: any) {
      triggerToast(`Profile save failed: ${err.message}`, 'error');
    }
  };

  const handlePayrollScope = async (scope: PayrollScope) => {
    const before = payrollScope;
    setPayrollScope(scope);
    try {
      await saveCompanySettings({ payroll_scope: scope });
      triggerToast(scope === 'company' ? 'Payroll now lists the whole company.' : 'Payroll now lists staff by branch.', 'success');
    } catch (err: any) {
      setPayrollScope(before);
      triggerToast(`Not saved: ${err.message}`, 'error');
    }
  };

  const viewTitle: Record<AppView, string> = {
    hub: 'Overview', invoicing: 'Invoices', payroll: 'Payroll',
    quotations: 'Quotations', reports: 'Reports',
  };

  const wrapClass = isDark ? 'dark' : '';

  if (authStatus === 'loading') {
    return (
      <div className={wrapClass}>
        <div className="min-h-screen flex items-center justify-center bg-ink-50 dark:bg-ink-950">
          <Loader2 className="w-6 h-6 animate-spin text-brand-500" />
        </div>
      </div>
    );
  }

  if (authStatus === 'unauthenticated' || !session) {
    return (
      <div className={wrapClass}>
        {authView === 'register'
          ? <RegisterScreen onRegistered={handleSignedIn} onBack={() => setAuthView('login')} />
          : <LoginScreen onSignedIn={handleSignedIn} onRegister={() => setAuthView('register')} />}
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </div>
    );
  }

  // ─── Hub Overview (standalone layout with own sidebar) ──────────────────────
  return (
    <div className={wrapClass}>
      <div className="min-h-screen bg-ink-50 dark:bg-ink-950 flex">

        {/* Mobile overlay — tap outside to close */}
        {isMobileNavOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setIsMobileNavOpen(false)}
          />
        )}

        <Sidebar
          activeView={activeView}
          setActiveView={(v) => { setActiveView(v); setIsMobileNavOpen(false); }}
          profiles={profiles}
          activeBranchLocation={activeBranchLocation}
          setActiveBranchLocation={(v) => { setActiveBranchLocation(v); setIsMobileNavOpen(false); }}
          isDark={isDark}
          setIsDark={setIsDark}
          isDataLoading={isDataLoading}
          onRefresh={() => loadData(spreadsheetId)}
          onSignOut={handleSignOut}
          onOpenSettings={() => { setIsSettingsOpen(true); setIsMobileNavOpen(false); }}
          onOpenProfiles={() => { setIsProfilesOpen(true); setIsMobileNavOpen(false); }}
          onOpenUsers={() => { setIsUsersOpen(true); setIsMobileNavOpen(false); }}
          user={session.user}
          companyName={session.company.company_name}
          allowed={allowed}
          isMobileOpen={isMobileNavOpen}
          onMobileClose={() => setIsMobileNavOpen(false)}
        />

        <div className="flex-1 min-w-0 flex flex-col">
          {/* Top bar */}
          <header className="bg-white dark:bg-ink-950 border-b border-ink-100 dark:border-ink-800 px-4 md:px-6 h-14 md:h-16 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              {/* Hamburger — mobile only */}
              <button
                onClick={() => setIsMobileNavOpen(true)}
                className="md:hidden p-1.5 -ml-1 rounded-lg text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800 cursor-pointer flex-shrink-0"
                aria-label="Open navigation"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <h1 className="text-base font-extrabold tracking-tight text-ink-900 dark:text-white leading-tight">{viewTitle[activeView]}</h1>
                <p className="text-2xs text-ink-500 dark:text-ink-400 flex items-center gap-1.5">
                  <span className="truncate">{activeBranchLocation}</span>
                  {isSyncing && <span className="text-brand-500 font-semibold flex-shrink-0">· Syncing…</span>}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {isDataLoading && (
                <span className="flex items-center gap-1.5 text-2xs text-ink-500 dark:text-ink-400">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                </span>
              )}
              <NotificationBell notifications={notifications} isDark={isDark} onOpenView={setActiveView} />
            </div>
          </header>

          {/* Module content */}
          <main className="flex-1 overflow-y-auto p-4 sm:p-6 pb-nav md:pb-6">
            <div key={activeView} className="view-enter">
            {activeView === 'hub' ? (
              <HubOverview
                db={db}
                profiles={profiles}
                activeBranchLocation={activeBranchLocation}
                notifications={notifications}
                allowed={allowed}
                loading={firstLoad}
                onNavigate={(view, intent) => { if (intent?.create) setCreateIn(view); setActiveView(view); }}
                onOpenInvoice={(invoiceId) => {
                  setPreviewInvoiceId(invoiceId);
                  setIsPreviewOpen(true);
                  setActiveView('invoicing');
                }}
                banner={(needsRecoveryCode || (!hasLoaded && loadError)) ? (
                  <div className="space-y-3">
            {needsRecoveryCode && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border p-4 border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-amber-900 dark:text-amber-100">Create a recovery code</p>
                  <p className="text-xs text-amber-800 dark:text-amber-200 mt-0.5">
                    If you forget your password, it is the only way back in. Takes ten seconds.
                  </p>
                </div>
                <button onClick={() => setIsUsersOpen(true)}
                  className="tap inline-flex items-center justify-center px-4 rounded-lg text-xs font-bold cursor-pointer bg-amber-700 hover:bg-amber-800 text-white">
                  Open Users &amp; Access
                </button>
              </div>
            )}

            {!hasLoaded && loadError && (
              <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-2xl border p-4 border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-rose-800 dark:text-rose-200">Couldn't load your records</p>
                  <p className="text-xs text-rose-700 dark:text-rose-300 mt-0.5">Nothing has been changed. {loadError}</p>
                </div>
                <button
                  onClick={() => loadData(spreadsheetId)}
                  disabled={isDataLoading}
                  className="tap inline-flex items-center justify-center gap-1.5 px-4 rounded-lg text-xs font-bold cursor-pointer bg-rose-700 hover:bg-rose-800 text-white disabled:opacity-60"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isDataLoading ? 'animate-spin' : ''}`} />
                  {isDataLoading ? 'Trying again…' : 'Try again'}
                </button>
              </div>
            )}
                  </div>
                ) : undefined}
              />
            ) : firstLoad ? (
              <ModuleSkeleton label={viewTitle[activeView]} />
            ) : !hasLoaded ? (
              <div className="rounded-xl border border-ink-200 dark:border-ink-800 bg-white dark:bg-ink-900">
                <EmptyState
                  icon={<RefreshCw />}
                  title="Couldn't load your records"
                  body={<>Nothing has been changed. {loadError}</>}
                  action={{ label: isDataLoading ? 'Trying again…' : 'Try again', onClick: () => loadData(spreadsheetId) }}
                />
              </div>
            ) : (<Suspense fallback={<ModuleSkeleton label={viewTitle[activeView]} />}>
            {activeView === 'invoicing' && (
              <InvoicingModule
                db={db}
                setDb={setDb}
                profiles={profiles}
                activeBranchLocation={activeBranchLocation}
                isDarkMode={isDark}
                triggerToast={triggerToast}
                syncStateToSheets={handleSync}
                spreadsheetId={spreadsheetId}
                accessToken={accessToken}
                isSyncing={isSyncing}
                setIsSyncing={setIsSyncing}
                isStaff={false}
                startNew={createIn === 'invoicing'}
                onStartedNew={() => setCreateIn(null)}
                onPreviewInvoice={(invoiceId) => {
                  setPreviewInvoiceId(invoiceId);
                  setIsPreviewOpen(true);
                }}
                onDownloadPDF={(invoiceId) =>
                  downloadPremiumPDF(invoiceId, db, profiles, DEFAULT_TEMPLATE, triggerToast)
                }
                onDeleteInvoice={(invoiceId) => {
                  const nextDb = {
                    ...db,
                    invoices: db.invoices.filter(i => i.Invoice_ID !== invoiceId),
                    invoice_items: db.invoice_items.filter(i => i.Invoice_ID !== invoiceId),
                  };
                  setDb(nextDb);
                  triggerToast(`Invoice ${invoiceId} deleted.`, 'success');
                  handleSync(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation)
                    .catch((err: any) => triggerToast(`Not deleted yet: ${err.message}`, 'error'));
                }}
              />
            )}
            {activeView === 'quotations' && (
              <QuotationModule
                db={db}
                setDb={setDb}
                profiles={profiles}
                activeBranchLocation={activeBranchLocation}
                isDarkMode={isDark}
                triggerToast={triggerToast}
                syncStateToSheets={handleSync}
                spreadsheetId={spreadsheetId}
                accessToken={accessToken}
                isSyncing={isSyncing}
                setIsSyncing={setIsSyncing}
                startNew={createIn === 'quotations'}
                onStartedNew={() => setCreateIn(null)}
              />
            )}
            {activeView === 'reports' && (
              <ReportsView
                db={db}
                profiles={profiles}
                canSales={can(session, 'invoicing')}
                canPayroll={can(session, 'payroll')}
              />
            )}
            {activeView === 'payroll' && (
              <PayrollDashboard
                db={db}
                setDb={setDb}
                activeBranchLocation={activeBranchLocation}
                isStaff={false}
                isDarkMode={isDark}
                triggerToast={triggerToast}
                syncStateToSheets={handleSync}
                spreadsheetId={spreadsheetId}
                accessToken={accessToken}
                profiles={profiles}
                isSyncing={isSyncing}
                setIsSyncing={setIsSyncing}
                payrollScope={payrollScope}
                onPayrollScopeChange={can(session, 'settings') ? handlePayrollScope : undefined}
              />
            )}
            </Suspense>)}
            </div>
          </main>
        </div>
      </div>
      {isProfilesOpen && (
        <CompanyProfilesModal
          profiles={profiles}
          db={db}
          isDark={isDark}
          onClose={() => setIsProfilesOpen(false)}
          onSave={handleProfilesSave}
        />
      )}
      {isSettingsOpen && (
        <DataModal
          companyName={session.company.company_name}
          canImport={session.user.role === 'admin'}
          db={db}
          onClose={() => setIsSettingsOpen(false)}
          onImported={() => loadData(spreadsheetId)}
        />
      )}
      {isUsersOpen && (
        <UsersModal session={session} isDark={isDark} onClose={() => setIsUsersOpen(false)} onToast={triggerToast} initialTab={needsRecoveryCode ? 'password' : undefined} />
      )}
      <BottomNav
        activeView={activeView}
        onNavigate={(v) => { setActiveView(v); setIsMobileNavOpen(false); }}
        allowed={allowed}
        badgeCount={notifications.filter(n => n.view === 'payroll').length}
      />
      {/* ── Invoice Design Studio Modal ── */}
      {isPreviewOpen && previewInvoiceId && (
        (() => {
          const invoice = db.invoices.find(i => i.Invoice_ID === previewInvoiceId);
          if (!invoice) return null;
          const profile = profiles.find(p => p.id === invoice.Company);
          const customStyles = profile?.template || DEFAULT_TEMPLATE;
          const items = db.invoice_items.filter(item => item.Invoice_ID === previewInvoiceId);
          const activeTemp = (invoice.Template || 'modern') as 'modern' | 'minimal' | 'bold' | 'classic';
          const currencySymbol = invoice.Currency_Symbol || profile?.currency_symbol || 'RM';
          const paySummary = getPaymentSummary(invoice, db.payments);
          const invoicePayments = db.payments
            .filter(pm => pm.Invoice_ID === invoice.Invoice_ID)
            .sort((a, b) => (a.Date || '').localeCompare(b.Date || ''));
          const payStatusColor = paySummary.status === 'Paid' ? '#059669'
            : paySummary.status === 'Partial' ? '#D97706' : '#E11D48';
          const parentCompanyName = profile?.company_name || '';
          const storeOutletName = profile?.store_name || '';

          // Fall back to the saved customer record for contact/address when the
          // invoice itself doesn't carry them (e.g. older invoices, or a customer
          // whose details were added later). So any filled detail shows on the invoice.
          const matchedCust = db.customers.find(
            c => (c.Customer_Name || '').toLowerCase() === (invoice.Customer_Name || '').toLowerCase()
          );
          const displayContact = (invoice.Customer_Contact && invoice.Customer_Contact !== '-')
            ? invoice.Customer_Contact
            : (matchedCust?.Contact && matchedCust.Contact !== '-' ? matchedCust.Contact : '');
          const displayAddress = (invoice.Customer_Address && invoice.Customer_Address !== '-')
            ? invoice.Customer_Address
            : (matchedCust?.Address && matchedCust.Address !== '-' ? matchedCust.Address : '');

          // Portal straight to <body> so printing isn't constrained by any ancestor in
          // the app's own layout (sidebar, page wrappers, etc.) — see print CSS below.
          return createPortal(
            <div id="preview-studio-overlay" data-document className="fixed inset-0 bg-black/60 z-[60] flex overlay-center justify-center p-2 sm:p-4 overflow-y-auto w-full h-full">
              <style dangerouslySetInnerHTML={{__html: `
                @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&family=Playfair+Display:ital,wght@0,600;1,400&family=Space+Grotesk:wght@500;700&display=swap');
                @media print {
                  @page { size: A4 portrait; margin: 0mm; }
                  /* Force the print layout viewport itself to exactly A4 width. Without
                     this, mobile Chrome keeps the body at the phone's ~360px width and
                     shrinks the 210mm print area to fit — which is why it printed small
                     and needed a manual ~75% zoom. Pinning body to 210mm makes every
                     device (desktop + mobile) render the page 1:1 at true A4. */
                  html, body {
                    width: 210mm !important;
                    min-width: 210mm !important;
                    max-width: 210mm !important;
                    -webkit-text-size-adjust: 100% !important;
                    text-size-adjust: 100% !important;
                  }
                  body, html { margin: 0 !important; padding: 0 !important; background: white !important; }
                  /* Remove every body child from layout except our overlay — display:none
                     eliminates layout boxes entirely, preventing phantom page-height gaps
                     that visibility:hidden (which keeps boxes) would leave behind. */
                  body > * { display: none !important; }
                  body > #preview-studio-overlay { display: block !important; }
                  #preview-studio-header, #preview-studio-footer { display: none !important; }
                  /* Ancestors must not constrain height/overflow/padding/centering, or
                     content gets clipped to page 1 or pushed down by leftover flex spacing.
                     #preview-studio-body is the intermediate flex div between dialog and
                     stage container — it must also be reset or overflow:hidden clips content. */
                  #preview-studio-overlay, #preview-studio-dialog,
                  #preview-studio-body, #preview-stage-container {
                    position: static !important;
                    height: auto !important;
                    max-height: none !important;
                    overflow: visible !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    display: block !important;
                  }
                  /* Never split the customer block, items table, or totals box across a
                     page boundary — push the whole block to the next page instead. */
                  .print-keep-together { break-inside: avoid-page; page-break-inside: avoid; }
                  /* Undo the on-screen scale-to-fit so the export is true full A4. */
                  .a4-spacer { width: auto !important; height: auto !important; margin: 0 !important; }
                  #invoice-print-area {
                    position: static !important;
                    width: 210mm !important;
                    min-height: 297mm !important;
                    height: auto !important;
                    overflow: visible !important;
                    /* justify-between pushes the totals footer to the very bottom of the
                       297mm container, creating a large blank gap between the line items
                       and the footer. flex-start lets content flow naturally top-to-bottom
                       with no artificial spacing. */
                    justify-content: flex-start !important;
                    transform: none !important;
                    transform-origin: top left !important;
                    background: white !important;
                    border: none !important;
                    box-shadow: none !important;
                    margin: 0 !important;
                    -webkit-print-color-adjust: exact !important;
                    print-color-adjust: exact !important;
                  }
                }
                /* On screen, just fill the available width up to a real A4 width and let it
                   scroll vertically — the Tailwind classes (w-full max-w-[210mm]) already do
                   this. No scale-down transform here: shrinking the whole page to fit a phone
                   screen made every line of text microscopic. Only @media print forces the
                   literal 210mm size. */
              `}} />

              <div id="preview-studio-dialog" className="bg-ink-100 text-ink-900 w-full max-w-6xl rounded-2xl shadow-2xl flex flex-col overflow-hidden text-left h-[90vh]">

                {/* Header */}
                <div id="preview-studio-header" className="px-6 py-4 bg-ink-900 text-white flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-ink-800 gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                    <h3 className="text-sm font-bold tracking-tight">Invoice Preview</h3>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
                    <button
                      onClick={() => window.print()}
                      className="px-4 py-1.5 cursor-pointer bg-brand-600 hover:bg-brand-700 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 transition-all shadow-md active:scale-95"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                      Print / Save A4
                    </button>
                    <button
                      onClick={() => { setIsPreviewOpen(false); setPreviewInvoiceId(null); }}
                      className="p-1 px-1.5 hover:bg-white/10 rounded-lg transition-all text-ink-500 hover:text-white cursor-pointer"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div id="preview-studio-body" className="flex-1 flex flex-col lg:flex-row overflow-hidden">

                  {/* RIGHT: Paper canvas — no flex here on purpose; margin:auto on the page
                      itself centers it reliably on every browser without depending on any
                      flexbox cross-axis sizing behavior. */}
                  <div id="preview-stage-container" ref={attachA4Scale} className="bg-ink-800 p-2 sm:p-8 rounded-2xl overflow-auto w-full">
                    <div className="a4-spacer mx-auto">
                    <div
                      id="invoice-print-area"
                      className={`a4-page @container bg-white w-[794px] text-ink-800 shadow-2xl relative overflow-hidden min-h-[1123px] flex flex-col justify-between border border-ink-300 ${customStyles.padding || 'p-8'} ${customStyles.body_size || 'text-xs'}`}
                      style={{
                        borderColor: customStyles.primary_color,
                        fontFamily: customStyles.font_family === 'Space Grotesk' ? '"Space Grotesk", sans-serif' :
                                    customStyles.font_family === 'Outfit' ? '"Outfit", sans-serif' :
                                    customStyles.font_family === 'Playfair Display' ? '"Playfair Display", serif' :
                                    customStyles.font_family === 'JetBrains Mono' ? '"JetBrains Mono", monospace'
                                    // Pinned, not inherited: the app chrome moved to Archivo and the
                                    // printed documents must not move with it.
                                    : 'Inter, system-ui, sans-serif'
                      }}
                    >
                      <div>
                        {/* Top accent bar */}
                        {activeTemp === 'modern' && (
                          <div className="absolute top-0 left-0 right-0 h-4" style={{ backgroundImage: `linear-gradient(to right, ${customStyles.primary_color}, #F59E0B)` }} />
                        )}
                        {activeTemp === 'bold' && (
                          <div className="absolute top-0 left-0 right-0 h-8 flex items-center justify-end px-6 text-2xs font-bold tracking-widest text-white uppercase" style={{ backgroundColor: customStyles.primary_color }}>
                            Official Customer Invoice Receipt Ledger
                          </div>
                        )}

                        {/* Header: logo + company + address. Uses a CONTAINER query (@lg,
                            keyed off this page's own rendered width via @container above)
                            rather than a viewport media query — @media (min-width) during
                            print evaluates against the device's screen, not the printed A4
                            page, which made mobile print diverge from desktop. A container
                            query instead reads this element's own width, which is genuinely
                            210mm during print regardless of device, so print/desktop always
                            render this row layout; only the on-screen mobile preview (where
                            this element is actually narrow) gets the stacked version. */}
                        <div className={`mt-4 flex flex-col items-center text-center gap-3 mb-6 @lg:gap-4 ${
                          customStyles.layout_order === 'logo-right' ? '@lg:flex-row-reverse @lg:justify-between @lg:items-start @lg:text-left' :
                          customStyles.layout_order === 'stacked' ? '@lg:flex-col @lg:items-center @lg:justify-center @lg:text-center' :
                          '@lg:flex-row @lg:justify-between @lg:items-start @lg:text-left'
                        }`}>
                          <div className={`flex gap-4 items-center min-w-0 ${customStyles.layout_order === 'stacked' ? 'flex-col' : 'flex-row'}`}>
                            {profile?.logo_url && (profile.logo_url.startsWith('http') || profile.logo_url.startsWith('data:image')) ? (
                              <img src={profile.logo_url} alt="Logo" className="max-h-20 w-auto max-w-[140px] object-contain shrink-0" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white font-black text-xl uppercase shadow-lg shrink-0" style={{ backgroundColor: customStyles.primary_color }}>
                                {profile ? outletInitials(profile) : '?'}
                              </div>
                            )}
                            <div className="min-w-0">
                              {parentCompanyName && <p className="text-2xs font-extrabold uppercase text-ink-500 tracking-wider mb-0.5 break-words">{parentCompanyName}</p>}
                              <h1 className={`font-black tracking-tight text-ink-900 leading-tight break-words ${customStyles.title_size || 'text-2xl'}`}>
                                {profile ? outletLabel(profile) : invoice.Company}
                              </h1>
                              {storeOutletName && (
                                <p className="text-2xs font-bold mt-0.5 uppercase break-words" style={{ color: customStyles.primary_color }}>
                                  Outlet: {storeOutletName}
                                </p>
                              )}
                            </div>
                          </div>
                          {/* min-w-0 (not shrink-0) lets this wrap instead of forcing the
                              header row wider than the page — flex items default to a
                              content-based minimum width that ignores normal text wrapping
                              unless this is set. */}
                          <div className={`text-2xs text-ink-500 leading-relaxed space-y-0.5 min-w-0 break-words text-center @lg:max-w-[55%] ${
                            customStyles.layout_order === 'logo-right' ? '@lg:text-left' : customStyles.layout_order === 'stacked' ? '@lg:text-center' : '@lg:text-right'
                          }`}>
                            <p className="font-semibold text-ink-700">{profile?.address}</p>
                            <p>Contact: {profile?.phone} | {profile?.email}</p>
                          </div>
                        </div>

                        <hr className="border-ink-200 mb-5" />

                        {/* Invoice ID + Status */}
                        <div className="flex items-start justify-between mb-5 gap-4">
                          <div className="flex-1">
                            <span className="text-2xs font-extrabold text-ink-500 uppercase tracking-widest block mb-1">Invoice Code ID</span>
                            <h3 className="text-2xl font-black text-ink-900 font-mono tracking-tight leading-none mb-3">{invoice.Invoice_ID}</h3>
                            <span className="text-2xs font-extrabold text-ink-500 uppercase tracking-widest block mb-1">Issued Stamp</span>
                            <p className="text-xs font-semibold text-ink-700">{invoice.Date?.split('T')[0] || invoice.Date}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="text-2xs font-extrabold text-ink-500 uppercase tracking-widest block mb-2">Status Summary</span>
                            <span className="inline-block px-4 py-1.5 rounded-lg font-extrabold text-2xs uppercase tracking-widest text-white"
                              style={{ backgroundColor: payStatusColor }}>
                              {PAYMENT_STATUS_LABEL[paySummary.status]}
                            </span>
                          </div>
                        </div>

                        <hr className="border-ink-100 mb-5" />

                        {/* Customer block */}
                        <div className="print-keep-together border border-ink-200 rounded-2xl p-4 mb-6 bg-white">
                          <span className="text-[8px] font-extrabold text-ink-500 uppercase tracking-widest block mb-2">Bill To Registered Customer</span>
                          <p className="text-sm font-black text-ink-900 mb-0.5">{invoice.Customer_Name}</p>
                          <p className="text-[10.5px] text-ink-500">Mobile / Email: {displayContact || '-'}</p>
                          {displayAddress && (
                            <div className="mt-3 pt-3 border-t border-ink-100">
                              <span className="text-[8px] font-extrabold text-ink-500 uppercase tracking-widest block mb-1">Physical Location Address:</span>
                              <p className="text-[10.5px] text-ink-600 font-medium whitespace-pre-line">{displayAddress}</p>
                            </div>
                          )}
                        </div>

                        {/* Line items. Quotation-converted invoices render grouped by
                            day → session (like the quotation); ordinary invoices fall
                            back to the original flat table. */}
                        {(() => {
                          const { grouped, ungrouped } = groupInvoiceItemsByDay(items);

                          const priceCell = (v: number) =>
                            v === 0 ? <span className="text-emerald-600 font-extrabold">FREE</span> : `${currencySymbol} ${v.toFixed(2)}`;

                          // Reusable rows renderer for a set of items.
                          const rowsOf = (rows: InvoiceItem[]) => rows.map((item, ri) => (
                            <tr key={ri} className={ri % 2 === 0 ? 'bg-white' : 'bg-ink-50/50'}>
                              <td className="py-2 px-3 font-semibold text-ink-900 break-words">{item.Item_Name}</td>
                              <td className="py-2 px-2 text-right font-mono text-ink-600">{priceCell(Number(item.Price) || 0)}</td>
                              <td className="py-2 px-2 text-center font-mono text-ink-600">{item.Quantity}</td>
                              <td className="py-2 px-3 text-right font-bold text-ink-900 font-mono">{priceCell(Number(item.Subtotal ?? item.Quantity * item.Price) || 0)}</td>
                            </tr>
                          ));

                          const colHead = (
                            <thead>
                              <tr className="bg-ink-50 text-ink-500 text-2xs font-bold uppercase tracking-wide">
                                <th className="py-1.5 px-3 text-left">Item Description</th>
                                <th className="py-1.5 px-2 text-right w-24">Unit Price</th>
                                <th className="py-1.5 px-2 text-center w-14">Qty</th>
                                <th className="py-1.5 px-3 text-right w-24">Subtotal</th>
                              </tr>
                            </thead>
                          );

                          // ── Ordinary invoice (no dated groups): original flat table ──
                          if (grouped.length === 0) {
                            return (
                              <div className="print-keep-together mb-6 overflow-hidden rounded-xl border border-ink-200">
                                <table className="w-full table-fixed text-2xs border-collapse text-left">
                                  <thead>
                                    <tr className="text-white text-2xs font-bold uppercase tracking-wider"
                                      style={{ backgroundColor: customStyles.primary_color }}>
                                      <th className="py-2.5 px-3 w-8">#</th>
                                      <th className="py-2.5 px-2">Item Description</th>
                                      <th className="py-2.5 px-2 text-right w-20">Unit Price</th>
                                      <th className="py-2.5 px-2 text-center w-14">Qty</th>
                                      <th className="py-2.5 px-3 text-right w-20">Subtotal</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-ink-100">
                                    {items.length > 0 ? items.map((item, idx) => (
                                      <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-ink-50/50'}>
                                        <td className="py-2.5 px-3 text-ink-500 font-mono">{idx + 1}</td>
                                        <td className="py-2.5 px-2 font-semibold text-ink-900 break-words">{item.Item_Name}</td>
                                        <td className="py-2.5 px-2 text-right font-mono text-ink-600">{priceCell(Number(item.Price) || 0)}</td>
                                        <td className="py-2.5 px-2 text-center font-mono text-ink-600">{item.Quantity}</td>
                                        <td className="py-2.5 px-3 text-right font-bold text-ink-900 font-mono">{priceCell(Number(item.Subtotal ?? item.Quantity * item.Price) || 0)}</td>
                                      </tr>
                                    )) : (
                                      <tr>
                                        <td colSpan={5} className="py-6 text-center text-ink-500 italic text-xs">No line items recorded</td>
                                      </tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            );
                          }

                          // ── Converted invoice: grouped day → session layout ──
                          return (
                            <div className="mb-6 space-y-4">
                              {grouped.map((day, di) => (
                                <div key={di} className="print-keep-together overflow-hidden rounded-xl border border-ink-200">
                                  <div className="px-3 py-2.5 text-white" style={{ backgroundColor: customStyles.primary_color }}>
                                    <p className="text-2xs font-bold">{day.dayLabel}</p>
                                  </div>
                                  {day.sessions.map((sess, si) => (
                                    <div key={si} className={`print-keep-together ${si > 0 ? 'border-t border-ink-200' : ''}`}>
                                      {sess.label && (
                                        <div className="px-3 py-2 bg-ink-50 border-l-[3px]" style={{ borderColor: customStyles.primary_color }}>
                                          <span className="text-2xs font-extrabold uppercase tracking-wide" style={{ color: customStyles.primary_color }}>{sess.label}</span>
                                        </div>
                                      )}
                                      <table className="w-full table-fixed text-2xs border-collapse text-left">
                                        {colHead}
                                        <tbody className="divide-y divide-ink-100">{rowsOf(sess.rows)}</tbody>
                                      </table>
                                    </div>
                                  ))}
                                  <div className="px-3 py-1.5 bg-ink-100 text-right text-2xs font-bold text-ink-700 border-t border-ink-200">
                                    Day Subtotal: {currencySymbol} {day.total.toFixed(2)}
                                  </div>
                                </div>
                              ))}

                              {ungrouped.length > 0 && (
                                <div className="print-keep-together overflow-hidden rounded-xl border border-ink-200">
                                  <div className="px-3 py-2.5 text-white" style={{ backgroundColor: customStyles.primary_color }}>
                                    <p className="text-2xs font-bold">Additional Charges</p>
                                  </div>
                                  <table className="w-full table-fixed text-2xs border-collapse text-left">
                                    {colHead}
                                    <tbody className="divide-y divide-ink-100">{rowsOf(ungrouped)}</tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* Totals + remittance — @lg container query (see header above for
                            why container query, not sm: viewport breakpoint). */}
                        <div className="print-keep-together flex flex-col @lg:flex-row justify-between items-start gap-5 mb-8">
                          <div className="flex-1 min-w-0 w-full space-y-3 @lg:max-w-xs">
                            {invoice.Notes && invoice.Notes.trim() && (
                              <div>
                                <span className="text-[8px] font-extrabold text-ink-500 uppercase tracking-widest block mb-1">Remarks / Notes</span>
                                <p className="text-[10.5px] text-ink-600 leading-relaxed break-words">{invoice.Notes}</p>
                              </div>
                            )}
                            <div>
                              <span className="text-[8px] font-extrabold text-ink-500 uppercase tracking-widest block mb-1">Remittance Instructions</span>
                              <p className="text-2xs text-ink-800 font-bold break-words whitespace-pre-line">{profile?.payment_info || 'Direct cash settlement before collection.'}</p>
                            </div>
                          </div>
                          <div className="w-full @lg:w-[230px] border border-ink-200 rounded-xl p-4 bg-white space-y-2.5 shrink-0">
                            <div className="flex justify-between items-center text-2xs">
                              <span className="text-ink-500">Subtotal Amount:</span>
                              <span className="font-mono font-semibold text-ink-800">{currencySymbol} {(invoice.Subtotal_Amount ?? invoice.Total_Amount).toFixed(2)}</span>
                            </div>
                            {invoice.Discount_Type && invoice.Discount_Type !== 'none' && (
                              <div className="flex justify-between items-center text-2xs">
                                <span className="text-ink-500">Discount:</span>
                                <span className="font-mono font-bold text-amber-700">
                                  {invoice.Discount_Type === 'percentage' ? `${invoice.Discount_Value}% Off` : `-${currencySymbol} ${(invoice.Discount_Value || 0).toFixed(2)}`}
                                </span>
                              </div>
                            )}
                            <div className="border-t border-ink-200 pt-2.5 flex justify-between items-center">
                              <span className="text-sm font-black text-ink-900">Grand Total:</span>
                              <span className="text-sm font-black font-mono" style={{ color: customStyles.primary_color }}>
                                {currencySymbol} {invoice.Total_Amount.toFixed(2)}
                              </span>
                            </div>
                            {/* Payment breakdown — only shown once payments exist */}
                            {paySummary.paid > 0 && paySummary.status !== 'Paid' && (
                              <>
                                <div className="flex justify-between items-center text-2xs pt-1">
                                  <span className="text-ink-500">Amount Paid:</span>
                                  <span className="font-mono font-bold text-emerald-600">{currencySymbol} {paySummary.paid.toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between items-center">
                                  <span className="text-xs font-black text-ink-900">Balance Due:</span>
                                  <span className="text-xs font-black font-mono text-rose-600">{currencySymbol} {paySummary.balance.toFixed(2)}</span>
                                </div>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Payment history — audit trail for partially/fully paid invoices */}
                        {invoicePayments.length > 0 && (
                          <div className="print-keep-together mb-8">
                            <span className="text-[8px] font-extrabold text-ink-500 uppercase tracking-widest block mb-2">Payment History</span>
                            <div className="overflow-hidden rounded-xl border border-ink-200">
                              <table className="w-full text-[10.5px] border-collapse text-left">
                                <thead>
                                  <tr className="bg-ink-50 text-ink-500 text-2xs font-bold uppercase tracking-wide">
                                    <th className="py-1.5 px-3">Date</th>
                                    <th className="py-1.5 px-2">Method</th>
                                    <th className="py-1.5 px-2">Reference</th>
                                    <th className="py-1.5 px-3 text-right">Amount</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-ink-100">
                                  {invoicePayments.map(pm => (
                                    <tr key={pm.Payment_ID}>
                                      <td className="py-1.5 px-3 text-ink-700">{pm.Date}</td>
                                      <td className="py-1.5 px-2 text-ink-600">{pm.Method || '-'}</td>
                                      <td className="py-1.5 px-2 text-ink-600 break-words">{pm.Reference || '-'}</td>
                                      <td className="py-1.5 px-3 text-right font-bold font-mono text-ink-900">{currencySymbol} {(Number(pm.Amount) || 0).toFixed(2)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Footer */}
                      <div className="border-t border-ink-200 pt-5 mt-auto text-center space-y-1 select-none">
                        <p className="text-2xs font-bold text-ink-500 italic uppercase tracking-wide leading-relaxed whitespace-pre-line">
                          {customStyles.terms_footer || profile?.footer_text || 'Payment is due within 30 days.'}
                        </p>
                        <p className="text-[8px] font-mono text-ink-300 uppercase tracking-widest">Generated Securely by BizEazyInvoicing</p>
                      </div>
                    </div>
                    </div>
                  </div>
                </div>

                {/* Footer bar */}
                <div id="preview-studio-footer" className="p-4 flex justify-end bg-ink-900 border-t border-ink-800">
                  <button onClick={() => { setIsPreviewOpen(false); setPreviewInvoiceId(null); }}
                    className="px-5 py-2 cursor-pointer bg-ink-800 hover:bg-ink-700 text-ink-200 font-extrabold text-xs rounded-xl">
                    Close Studio View
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          );
        })()
      )}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <ConfirmedMoment />
    </div>
  );
}
