import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  loadAll, saveChanges, loadConfig, saveConfig, importSheetExport, forgetLoaded, EMPTY_DB, KINDS,
  backupJson, workbookSheets, recentChanges, Change,
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
import { PayrollDashboard } from './components/PayrollDashboard';
import InvoicingModule from './components/InvoicingModule';
import QuotationModule from './components/QuotationModule';
import {
  LayoutDashboard, FileText, Users, LogOut, Moon, Sun, RefreshCw,
  Building2, TrendingUp, Clock, Loader2, X, AlertTriangle, ArrowRight,
  CreditCard, Settings, Menu, Upload, CalendarRange, UserCog, BarChart3,
} from 'lucide-react';
import { ReportsView } from './components/ReportsView';

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

  Object.keys(gasConfig).forEach(key => {
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
  const colorMap: Record<Toast['type'], string> = {
    success: 'bg-emerald-600',
    error: 'bg-red-600',
    warning: 'bg-amber-500',
    info: 'bg-brand-600',
  };
  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-white text-xs font-semibold max-w-sm pointer-events-auto ${colorMap[t.type]}`}
        >
          <span className="flex-1">{t.message}</span>
          <button onClick={() => onRemove(t.id)} className="opacity-75 hover:opacity-100 cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
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
      fixed inset-y-0 left-0 z-50 w-56
      transform transition-transform duration-300 ease-in-out
      ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'}
      md:relative md:translate-x-0 md:flex-shrink-0
      bg-white dark:bg-ink-950 border-r border-ink-200 dark:border-ink-800 flex flex-col h-screen md:sticky md:top-0
    `}>
      {/* Logo */}
      <div className="px-4 py-4 border-b border-ink-100 dark:border-ink-800 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm">
            <Building2 className="w-3.5 h-3.5 text-white" />
          </div>
          <div>
            <div className="text-sm font-black tracking-tight text-ink-900 dark:text-white">BizEazy</div>
            <div className="text-2xs text-ink-500 dark:text-ink-400 font-semibold uppercase tracking-wider">Operations Hub</div>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.filter(({ view }) => allowed(view)).map(({ view, Icon, label }) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              onClick={() => setActiveView(view)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                active
                  ? 'bg-brand-50 dark:bg-brand-950/60 text-brand-700 dark:text-brand-300'
                  : 'text-ink-600 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800/60 hover:text-ink-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5 flex-shrink-0" />
              {label}
            </button>
          );
        })}
      </nav>

      {/* Branch selector */}
      <div className="px-2 py-2 border-t border-ink-100 dark:border-ink-800 flex-shrink-0">
        <div className="text-2xs font-bold uppercase tracking-wider text-ink-500 dark:text-ink-400 px-2 mb-1.5">Active Branch</div>
        <div className="space-y-0.5">
          {profiles.map((p, idx) => {
            const branchName = outletLabel(p);
            const isActive = activeBranchLocation.toLowerCase() === branchName.toLowerCase();
            return (
              <button
                key={p.id}
                onClick={() => setActiveBranchLocation(branchName)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-2xs font-medium transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-ink-900 dark:bg-white text-white dark:text-ink-900'
                    : 'text-ink-500 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800'
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
      <div className="px-2 py-2 border-t border-ink-100 dark:border-ink-800 space-y-0.5 flex-shrink-0">
        <button
          onClick={onRefresh}
          disabled={isDataLoading}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-500 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 flex-shrink-0 ${isDataLoading ? 'animate-spin' : ''}`} />
          {isDataLoading ? 'Syncing…' : 'Refresh Data'}
        </button>
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-500 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors cursor-pointer"
        >
          <Settings className="w-3.5 h-3.5 flex-shrink-0" />
          Data & Import
        </button>
        {allowed('settings') && (
          <button
            onClick={onOpenProfiles}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-500 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors cursor-pointer"
          >
            <Building2 className="w-3.5 h-3.5 flex-shrink-0" />
            Company Profiles
          </button>
        )}
        <button
          onClick={onOpenUsers}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-500 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors cursor-pointer"
        >
          <UserCog className="w-3.5 h-3.5 flex-shrink-0" />
          {user?.role === 'admin' ? 'Users & Access' : 'My Password'}
        </button>
        <button
          onClick={() => setIsDark(!isDark)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-500 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800/60 transition-colors cursor-pointer"
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
        resolvedProfiles = gasConfigToProfiles(await loadConfig());
        setProfiles(resolvedProfiles);
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
      await saveConfig(gasConfig);
      setProfiles(updated);
      setIsProfilesOpen(false);
      triggerToast('Company profiles saved.', 'success');
    } catch (err: any) {
      triggerToast(`Profile save failed: ${err.message}`, 'error');
    }
  };

  const viewTitle: Record<AppView, string> = {
    hub: 'Hub Overview', invoicing: 'Invoicing Module', payroll: 'Payroll Module',
    quotations: 'Quotations Module', reports: 'Reports',
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
  if (activeView === 'hub') {
    const activeProfile = resolveActiveOutlet(profiles, activeBranchLocation);
    const activeOutlet   = activeProfile?.id || '';
    const activeOutletName = activeProfile ? outletLabel(activeProfile) : '';
    const dm = isDark;

    const activeInvoicesHub  = db.invoices.filter(inv => inv.Company === activeOutlet);
    const totalInvoicedHub   = activeInvoicesHub.reduce((s, i) => s + (Number(i.Total_Amount) || 0), 0);
    // Collected/Outstanding are derived from ACTUAL recorded payments (not the
    // legacy Status field) so partial payments tally correctly.
    const hubPay = activeInvoicesHub.reduce((acc, i) => {
      const s = getPaymentSummary(i, db.payments);
      acc.collected += s.paid;
      acc.pending += s.balance;
      if (s.status === 'Paid') acc.paidCount++; else acc.unpaidCount++;
      return acc;
    }, { collected: 0, pending: 0, paidCount: 0, unpaidCount: 0 });
    const collectedHub       = hubPay.collected;
    const pendingHub         = hubPay.pending;
    const paidCountHub       = hubPay.paidCount;
    const unpaidCountHub     = hubPay.unpaidCount;
    const activeEmployeesHub = db.employees?.filter(e => e.Assigned_Outlet === activeOutlet) || [];
    const savedPayslipsHub   = db.payslips?.filter(p => p.Is_Saved) || [];
    const activeQuotationsHub = db.quotations?.filter(q => q.Company === activeOutlet) || [];
    const expiredQuotationsHub = activeQuotationsHub.filter(q => !!q.Valid_Until && new Date(q.Valid_Until) < new Date(new Date().toDateString())).length;
    const recentInvoicesHub  = [...activeInvoicesHub]
      .sort((a, b) => new Date(b.Date || '').getTime() - new Date(a.Date || '').getTime())
      .slice(0, 5);
    const recentPayslipsHub  = [...savedPayslipsHub]
      .sort((a, b) => new Date(b.Issue_Date || '').getTime() - new Date(a.Issue_Date || '').getTime())
      .slice(0, 4);
    const currHub = profiles.find(p => p.id === activeOutlet)?.currency_symbol || 'RM';
    const fmtAmt  = (n: number) =>
      `${currHub} ${n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    return (
      <div className={`min-h-screen flex transition-colors duration-300 ${dm ? 'bg-[#0b0f1a] text-ink-100' : 'bg-[#f1f5f9] text-ink-900'}`}>

        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <aside className={`hidden md:flex w-56 shrink-0 flex-col border-r sticky top-0 h-screen transition-colors duration-300 ${dm ? 'bg-[#0f1623] border-ink-800' : 'bg-white border-ink-200'}`}>

          {/* Logo */}
          <div className={`px-5 py-4 border-b ${dm ? 'border-ink-800' : 'border-ink-100'}`}>
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 bg-brand-600 rounded-lg flex items-center justify-center shadow-[0_2px_8px_rgba(79,70,229,0.4)]">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              </div>
              <div>
                <p className="text-xs font-black tracking-widest text-brand-500 uppercase leading-none">BizEazy</p>
                <p className={`text-2xs font-bold uppercase tracking-wider leading-none mt-0.5 ${dm ? 'text-ink-500' : 'text-ink-500'}`}>Operations Hub</p>
              </div>
            </div>
          </div>

          {/* Nav */}
          <nav className="flex-1 py-4 space-y-0.5 px-3">
            <button className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${dm ? 'bg-ink-800 text-brand-400' : 'bg-brand-50 text-brand-700'}`}>
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              Hub Overview
            </button>
{allowed('invoicing') && (
              <button
                onClick={() => { setActiveView('invoicing'); triggerToast('Entering Invoicing Console...', 'success'); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-200' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'}`}
              >
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                Invoicing
              </button>
            )}
{allowed('quotations') && (
              <button
                onClick={() => { setActiveView('quotations'); triggerToast('Entering Quotations Console...', 'success'); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-200' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'}`}
              >
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                Quotations
              </button>
            )}
{allowed('payroll') && (
              <button
                onClick={() => { setActiveView('payroll'); triggerToast('Entering Payslip Console...', 'success'); }}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-200' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'}`}
              >
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                Payroll
              </button>
            )}
          </nav>

          {/* Branch selector */}
          <div className={`px-3 py-3 border-t space-y-1 ${dm ? 'border-ink-800' : 'border-ink-100'}`}>
            <p className={`text-2xs font-bold uppercase tracking-widest px-2 mb-2 ${dm ? 'text-ink-600' : 'text-ink-500'}`}>Active Branch</p>
            {profiles.map((p, idx) => ({ id: p.id, label: outletLabel(p), color: outletColor(p, idx) })).map(b => (
              <button
                key={b.id}
                onClick={() => {
                  setActiveBranchLocation(b.label);
                  triggerToast(`Switched to ${b.label}`, 'success');
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-2xs font-semibold transition-all cursor-pointer text-left ${
                  activeOutlet === b.id
                    ? (dm ? 'bg-ink-700 text-white' : 'bg-ink-100 text-ink-900 font-bold')
                    : (dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-300' : 'text-ink-500 hover:bg-ink-50')
                }`}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: b.color }} />
                {b.label}
              </button>
            ))}
          </div>

          {/* Bottom actions */}
          <div className={`px-3 py-3 border-t space-y-0.5 ${dm ? 'border-ink-800' : 'border-ink-100'}`}>
            <button
              onClick={() => loadData(spreadsheetId)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-2xs font-semibold cursor-pointer transition-all ${dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-200' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'}`}
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
              Refresh Data
            </button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-2xs font-semibold cursor-pointer transition-all ${dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-200' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'}`}
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg>
              Data & Import
            </button>
            {allowed('settings') && (
              <button
                onClick={() => setIsProfilesOpen(true)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-2xs font-semibold cursor-pointer transition-all ${dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-200' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'}`}
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
                Company Profiles
              </button>
            )}
            <button
              onClick={() => setIsUsersOpen(true)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-2xs font-semibold cursor-pointer transition-all ${dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-200' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'}`}
            >
              <UserCog className="w-3.5 h-3.5 shrink-0" />
              {session.user.role === 'admin' ? 'Users & Access' : 'My Password'}
            </button>
            <button
              onClick={() => { setIsDark(p => !p); triggerToast(`Switched to ${!isDark ? 'Dark' : 'Light'} mode`, 'success'); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-2xs font-semibold cursor-pointer transition-all ${dm ? 'text-ink-500 hover:bg-ink-800 hover:text-ink-200' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-800'}`}
            >
              {isDark
                ? <><svg className="w-3.5 h-3.5 shrink-0 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><circle cx="12" cy="12" r="5"/><path strokeLinecap="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>Light Mode</>
                : <><svg className="w-3.5 h-3.5 shrink-0 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>Dark Mode</>
              }
            </button>
            <button
              onClick={() => { handleSignOut().then(() => triggerToast('Signed out.', 'success')); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-2xs font-semibold cursor-pointer transition-all text-rose-500 hover:bg-rose-500/10"
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
              Sign Out
            </button>
          </div>

          {/* User chip */}
          <div className={`px-4 py-3 border-t ${dm ? 'border-ink-800' : 'border-ink-100'}`}>
            <div className="flex items-center gap-2.5">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-2xs font-black uppercase ${dm ? 'bg-brand-500/20 text-brand-400' : 'bg-brand-100 text-brand-700'}`}>
                {(session.user.full_name || session.user.user_id || 'U')[0]}
              </div>
              <div className="min-w-0">
                <p className={`text-2xs font-bold truncate ${dm ? 'text-ink-200' : 'text-ink-800'}`}>{session.user.full_name || session.user.user_id}</p>
                <p className={`text-2xs font-semibold truncate ${dm ? 'text-ink-500' : 'text-ink-500'}`}>
                  {session.user.role === 'admin' ? 'Admin' : 'Member'} · {session.company.company_name}
                </p>
              </div>
            </div>
          </div>
        </aside>

        {/* ── Main Content ──────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto">
          {/* Mobile top bar — visible only on small screens */}
          <div className={`md:hidden flex items-center justify-between px-4 py-3 border-b sticky top-0 z-20 ${dm ? 'bg-[#0f1623] border-ink-800' : 'bg-white border-ink-200'}`}>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-brand-600 rounded-lg flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              </div>
              <span className={`text-xs font-black tracking-widest uppercase ${dm ? 'text-brand-400' : 'text-brand-600'}`}>BizEazy</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => setIsDark(p => !p)} aria-label={dm ? 'Switch to light mode' : 'Switch to dark mode'}
                className={`tap flex items-center justify-center rounded-lg cursor-pointer ${dm ? 'bg-ink-800 text-ink-300' : 'bg-ink-100 text-ink-600'}`}>
                {dm
                  ? <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><circle cx="12" cy="12" r="5"/><path strokeLinecap="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2"/></svg>
                  : <svg className="w-3.5 h-3.5 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
                }
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                aria-label="Connection settings"
                className={`tap flex items-center justify-center rounded-lg cursor-pointer ${dm ? 'bg-ink-800 text-ink-300' : 'bg-ink-100 text-ink-600'}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </button>
            </div>
          </div>
          {/* Branch switcher — mobile only */}
          <div className={`md:hidden flex items-center gap-2 px-4 py-2 border-b ${dm ? 'border-ink-800 bg-[#0f1623]' : 'border-ink-100 bg-white'}`}>
            <span className={`text-2xs font-bold uppercase tracking-wider ${dm ? 'text-ink-500' : 'text-ink-500'}`}>Branch:</span>
            <div className="flex items-center gap-2 overflow-x-auto">
              {profiles.map(p => {
                const label = outletLabel(p);
                return (
                  <button
                    key={p.id}
                    onClick={() => setActiveBranchLocation(label)}
                    className={`px-2.5 py-1 text-2xs font-bold rounded-full whitespace-nowrap transition-colors cursor-pointer ${
                      activeOutlet === p.id
                        ? 'bg-brand-600 text-white'
                        : (dm ? 'text-ink-500 hover:text-ink-200' : 'text-ink-500 hover:text-ink-700')
                    }`}
                  >{label}</button>
                );
              })}
            </div>
          </div>
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-8 space-y-5 sm:space-y-8 pb-nav md:pb-8">

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className={`text-xl font-black tracking-tight ${dm ? 'text-white' : 'text-ink-900'}`}>Hub Overview</h1>
                <p className={`text-xs font-medium mt-0.5 truncate ${dm ? 'text-ink-500' : 'text-ink-500'}`}>
                  {activeOutletName || activeOutlet}
                </p>
              </div>
              <NotificationBell notifications={notifications} isDark={isDark} onOpenView={setActiveView} />
            </div>

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

            {/* 4 stat cards */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              {[
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>, color: 'text-brand-400', bg: dm ? 'bg-brand-500/10' : 'bg-brand-50', label: 'Total Invoiced', value: fmtAmt(totalInvoicedHub), sub: `${activeInvoicesHub.length} invoice${activeInvoicesHub.length !== 1 ? 's' : ''}` },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>, color: 'text-emerald-400', bg: dm ? 'bg-emerald-500/10' : 'bg-emerald-50', label: 'Collected Revenue', value: fmtAmt(collectedHub), sub: `${paidCountHub} paid` },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, color: 'text-amber-400', bg: dm ? 'bg-amber-500/10' : 'bg-amber-50', label: 'Pending Outstanding', value: fmtAmt(pendingHub), sub: `${unpaidCountHub} unpaid` },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>, color: 'text-brand-400', bg: dm ? 'bg-brand-500/10' : 'bg-brand-50', label: 'Active Employees', value: String(activeEmployeesHub.length), sub: `${savedPayslipsHub.length} saved payslips` },
              ].map((card, i) => (
                <div key={i} className={`rounded-2xl p-3.5 sm:p-5 border transition-colors ${dm ? 'bg-[#0f1623] border-ink-800' : 'bg-white border-ink-200 shadow-sm'}`}>
                  <div className={`w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center mb-2 sm:mb-3 ${card.bg} ${card.color}`}>{card.icon}</div>
                  {firstLoad
                    ? <Skeleton className="h-[1.125rem] sm:h-6 w-20 sm:w-28" />
                    : <p className={`text-lg sm:text-2xl font-black tracking-tight leading-none ${dm ? 'text-white' : 'text-ink-900'}`}>{card.value}</p>}
                  <p className={`text-2xs font-bold uppercase tracking-wider mt-1 ${dm ? 'text-ink-500' : 'text-ink-500'}`}>{card.label}</p>
                  {firstLoad
                    ? <Skeleton className="h-2.5 w-16 mt-1.5" />
                    : <p className={`text-2xs font-semibold mt-0.5 ${dm ? 'text-ink-600' : 'text-ink-500'}`}>{card.sub}</p>}
                </div>
              ))}
            </div>

            {/* Module shortcuts */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>, view: 'invoicing' as AppView, label: 'Invoicing Module', desc: 'Create, manage & track invoices', cta: 'Open →', accent: 'indigo', onClick: () => { setActiveView('invoicing'); triggerToast('Entering Invoicing Console...', 'success'); }, stat1Label: 'Total Invoices', stat1Val: String(activeInvoicesHub.length), stat2Label: 'Pending', stat2Val: String(unpaidCountHub), stat2Warn: unpaidCountHub > 0 },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>, view: 'quotations' as AppView, label: 'Quotations Module', desc: 'Multi-day catering quotes & estimates', cta: 'Open →', accent: 'indigo', onClick: () => { setActiveView('quotations'); triggerToast('Entering Quotations Console...', 'success'); }, stat1Label: 'Quotations', stat1Val: String(activeQuotationsHub.length), stat2Label: 'Expired', stat2Val: String(expiredQuotationsHub), stat2Warn: expiredQuotationsHub > 0 },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>, view: 'payroll' as AppView, label: 'Payroll Module', desc: 'Employee roster & payslip generator', cta: 'Open →', accent: 'indigo', onClick: () => { setActiveView('payroll'); triggerToast('Entering Payslip Console...', 'success'); }, stat1Label: 'Employees', stat1Val: String(activeEmployeesHub.length), stat2Label: 'Saved Payslips', stat2Val: String(savedPayslipsHub.length), stat2Warn: false },
              ].filter(mod => allowed(mod.view)).map((mod, i) => (
                <div key={i} className={`rounded-2xl border p-4 sm:p-5 transition-all ${dm ? 'bg-[#0f1623] border-ink-800 hover:border-ink-700' : 'bg-white border-ink-200 hover:border-ink-300 shadow-sm hover:shadow-md'}`}>
                  <div className="flex items-start justify-between mb-3 sm:mb-4">
                    <div className={`w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center ${mod.accent === 'emerald' ? (dm ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-50 text-emerald-600') : (dm ? 'bg-brand-500/15 text-brand-400' : 'bg-brand-50 text-brand-600')}`}>{mod.icon}</div>
                    <button onClick={mod.onClick} className={`text-2xs font-bold cursor-pointer transition-colors ${mod.accent === 'emerald' ? (dm ? 'text-emerald-400 hover:text-emerald-300' : 'text-emerald-600 hover:text-emerald-800') : (dm ? 'text-brand-400 hover:text-brand-300' : 'text-brand-600 hover:text-brand-800')}`}>{mod.cta}</button>
                  </div>
                  <p className={`text-sm font-black tracking-tight ${dm ? 'text-white' : 'text-ink-900'}`}>{mod.label}</p>
                  <p className={`text-2xs font-medium mt-0.5 mb-3 sm:mb-4 ${dm ? 'text-ink-500' : 'text-ink-500'}`}>{mod.desc}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[{ label: mod.stat1Label, val: mod.stat1Val, warn: false }, { label: mod.stat2Label, val: mod.stat2Val, warn: mod.stat2Warn }].map((s, j) => (
                      <div key={j} className={`rounded-xl px-3 py-2.5 ${dm ? 'bg-ink-900' : 'bg-ink-50'}`}>
                        {firstLoad
                          ? <Skeleton className="h-[1.125rem] w-8" />
                          : <p className={`text-lg font-black leading-none ${s.warn ? 'text-amber-400' : (dm ? 'text-white' : 'text-ink-900')}`}>{s.val}</p>}
                        <p className={`text-2xs font-bold uppercase tracking-wider mt-0.5 ${dm ? 'text-ink-600' : 'text-ink-500'}`}>{s.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Recent activity */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

              {/* Recent Invoices — 2/3 */}
              <div className={`lg:col-span-2 rounded-2xl border transition-colors ${dm ? 'bg-[#0f1623] border-ink-800' : 'bg-white border-ink-200 shadow-sm'}`}>
                <div className={`flex items-center justify-between px-5 py-4 border-b ${dm ? 'border-ink-800' : 'border-ink-100'}`}>
                  <div>
                    <p className={`text-sm font-black tracking-tight ${dm ? 'text-white' : 'text-ink-900'}`}>Recent Invoices</p>
                    <p className={`text-2xs font-medium ${dm ? 'text-ink-600' : 'text-ink-500'}`}>{activeOutletName}</p>
                  </div>
                  <button onClick={() => { setActiveView('invoicing'); triggerToast('Opening Invoicing...', 'success'); }} className={`text-2xs font-bold cursor-pointer transition-colors ${dm ? 'text-brand-400 hover:text-brand-300' : 'text-brand-600 hover:text-brand-800'}`}>View All →</button>
                </div>
                <div className="divide-y divide-ink-100 dark:divide-ink-800/60">
                  {firstLoad ? (
                    <SkeletonRows rows={5} />
                  ) : recentInvoicesHub.length === 0 ? (
                    <EmptyState
                      compact
                      icon={<FileText />}
                      title="No invoices yet"
                      body={`The latest invoices for ${activeOutletName || 'this branch'} will show here.`}
                      action={allowed('invoicing') ? { label: 'Open Invoicing', onClick: () => setActiveView('invoicing') } : undefined}
                    />
                  ) : recentInvoicesHub.map(inv => (
                    <div key={inv.Invoice_ID} className={`flex items-center justify-between px-5 py-3.5 transition-colors ${dm ? 'hover:bg-ink-800/50' : 'hover:bg-ink-50/80'}`}>
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${dm ? 'bg-ink-800' : 'bg-ink-100'}`}>
                          <svg className={`w-4 h-4 ${dm ? 'text-ink-500' : 'text-ink-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                        </div>
                        <div className="min-w-0">
                          <button
                            onClick={() => {
                              setPreviewInvoiceId(inv.Invoice_ID);
                              setIsPreviewOpen(true);
                              setActiveView('invoicing');
                            }}
                            className={`text-xs font-black font-mono tracking-tight truncate block cursor-pointer transition-colors ${dm ? 'text-brand-400 hover:text-brand-300' : 'text-brand-700 hover:text-brand-900'}`}
                          >
                            {inv.Invoice_ID}
                          </button>
                          <p className={`text-2xs truncate ${dm ? 'text-ink-500' : 'text-ink-500'}`}>{inv.Customer_Name} · {inv.Date?.split('T')[0] || '-'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className={`text-xs font-black font-mono ${dm ? 'text-ink-200' : 'text-ink-800'}`}>{currHub} {(Number(inv.Total_Amount) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</span>
                        {(() => {
                          const st = getPaymentSummary(inv, db.payments).status;
                          const cls = st === 'Paid' ? (dm ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-100 text-emerald-700')
                            : st === 'Partial' ? (dm ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-100 text-amber-700')
                            : (dm ? 'bg-rose-500/15 text-rose-400' : 'bg-rose-100 text-rose-700');
                          return <span className={`text-2xs font-black uppercase px-2 py-0.5 rounded-full ${cls}`}>{PAYMENT_STATUS_LABEL[st]}</span>;
                        })()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Saved Payslips — 1/3 */}
              <div className={`rounded-2xl border transition-colors ${dm ? 'bg-[#0f1623] border-ink-800' : 'bg-white border-ink-200 shadow-sm'}`}>
                <div className={`flex items-center justify-between px-5 py-4 border-b ${dm ? 'border-ink-800' : 'border-ink-100'}`}>
                  <p className={`text-sm font-black tracking-tight ${dm ? 'text-white' : 'text-ink-900'}`}>Saved Payslips</p>
                  <button onClick={() => { setActiveView('payroll'); triggerToast('Opening Payroll...', 'success'); }} className={`text-2xs font-bold cursor-pointer transition-colors ${dm ? 'text-brand-400 hover:text-brand-300' : 'text-brand-600 hover:text-brand-800'}`}>View All →</button>
                </div>
                <div className="divide-y divide-ink-100 dark:divide-ink-800/60">
                  {firstLoad ? (
                    <SkeletonRows rows={4} />
                  ) : recentPayslipsHub.length === 0 ? (
                    <EmptyState
                      compact
                      icon={<Users />}
                      title="No payslips yet"
                      body="Generate the month's payslips in Payroll. Saved ones show here."
                      action={allowed('payroll') ? { label: 'Open Payroll', onClick: () => setActiveView('payroll') } : undefined}
                    />
                  ) : recentPayslipsHub.map(ps => {
                    const emp = db.employees?.find(e => e.Employee_ID === ps.Employee_ID);
                    return (
                      <div key={ps.Payslip_ID} className={`px-5 py-3.5 transition-colors ${dm ? 'hover:bg-ink-800/50' : 'hover:bg-ink-50/80'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className={`text-2xs font-black truncate ${dm ? 'text-ink-200' : 'text-ink-800'}`}>{emp?.Employee_Name || ps.Employee_ID}</p>
                            <p className={`text-2xs font-semibold mt-0.5 ${dm ? 'text-ink-600' : 'text-ink-500'}`}>{(() => {
                              const raw = ps.Month_Year || ps.Issue_Date || '';
                              if (raw.includes('T') || raw.match(/^\d{4}-\d{2}-\d{2}/)) {
                                const d = new Date(raw);
                                if (!isNaN(d.getTime())) {
                                  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
                                  return `${months[d.getMonth()]} ${d.getFullYear()}`;
                                }
                              }
                              return raw || '-';
                            })()}</p>
                          </div>
                          <p className={`text-2xs font-black font-mono shrink-0 ${dm ? 'text-brand-400' : 'text-brand-600'}`}>{currHub} {(Number(ps.Final_Net_Pay) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

          </div>
        </main>

        {/* Modals + toasts share the hub layout */}
        {isProfilesOpen && (
          <CompanyProfilesModal profiles={profiles} db={db} isDark={isDark} onClose={() => setIsProfilesOpen(false)} onSave={handleProfilesSave} />
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
          onNavigate={setActiveView}
          allowed={allowed}
          badgeCount={notifications.filter(n => n.view === 'payroll').length}
        />
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </div>
    );
  }

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
          <header className="bg-white dark:bg-ink-950 border-b border-ink-200 dark:border-ink-800 px-4 md:px-6 py-3 flex items-center justify-between flex-shrink-0">
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
                <h1 className="text-sm font-bold text-ink-900 dark:text-white">{viewTitle[activeView]}</h1>
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
            {firstLoad ? (
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
            ) : (<>
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
              />
            )}
            </>)}
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
    </div>
  );
}
