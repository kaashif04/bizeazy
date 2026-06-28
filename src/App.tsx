import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { User } from 'firebase/auth';
import {
  initAuth, googleSignIn, logout as firebaseLogout,
  fetchDataAll, syncStateToSheets, setApiUrl, getApiUrl,
  fetchAppConfigFromAppsScript, saveAppConfigToAppsScript,
} from './sheetsService';
import { DatabaseState, CompanyProfile, TemplateCustomization } from './types';
import { PayrollDashboard } from './components/PayrollDashboard';
import InvoicingModule from './components/InvoicingModule';
import QuotationModule from './components/QuotationModule';
import {
  LayoutDashboard, FileText, Users, LogOut, Moon, Sun, RefreshCw,
  Building2, TrendingUp, Clock, Loader2, X, AlertTriangle, ArrowRight,
  CreditCard, Settings, Menu, Upload, CalendarRange,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────
type AppView = 'hub' | 'invoicing' | 'payroll' | 'quotations';
type AuthStatus = 'loading' | 'unauthenticated' | 'needs-setup' | 'authenticated';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'warning' | 'info';
}

// ─── Constants ────────────────────────────────────────────────────────────────
const EMPTY_DB: DatabaseState = {
  invoices: [], invoice_items: [], customers: [], employees: [], payslips: [],
  quotations: [], quotation_days: [], quotation_items: [],
};
// Per-outlet design defaults — used until a profile's own `template` is saved in Settings.
const DEFAULT_TEMPLATE: TemplateCustomization = {
  primary_color: '#0D9488',
  secondary_color: '#F0FDF4',
  text_dark: '#1E293B',
  font_family: 'Inter',
  title_size: 'text-2xl',
  body_size: 'text-xs',
  padding: 'p-8',
  layout_order: 'logo-left',
  hide_payment_details: false,
  terms_footer: '',
};
const DEFAULT_PROFILES: CompanyProfile[] = [
  {
    id: 'Bistro', name: 'La Bistro Cafe', store_name: 'La Bistro Cafe',
    address: '100-B, Macalister Road, Georgetown',
    email: 'accounts@culinaryholding.com', phone: '+60 4-234 5678',
    currency_symbol: 'RM', series_format: 'BIS-26-',
    footer_text: 'Thank you for dining with us! Payment is due within 3 days.',
  },
  {
    id: 'Nasi Kandar', name: 'Nasi Kandar Heritage', store_name: 'Nasi Kandar Heritage',
    address: '45-C, Chulia Street, Georgetown',
    email: 'accounts@culinaryholding.com', phone: '+60 4-876 5432',
    currency_symbol: 'RM', series_format: 'NK-26-',
    footer_text: 'Please settle invoice balance to secure your delivery order.',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function gasConfigToProfiles(gasConfig: any): CompanyProfile[] {
  // Accept already-mapped profiles array immediately
  if (Array.isArray(gasConfig)) { return gasConfig; }

  if (!gasConfig) return DEFAULT_PROFILES;

  // Support two key formats:
  //  • Our saved format  →  keys: 'Bistro' / 'Nasi Kandar'
  //  • GAS default format → keys: 'bistro' / 'nk'  (properties: name, prefix, contact)
  const bistroRaw = gasConfig['Bistro'] || gasConfig['bistro'];
  const nkRaw     = gasConfig['Nasi Kandar'] || gasConfig['nk'];

  const build = (
    id: 'Bistro' | 'Nasi Kandar',
    raw: any,
    defaultName: string,
    defaultPrefix: string,
  ): CompanyProfile => ({
    id,
    name:            raw.store_name  || raw.name    || defaultName,
    store_name:      raw.store_name  || raw.name    || defaultName,
    company_name:    raw.company_name || '',
    address:         raw.address     || '',
    email:           raw.email       || '',
    phone:           raw.phone       || raw.contact || '',
    currency_symbol: raw.currency_symbol || 'RM',
    logo_url:        raw.logo_url    || '',
    footer_text:     raw.footer_text || '',
    payment_info:    raw.payment_info || '',
    series_format:   raw.series_format || raw.prefix || defaultPrefix,
    template:        raw.template || DEFAULT_TEMPLATE,
  });

  const result: CompanyProfile[] = [];
  if (bistroRaw) result.push(build('Bistro',       bistroRaw, 'A1 Bistro',         'A1-26-'));
  if (nkRaw)     result.push(build('Nasi Kandar',   nkRaw,    "Kiya's Restaurant",  'KIYAS-26-'));
  return result.length > 0 ? result : DEFAULT_PROFILES;
}

// ─── Toast Container ──────────────────────────────────────────────────────────
function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  if (toasts.length === 0) return null;
  const colorMap: Record<Toast['type'], string> = {
    success: 'bg-emerald-600',
    error: 'bg-red-600',
    warning: 'bg-amber-500',
    info: 'bg-indigo-600',
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

// ─── Auth Screen ──────────────────────────────────────────────────────────────
function AuthScreen({
  onSignIn, isLoading, error,
}: { onSignIn: () => void; isLoading: boolean; error: string | null }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-indigo-600 rounded-xl mb-4 shadow-sm">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-gray-900 dark:text-white">BizEazy Hub</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Restaurant Operations Center</p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
          <p className="text-xs text-gray-500 dark:text-slate-400 text-center mb-5 leading-relaxed">
            Sign in with your Google account to access invoicing and payroll data connected to Google Sheets.
          </p>
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-700 dark:text-red-400 mb-4">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <button
            onClick={onSignIn}
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold text-sm py-2.5 px-4 rounded-xl transition-colors cursor-pointer shadow-sm"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
            )}
            {isLoading ? 'Signing in…' : 'Continue with Google'}
          </button>
        </div>
        <p className="text-center text-[10px] text-gray-400 dark:text-slate-600 mt-4">
          Invoicing · Payroll · Google Sheets · Malaysian Statutory 2026
        </p>
      </div>
    </div>
  );
}

// ─── Setup Screen ─────────────────────────────────────────────────────────────
function SetupScreen({ onSave }: { onSave: (spreadsheetId: string, apiUrl: string) => void }) {
  const [sheetId, setSheetId] = useState(localStorage.getItem('bizeazy_spreadsheet_id') || '');
  const [apiUrlLocal, setApiUrlLocal] = useState(localStorage.getItem('gas_api_url') || '');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sheetId.trim()) { setError('Spreadsheet ID is required.'); return; }
    onSave(sheetId.trim(), apiUrlLocal.trim());
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-indigo-600 rounded-xl mb-4 shadow-sm">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-black tracking-tight text-gray-900 dark:text-white">Connect Google Sheets</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">Link your data source to get started</p>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
                Google Spreadsheet ID *
              </label>
              <input
                type="text"
                value={sheetId}
                onChange={e => { setSheetId(e.target.value); setError(''); }}
                placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                className="w-full px-3 py-2.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 text-gray-900 dark:text-white font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">
                Found in your Sheets URL: /spreadsheets/d/<strong>ID</strong>/edit
              </p>
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
                Apps Script API URL <span className="normal-case font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={apiUrlLocal}
                onChange={e => setApiUrlLocal(e.target.value)}
                placeholder="https://script.google.com/macros/s/…/exec"
                className="w-full px-3 py-2.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 text-gray-900 dark:text-white font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">Leave blank to use the default deployed endpoint.</p>
            </div>
            {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
            <button
              type="submit"
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm py-2.5 rounded-xl transition-colors cursor-pointer shadow-sm"
            >
              Save & Connect
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Company Profiles Modal ───────────────────────────────────────────────────
function CompanyProfilesModal({
  profiles, isDark, onClose, onSave,
}: {
  profiles: CompanyProfile[];
  isDark: boolean;
  onClose: () => void;
  onSave: (updated: CompanyProfile[]) => Promise<void>;
}) {
  const init = (id: 'Bistro' | 'Nasi Kandar') =>
    profiles.find(p => p.id === id) || DEFAULT_PROFILES.find(p => p.id === id)!;

  const [bistro, setBistro] = useState({ ...init('Bistro') });
  const [nk, setNk] = useState({ ...init('Nasi Kandar') });
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'Bistro' | 'Nasi Kandar'>('Bistro');
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const keepPng = file.type === 'image/png';
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxPx = 160;
        const scale = Math.min(maxPx / img.width, maxPx / img.height, 1);
        canvas.width  = Math.round(img.width  * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d')!;
        if (!keepPng) {
          // Non-PNG formats have no transparency — fill white so JPEG has no black background
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        // PNG keeps the alpha channel intact; canvas default is transparent
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setter('logo_url', keepPng
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/jpeg', 0.85)
        );
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const update = (
    setter: React.Dispatch<React.SetStateAction<CompanyProfile>>,
    field: keyof CompanyProfile,
    val: string,
  ) => setter(prev => ({ ...prev, [field]: val }));

  const updateTemplate = (
    setter: React.Dispatch<React.SetStateAction<CompanyProfile>>,
    field: keyof TemplateCustomization,
    val: string | boolean,
  ) => setter(prev => ({ ...prev, template: { ...(prev.template || DEFAULT_TEMPLATE), [field]: val } }));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave([bistro, nk]);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = `w-full px-3 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
    isDark
      ? 'bg-slate-950 border-slate-700 text-slate-100'
      : 'bg-gray-50 border-gray-200 text-gray-900'
  }`;

  const current = activeTab === 'Bistro' ? bistro : nk;
  const setter = activeTab === 'Bistro'
    ? (f: keyof CompanyProfile, v: string) => update(setBistro, f, v)
    : (f: keyof CompanyProfile, v: string) => update(setNk, f, v);
  const setTemplate = activeTab === 'Bistro'
    ? (f: keyof TemplateCustomization, v: string | boolean) => updateTemplate(setBistro, f, v)
    : (f: keyof TemplateCustomization, v: string | boolean) => updateTemplate(setNk, f, v);
  const tmpl = current.template || DEFAULT_TEMPLATE;

  const fields: { key: keyof CompanyProfile; label: string; placeholder: string; hint?: string }[] = [
    { key: 'name', label: 'Display / Public Name', placeholder: 'La Bistro Cafe' },
    { key: 'company_name', label: 'Corporate Entity Name', placeholder: 'Culinary Holdings Sdn Bhd' },
    { key: 'address', label: 'Physical Address', placeholder: '100-B, Macalister Road, Georgetown' },
    { key: 'email', label: 'Email', placeholder: 'accounts@example.com' },
    { key: 'phone', label: 'Phone', placeholder: '+60 4-234 5678' },
    { key: 'currency_symbol', label: 'Currency Symbol', placeholder: 'RM' },
    { key: 'series_format', label: 'Invoice Prefix / Series', placeholder: 'BIS-26-', hint: 'e.g. BIS-26- → BIS-26-0001' },
    { key: 'payment_info', label: 'Remittance / Bank Details', placeholder: 'Public Bank : 3814096800', hint: 'Shown under "Remittance Instructions" in the invoice PDF' },
    { key: 'footer_text', label: 'Invoice Footer / Terms', placeholder: 'Thank you for dining with us!' },
  ];

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`w-full max-w-lg rounded-2xl shadow-2xl flex flex-col max-h-[90vh] ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-gray-200'}`}>

        {/* Header */}
        <div className={`flex items-center justify-between px-5 py-4 border-b flex-shrink-0 ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-bold text-gray-900 dark:text-white">Company Profiles</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Outlet tabs */}
        <div className={`flex border-b flex-shrink-0 ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
          {(['Bistro', 'Nasi Kandar'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2.5 text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1.5 ${
                activeTab === tab
                  ? 'border-b-2 border-indigo-500 text-indigo-600 dark:text-indigo-300'
                  : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${tab === 'Bistro' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
              {tab === 'Bistro' ? (bistro.store_name || bistro.name) : (nk.store_name || nk.name)}
            </button>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-5 space-y-3">
          {fields.map(({ key, label, placeholder, hint }) => (
            <div key={key}>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1">
                {label}
              </label>
              <input
                type="text"
                value={(current[key] as string) || ''}
                onChange={e => setter(key, e.target.value)}
                placeholder={placeholder}
                className={inputCls}
              />
              {hint && <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">{hint}</p>}
            </div>
          ))}

          {/* Logo upload */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
              Company Logo
            </label>
            <div className="flex items-center gap-3">
              <div className={`w-14 h-14 rounded-xl border flex items-center justify-center flex-shrink-0 overflow-hidden ${isDark ? 'border-slate-700 bg-slate-950' : 'border-gray-200 bg-gray-50'}`}>
                {current.logo_url ? (
                  <img src={current.logo_url} alt="Logo" className="w-full h-full object-contain p-1" />
                ) : (
                  <Building2 className="w-6 h-6 text-gray-300 dark:text-slate-600" />
                )}
              </div>
              <div className="flex flex-col gap-1.5 flex-1">
                <input
                  type="file"
                  ref={logoInputRef}
                  accept="image/*"
                  className="hidden"
                  onChange={handleLogoUpload}
                />
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}
                >
                  <Upload className="w-3 h-3" />
                  {current.logo_url ? 'Change Logo' : 'Upload Logo'}
                </button>
                {current.logo_url && (
                  <button
                    type="button"
                    onClick={() => setter('logo_url', '')}
                    className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer text-red-500 border-red-200 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  >
                    <X className="w-3 h-3" />
                    Remove
                  </button>
                )}
              </div>
            </div>
            <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">Auto-resized on upload. Saves with your profile to Google Sheets.</p>
          </div>

          {/* Design — applies to both Invoice and Quotation previews for this outlet */}
          <div className={`pt-3 border-t space-y-3 ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
              Document Design — {current.store_name || current.name}
            </p>

            {/* Accent color */}
            <div className="space-y-1.5">
              <label className="block text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Brand Primary Accent</label>
              <div className="flex flex-wrap gap-2 items-center">
                {[
                  { name: 'Teal', value: '#0D9488' },
                  { name: 'Warm Amber', value: '#B45309' },
                  { name: 'Emerald', value: '#065F46' },
                  { name: 'Classic Slate', value: '#334155' },
                  { name: 'Cobalt Blue', value: '#1D4ED8' },
                  { name: 'Crimson Rose', value: '#BE123C' },
                  { name: 'Royal Indigo', value: '#4338CA' },
                  { name: 'Charcoal', value: '#1E293B' },
                ].map(c => (
                  <button key={c.value} type="button" onClick={() => setTemplate('primary_color', c.value)}
                    className={`w-6 h-6 rounded-full border cursor-pointer hover:scale-110 active:scale-95 transition-transform ${tmpl.primary_color === c.value ? 'ring-2 ring-offset-2 ring-indigo-500' : 'border-gray-300 dark:border-slate-600'}`}
                    style={{ backgroundColor: c.value }} title={c.name} />
                ))}
                <input type="text" value={tmpl.primary_color}
                  onChange={e => setTemplate('primary_color', e.target.value)}
                  className={`w-24 px-2 py-1 text-xs font-mono font-bold rounded border ${isDark ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'}`} />
              </div>
            </div>

            {/* Font */}
            <div>
              <label className="block text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">Typography Font Face</label>
              <select value={tmpl.font_family} onChange={e => setTemplate('font_family', e.target.value)} className={inputCls}>
                <option value="Inter">Inter (Clean Swiss Sans)</option>
                <option value="Space Grotesk">Space Grotesk (Tech Modernist)</option>
                <option value="Outfit">Outfit (Friendly Circular)</option>
                <option value="Playfair Display">Playfair Display (Serif Elegance)</option>
                <option value="JetBrains Mono">JetBrains Mono (Precision Mono)</option>
              </select>
            </div>

            {/* Logo / brand alignment */}
            <div>
              <label className="block text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">Logo & Brand Alignment</label>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { label: 'Standard Left', value: 'logo-left' },
                  { label: 'Push Right', value: 'logo-right' },
                  { label: 'Center Stacked', value: 'stacked' },
                  { label: 'Modern Split', value: 'logo-split' },
                ].map(opt => (
                  <button key={opt.value} type="button" onClick={() => setTemplate('layout_order', opt.value)}
                    className={`p-2 border rounded-lg font-bold text-[10px] tracking-tight transition-all cursor-pointer ${
                      tmpl.layout_order === opt.value
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : isDark ? 'bg-slate-950 border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-100'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Title + Body size */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">Title Size</label>
                <select value={tmpl.title_size} onChange={e => setTemplate('title_size', e.target.value)} className={inputCls}>
                  <option value="text-lg">Compact (LG)</option>
                  <option value="text-xl">Standard (XL)</option>
                  <option value="text-2xl">Large (2XL)</option>
                  <option value="text-3xl">Display (3XL)</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">Body Size</label>
                <select value={tmpl.body_size} onChange={e => setTemplate('body_size', e.target.value)} className={inputCls}>
                  <option value="text-[10px]">Tiny (10px)</option>
                  <option value="text-xs">Standard (12px)</option>
                  <option value="text-sm">Comfort (14px)</option>
                </select>
              </div>
            </div>

            {/* Margins */}
            <div>
              <label className="block text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">Sheet Outer Margins</label>
              <div className="grid grid-cols-3 gap-1.5">
                {[{ label: 'Compact', value: 'p-4' }, { label: 'Cozy', value: 'p-8' }, { label: 'Generous', value: 'p-12' }].map(opt => (
                  <button key={opt.value} type="button" onClick={() => setTemplate('padding', opt.value)}
                    className={`py-1.5 border rounded-lg text-[10px] font-bold cursor-pointer transition-all ${
                      tmpl.padding === opt.value
                        ? 'bg-indigo-600 border-indigo-600 text-white'
                        : isDark ? 'bg-slate-950 border-slate-700 text-slate-400 hover:bg-slate-800' : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-100'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Footer terms (Invoice only — Quotation keeps its own Catering Terms field) */}
            <div>
              <label className="block text-[10px] font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">Invoice Footer / Custom Terms</label>
              <textarea rows={2} value={tmpl.terms_footer}
                onChange={e => setTemplate('terms_footer', e.target.value)}
                placeholder="Thank you for your business!"
                className={`${inputCls} resize-none`} />
            </div>
          </div>

          <div className={`flex items-center justify-end gap-2 pt-3 border-t ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
            <button
              type="button"
              onClick={onClose}
              className={`px-4 py-2 text-xs font-bold rounded-xl border cursor-pointer transition-colors ${
                isDark ? 'bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-bold text-xs rounded-xl transition-colors cursor-pointer shadow-sm"
            >
              {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : null}
              {saving ? 'Saving…' : 'Save to Google Sheets'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Settings Modal ───────────────────────────────────────────────────────────
function SettingsModal({
  currentSheetId, isDark, onClose, onSave,
}: {
  currentSheetId: string;
  isDark: boolean;
  onClose: () => void;
  onSave: (sheetId: string, apiUrl: string) => void;
}) {
  const [sheetId, setSheetId] = useState(currentSheetId);
  const [apiUrl, setApiUrlLocal] = useState(() => getApiUrl());
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!sheetId.trim()) { setError('Spreadsheet ID cannot be empty.'); return; }
    onSave(sheetId.trim(), apiUrl.trim());
  };

  const inputClass = `w-full px-3 py-2.5 text-xs rounded-lg border font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
    isDark
      ? 'bg-slate-950 border-slate-700 text-slate-100 placeholder-slate-600'
      : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
  }`;

  return (
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`w-full max-w-md rounded-2xl shadow-2xl ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-gray-200'}`}>
        <div className={`flex items-center justify-between px-5 py-4 border-b ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-bold text-gray-900 dark:text-white">Connection Settings</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
              Google Spreadsheet ID *
            </label>
            <input
              type="text"
              value={sheetId}
              onChange={e => { setSheetId(e.target.value); setError(''); }}
              placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
              className={inputClass}
            />
            <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">
              From your Sheets URL: /spreadsheets/d/<strong>ID</strong>/edit
            </p>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
              Apps Script API URL
            </label>
            <input
              type="text"
              value={apiUrl}
              onChange={e => setApiUrlLocal(e.target.value)}
              placeholder="https://script.google.com/macros/s/…/exec"
              className={inputClass}
            />
            <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">
              Leave blank to restore the default endpoint.
            </p>
          </div>

          {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}

          <div className={`flex items-center justify-end gap-2 pt-2 border-t ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
            <button
              type="button"
              onClick={onClose}
              className={`px-4 py-2 text-xs font-bold rounded-xl border cursor-pointer transition-colors ${
                isDark ? 'bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
              }`}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl transition-colors cursor-pointer shadow-sm"
            >
              Save & Reload Data
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const NAV_ITEMS: { view: AppView; Icon: React.FC<React.SVGProps<SVGSVGElement>>; label: string }[] = [
  { view: 'hub', Icon: LayoutDashboard, label: 'Hub Overview' },
  { view: 'invoicing', Icon: FileText, label: 'Invoicing' },
  { view: 'quotations', Icon: CalendarRange, label: 'Quotations' },
  { view: 'payroll', Icon: Users, label: 'Payroll' },
];

function Sidebar({
  activeView, setActiveView, profiles, activeBranchLocation, setActiveBranchLocation,
  isDark, setIsDark, isDataLoading, onRefresh, onSignOut, onOpenSettings, onOpenProfiles, user,
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
  user: User | null;
  isMobileOpen: boolean;
  onMobileClose: () => void;
}) {
  return (
    <aside className={`
      fixed inset-y-0 left-0 z-50 w-56
      transform transition-transform duration-300 ease-in-out
      ${isMobileOpen ? 'translate-x-0' : '-translate-x-full'}
      md:relative md:translate-x-0 md:flex-shrink-0
      bg-white dark:bg-slate-950 border-r border-gray-200 dark:border-slate-800 flex flex-col h-screen md:sticky md:top-0
    `}>
      {/* Logo */}
      <div className="px-4 py-4 border-b border-gray-100 dark:border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm">
            <Building2 className="w-3.5 h-3.5 text-white" />
          </div>
          <div>
            <div className="text-sm font-black tracking-tight text-gray-900 dark:text-white">BizEazy</div>
            <div className="text-[9px] text-gray-400 dark:text-slate-500 font-semibold uppercase tracking-wider">Operations Hub</div>
          </div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ view, Icon, label }) => {
          const active = activeView === view;
          return (
            <button
              key={view}
              onClick={() => setActiveView(view)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                active
                  ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/60 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <Icon className="w-3.5 h-3.5 flex-shrink-0" />
              {label}
            </button>
          );
        })}
      </nav>

      {/* Branch selector */}
      <div className="px-2 py-2 border-t border-gray-100 dark:border-slate-800 flex-shrink-0">
        <div className="text-[9px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500 px-2 mb-1.5">Active Branch</div>
        <div className="space-y-0.5">
          {profiles.map(p => {
            const branchName = p.store_name || p.name;
            const isActive = activeBranchLocation.toLowerCase() === branchName.toLowerCase();
            return (
              <button
                key={p.id}
                onClick={() => setActiveBranchLocation(branchName)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-gray-900 dark:bg-white text-white dark:text-gray-900'
                    : 'text-gray-500 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${p.id === 'Bistro' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                <span className="truncate">{branchName}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Utility actions */}
      <div className="px-2 py-2 border-t border-gray-100 dark:border-slate-800 space-y-0.5 flex-shrink-0">
        <button
          onClick={onRefresh}
          disabled={isDataLoading}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/60 transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 flex-shrink-0 ${isDataLoading ? 'animate-spin' : ''}`} />
          {isDataLoading ? 'Syncing…' : 'Refresh Data'}
        </button>
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
        >
          <Settings className="w-3.5 h-3.5 flex-shrink-0" />
          Connection Settings
        </button>
        <button
          onClick={onOpenProfiles}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
        >
          <Building2 className="w-3.5 h-3.5 flex-shrink-0" />
          Company Profiles
        </button>
        <button
          onClick={() => setIsDark(!isDark)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/60 transition-colors cursor-pointer"
        >
          {isDark ? <Sun className="w-3.5 h-3.5 flex-shrink-0" /> : <Moon className="w-3.5 h-3.5 flex-shrink-0" />}
          {isDark ? 'Light Mode' : 'Dark Mode'}
        </button>
        <button
          onClick={onSignOut}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-semibold text-gray-500 dark:text-slate-400 hover:bg-red-50 dark:hover:bg-red-950/20 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
        >
          <LogOut className="w-3.5 h-3.5 flex-shrink-0" />
          Sign Out
        </button>
      </div>

      {/* User chip */}
      <div className="px-3 py-2.5 border-t border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/50 flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-950 flex items-center justify-center text-[10px] font-black text-indigo-700 dark:text-indigo-300 flex-shrink-0 uppercase">
            {user?.displayName?.charAt(0) || user?.email?.charAt(0) || '?'}
          </div>
          <div className="min-w-0">
            <div className="text-[10px] font-semibold text-gray-900 dark:text-white truncate">
              {user?.displayName || user?.email || 'User'}
            </div>
            <div className="text-[9px] text-gray-400 dark:text-slate-500">Admin</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState('');
  const [spreadsheetId, setSpreadsheetId] = useState(() => localStorage.getItem('bizeazy_spreadsheet_id') || '');
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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfilesOpen, setIsProfilesOpen] = useState(false);
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

  const loadData = useCallback(async (token: string, sheetId: string) => {
    if (!sheetId) return;
    setIsDataLoading(true);
    try {
      let resolvedProfiles = DEFAULT_PROFILES;
      try {
        const config = await fetchAppConfigFromAppsScript();
        resolvedProfiles = gasConfigToProfiles(config);
        setProfiles(resolvedProfiles);
      } catch {
        // Silently fall back to defaults if GAS config unavailable
      }
      const data = await fetchDataAll(sheetId, token, resolvedProfiles);
      setDb(data);
      setActiveBranchLocation(prev =>
        prev || resolvedProfiles[0]?.store_name || resolvedProfiles[0]?.name || 'La Bistro Cafe'
      );
      triggerToast('Data loaded from Google Sheets.', 'success');
    } catch (err: any) {
      triggerToast(`Data load failed: ${err.message}`, 'error');
    } finally {
      setIsDataLoading(false);
    }
  }, [triggerToast]);

  useEffect(() => {
    const unsub = initAuth(
      (authUser, token) => {
        setUser(authUser);
        setAccessToken(token);
        const sheetId = localStorage.getItem('bizeazy_spreadsheet_id') || '';
        if (!sheetId) {
          setAuthStatus('needs-setup');
        } else {
          setSpreadsheetId(sheetId);
          setAuthStatus('authenticated');
          loadData(token, sheetId);
        }
      },
      () => {
        setUser(null);
        setAccessToken('');
        setAuthStatus('unauthenticated');
      },
    );
    return unsub;
  }, [loadData]);

  const handleSignIn = async () => {
    setIsSigningIn(true);
    setSignInError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setAccessToken(result.accessToken);
        const sheetId = localStorage.getItem('bizeazy_spreadsheet_id') || '';
        if (!sheetId) {
          setAuthStatus('needs-setup');
        } else {
          setSpreadsheetId(sheetId);
          setAuthStatus('authenticated');
          loadData(result.accessToken, sheetId);
        }
      }
    } catch (err: any) {
      setSignInError(err.message || 'Sign in failed. Please try again.');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSetupSave = (newSheetId: string, newApiUrl: string) => {
    localStorage.setItem('bizeazy_spreadsheet_id', newSheetId);
    if (newApiUrl) setApiUrl(newApiUrl);
    setSpreadsheetId(newSheetId);
    setAuthStatus('authenticated');
    loadData(accessToken, newSheetId);
  };

  const handleSignOut = async () => {
    await firebaseLogout();
    setUser(null);
    setAccessToken('');
    setDb(EMPTY_DB);
    setAuthStatus('unauthenticated');
  };

  const handleSync = useCallback(async (
    sheetId: string, token: string,
    nextDb: DatabaseState, profs: CompanyProfile[], branch: string,
  ) => {
    await syncStateToSheets(sheetId, token, nextDb, profs, branch);
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
      await saveAppConfigToAppsScript(gasConfig);
      setProfiles(updated);
      setIsProfilesOpen(false);
      triggerToast('Company profiles saved to Google Sheets!', 'success');
    } catch (err: any) {
      triggerToast(`Profile save failed: ${err.message}`, 'error');
    }
  };

  const handleSettingsSave = (newSheetId: string, newApiUrl: string) => {
    localStorage.setItem('bizeazy_spreadsheet_id', newSheetId);
    setApiUrl(newApiUrl); // setApiUrl handles empty → restore default
    setSpreadsheetId(newSheetId);
    setIsSettingsOpen(false);
    loadData(accessToken, newSheetId);
    triggerToast('Settings saved. Reloading data…', 'info');
  };

  const viewTitle: Record<AppView, string> = {
    hub: 'Hub Overview', invoicing: 'Invoicing Module', payroll: 'Payroll Module',
    quotations: 'Quotations Module',
  };

  const wrapClass = isDark ? 'dark' : '';

  if (authStatus === 'loading') {
    return (
      <div className={wrapClass}>
        <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-slate-950">
          <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
        </div>
      </div>
    );
  }

  if (authStatus === 'unauthenticated') {
    return (
      <div className={wrapClass}>
        <AuthScreen onSignIn={handleSignIn} isLoading={isSigningIn} error={signInError} />
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </div>
    );
  }

  if (authStatus === 'needs-setup') {
    return (
      <div className={wrapClass}>
        <SetupScreen onSave={handleSetupSave} />
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </div>
    );
  }

  // ─── Hub Overview (standalone layout with own sidebar) ──────────────────────
  if (activeView === 'hub') {
    const bistroProfile = profiles.find(p => p.id === 'Bistro');
    const nkProfile     = profiles.find(p => p.id === 'Nasi Kandar');
    const bistroName    = bistroProfile?.store_name || bistroProfile?.name || 'La Bistro Cafe';
    const nkName        = nkProfile?.store_name    || nkProfile?.name    || 'Nasi Kandar Heritage';
    const activeOutlet: 'Bistro' | 'Nasi Kandar' =
      (activeBranchLocation.toLowerCase().includes('kandar') ||
       activeBranchLocation.toLowerCase().includes('kiya'))
        ? 'Nasi Kandar' : 'Bistro';
    const dm = isDark;

    const activeInvoicesHub  = db.invoices.filter(inv => inv.Company === activeOutlet);
    const totalInvoicedHub   = activeInvoicesHub.reduce((s, i) => s + (Number(i.Total_Amount) || 0), 0);
    const collectedHub       = activeInvoicesHub.filter(i => i.Status === 'Paid').reduce((s, i) => s + (Number(i.Total_Amount) || 0), 0);
    const pendingHub         = activeInvoicesHub.filter(i => i.Status === 'Pending').reduce((s, i) => s + (Number(i.Total_Amount) || 0), 0);
    const paidCountHub       = activeInvoicesHub.filter(i => i.Status === 'Paid').length;
    const unpaidCountHub     = activeInvoicesHub.filter(i => i.Status === 'Pending').length;
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
      <div className={`min-h-screen flex transition-colors duration-300 ${dm ? 'bg-[#0b0f1a] text-slate-100' : 'bg-[#f1f5f9] text-slate-900'}`}>

        {/* ── Sidebar ───────────────────────────────────────────────────── */}
        <aside className={`hidden md:flex w-56 shrink-0 flex-col border-r sticky top-0 h-screen transition-colors duration-300 ${dm ? 'bg-[#0f1623] border-slate-800' : 'bg-white border-slate-200'}`}>

          {/* Logo */}
          <div className={`px-5 py-4 border-b ${dm ? 'border-slate-800' : 'border-slate-100'}`}>
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center shadow-[0_2px_8px_rgba(79,70,229,0.4)]">
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              </div>
              <div>
                <p className="text-xs font-black tracking-widest text-indigo-500 uppercase leading-none">BizEazy</p>
                <p className={`text-[9px] font-bold uppercase tracking-wider leading-none mt-0.5 ${dm ? 'text-slate-500' : 'text-slate-400'}`}>Operations Hub</p>
              </div>
            </div>
          </div>

          {/* Nav */}
          <nav className="flex-1 py-4 space-y-0.5 px-3">
            <button className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${dm ? 'bg-slate-800 text-indigo-400' : 'bg-indigo-50 text-indigo-700'}`}>
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              Hub Overview
            </button>
            <button
              onClick={() => { setActiveView('invoicing'); triggerToast('Entering Invoicing Console...', 'success'); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${dm ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
            >
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
              Invoicing
            </button>
            <button
              onClick={() => { setActiveView('quotations'); triggerToast('Entering Quotations Console...', 'success'); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${dm ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
            >
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              Quotations
            </button>
            <button
              onClick={() => { setActiveView('payroll'); triggerToast('Entering Payslip Console...', 'success'); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${dm ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
            >
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              Payroll
            </button>
          </nav>

          {/* Branch selector */}
          <div className={`px-3 py-3 border-t space-y-1 ${dm ? 'border-slate-800' : 'border-slate-100'}`}>
            <p className={`text-[9px] font-bold uppercase tracking-widest px-2 mb-2 ${dm ? 'text-slate-600' : 'text-slate-400'}`}>Active Branch</p>
            {([
              { id: 'Bistro' as const, label: bistroName },
              { id: 'Nasi Kandar' as const, label: nkName },
            ]).map(b => (
              <button
                key={b.id}
                onClick={() => {
                  setActiveBranchLocation(b.id === 'Bistro' ? bistroName : nkName);
                  triggerToast(`Switched to ${b.label}`, 'success');
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-semibold transition-all cursor-pointer text-left ${
                  activeOutlet === b.id
                    ? (dm ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-900 font-bold')
                    : (dm ? 'text-slate-500 hover:bg-slate-800 hover:text-slate-300' : 'text-slate-500 hover:bg-slate-50')
                }`}
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${b.id === 'Bistro' ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                {b.label}
              </button>
            ))}
          </div>

          {/* Bottom actions */}
          <div className={`px-3 py-3 border-t space-y-0.5 ${dm ? 'border-slate-800' : 'border-slate-100'}`}>
            <button
              onClick={() => loadData(accessToken, spreadsheetId)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-semibold cursor-pointer transition-all ${dm ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
              Refresh Data
            </button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-semibold cursor-pointer transition-all ${dm ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><circle cx="12" cy="12" r="3"/></svg>
              Connection Settings
            </button>
            <button
              onClick={() => setIsProfilesOpen(true)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-semibold cursor-pointer transition-all ${dm ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
              Company Profiles
            </button>
            <button
              onClick={() => { setIsDark(p => !p); triggerToast(`Switched to ${!isDark ? 'Dark' : 'Light'} mode`, 'success'); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-semibold cursor-pointer transition-all ${dm ? 'text-slate-400 hover:bg-slate-800 hover:text-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'}`}
            >
              {isDark
                ? <><svg className="w-3.5 h-3.5 shrink-0 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><circle cx="12" cy="12" r="5"/><path strokeLinecap="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>Light Mode</>
                : <><svg className="w-3.5 h-3.5 shrink-0 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>Dark Mode</>
              }
            </button>
            <button
              onClick={() => {
                if (typeof window !== 'undefined') sessionStorage.setItem('explicit_logout', 'true');
                firebaseLogout().then(() => { setUser(null); setAccessToken(''); triggerToast('Signed out.', 'success'); });
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-semibold cursor-pointer transition-all text-rose-500 hover:bg-rose-500/10"
            >
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
              Sign Out
            </button>
          </div>

          {/* User chip */}
          <div className={`px-4 py-3 border-t ${dm ? 'border-slate-800' : 'border-slate-100'}`}>
            <div className="flex items-center gap-2.5">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black ${dm ? 'bg-indigo-500/20 text-indigo-400' : 'bg-indigo-100 text-indigo-700'}`}>
                {(user?.email || 'U')[0].toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className={`text-[11px] font-bold truncate ${dm ? 'text-slate-200' : 'text-slate-800'}`}>{user?.displayName || user?.email?.split('@')[0] || 'User'}</p>
                <p className={`text-[9px] font-semibold ${dm ? 'text-slate-500' : 'text-slate-400'}`}>Admin</p>
              </div>
            </div>
          </div>
        </aside>

        {/* ── Main Content ──────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto">
          {/* Mobile top bar — visible only on small screens */}
          <div className={`md:hidden flex items-center justify-between px-4 py-3 border-b sticky top-0 z-20 ${dm ? 'bg-[#0f1623] border-slate-800' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 bg-indigo-600 rounded-lg flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              </div>
              <span className={`text-xs font-black tracking-widest uppercase ${dm ? 'text-indigo-400' : 'text-indigo-600'}`}>BizEazy</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={() => { setActiveView('invoicing'); triggerToast("Entering Invoicing...","success"); }}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-lg cursor-pointer ${dm ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-700'}`}>
                Invoicing
              </button>
              <button onClick={() => { setActiveView('quotations'); triggerToast("Entering Quotations...","success"); }}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-lg cursor-pointer ${dm ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-700'}`}>
                Quotations
              </button>
              <button onClick={() => { setActiveView('payroll'); triggerToast("Entering Payroll...","success"); }}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-lg cursor-pointer ${dm ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-700'}`}>
                Payroll
              </button>
              <button onClick={() => setIsDark(p => !p)}
                className={`p-1.5 rounded-lg cursor-pointer ${dm ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
                {dm
                  ? <svg className="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><circle cx="12" cy="12" r="5"/><path strokeLinecap="round" d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2"/></svg>
                  : <svg className="w-3.5 h-3.5 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
                }
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className={`p-1.5 rounded-lg cursor-pointer ${dm ? 'bg-slate-800 text-slate-300' : 'bg-slate-100 text-slate-600'}`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                </svg>
              </button>
            </div>
          </div>
          {/* Branch switcher — mobile only */}
          <div className={`md:hidden flex items-center gap-2 px-4 py-2 border-b ${dm ? 'border-slate-800 bg-[#0f1623]' : 'border-slate-100 bg-white'}`}>
            <span className={`text-[9px] font-bold uppercase tracking-wider ${dm ? 'text-slate-500' : 'text-slate-400'}`}>Branch:</span>
            <button
              onClick={() => setActiveBranchLocation(bistroName)}
              className={`px-2.5 py-1 text-[10px] font-bold rounded-full transition-colors cursor-pointer ${
                activeOutlet === 'Bistro'
                  ? 'bg-indigo-600 text-white'
                  : (dm ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')
              }`}
            >{bistroName}</button>
            <button
              onClick={() => setActiveBranchLocation(nkName)}
              className={`px-2.5 py-1 text-[10px] font-bold rounded-full transition-colors cursor-pointer ${
                activeOutlet === 'Nasi Kandar'
                  ? 'bg-indigo-600 text-white'
                  : (dm ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')
              }`}
            >{nkName}</button>
          </div>
          <div className="max-w-6xl mx-auto px-6 py-8 space-y-8">

            <div>
              <h1 className={`text-xl font-black tracking-tight ${dm ? 'text-white' : 'text-slate-900'}`}>Hub Overview</h1>
              <p className={`text-xs font-medium mt-0.5 ${dm ? 'text-slate-500' : 'text-slate-400'}`}>
                {profiles.find(p => p.id === activeOutlet)?.name || activeOutlet}
              </p>
            </div>

            {/* 4 stat cards */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              {[
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>, color: 'text-indigo-400', bg: dm ? 'bg-indigo-500/10' : 'bg-indigo-50', label: 'Total Invoiced', value: fmtAmt(totalInvoicedHub), sub: `${activeInvoicesHub.length} invoice${activeInvoicesHub.length !== 1 ? 's' : ''}` },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>, color: 'text-emerald-400', bg: dm ? 'bg-emerald-500/10' : 'bg-emerald-50', label: 'Collected Revenue', value: fmtAmt(collectedHub), sub: `${paidCountHub} paid` },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>, color: 'text-amber-400', bg: dm ? 'bg-amber-500/10' : 'bg-amber-50', label: 'Pending Outstanding', value: fmtAmt(pendingHub), sub: `${unpaidCountHub} unpaid` },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>, color: 'text-purple-400', bg: dm ? 'bg-purple-500/10' : 'bg-purple-50', label: 'Active Employees', value: String(activeEmployeesHub.length), sub: `${savedPayslipsHub.length} saved payslips` },
              ].map((card, i) => (
                <div key={i} className={`rounded-2xl p-5 border transition-colors ${dm ? 'bg-[#0f1623] border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${card.bg} ${card.color}`}>{card.icon}</div>
                  <p className={`text-xl sm:text-2xl font-black tracking-tight leading-none ${dm ? 'text-white' : 'text-slate-900'}`}>{card.value}</p>
                  <p className={`text-[10px] font-bold uppercase tracking-wider mt-1 ${dm ? 'text-slate-500' : 'text-slate-400'}`}>{card.label}</p>
                  <p className={`text-[10px] font-semibold mt-0.5 ${dm ? 'text-slate-600' : 'text-slate-400'}`}>{card.sub}</p>
                </div>
              ))}
            </div>

            {/* Module shortcuts */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>, label: 'Invoicing Module', desc: 'Create, manage & track invoices', cta: 'Open →', accent: 'indigo', onClick: () => { setActiveView('invoicing'); triggerToast('Entering Invoicing Console...', 'success'); }, stat1Label: 'Total Invoices', stat1Val: String(activeInvoicesHub.length), stat2Label: 'Pending', stat2Val: String(unpaidCountHub), stat2Warn: unpaidCountHub > 0 },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>, label: 'Quotations Module', desc: 'Multi-day catering quotes & estimates', cta: 'Open →', accent: 'indigo', onClick: () => { setActiveView('quotations'); triggerToast('Entering Quotations Console...', 'success'); }, stat1Label: 'Quotations', stat1Val: String(activeQuotationsHub.length), stat2Label: 'Expired', stat2Val: String(expiredQuotationsHub), stat2Warn: expiredQuotationsHub > 0 },
                { icon: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>, label: 'Payroll Module', desc: 'Employee roster & payslip generator', cta: 'Open →', accent: 'indigo', onClick: () => { setActiveView('payroll'); triggerToast('Entering Payslip Console...', 'success'); }, stat1Label: 'Employees', stat1Val: String(activeEmployeesHub.length), stat2Label: 'Saved Payslips', stat2Val: String(savedPayslipsHub.length), stat2Warn: false },
              ].map((mod, i) => (
                <div key={i} className={`rounded-2xl border p-5 transition-all ${dm ? 'bg-[#0f1623] border-slate-800 hover:border-slate-700' : 'bg-white border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md'}`}>
                  <div className="flex items-start justify-between mb-4">
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${mod.accent === 'emerald' ? (dm ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-50 text-emerald-600') : (dm ? 'bg-indigo-500/15 text-indigo-400' : 'bg-indigo-50 text-indigo-600')}`}>{mod.icon}</div>
                    <button onClick={mod.onClick} className={`text-[11px] font-bold cursor-pointer transition-colors ${mod.accent === 'emerald' ? (dm ? 'text-emerald-400 hover:text-emerald-300' : 'text-emerald-600 hover:text-emerald-800') : (dm ? 'text-indigo-400 hover:text-indigo-300' : 'text-indigo-600 hover:text-indigo-800')}`}>{mod.cta}</button>
                  </div>
                  <p className={`text-sm font-black tracking-tight ${dm ? 'text-white' : 'text-slate-900'}`}>{mod.label}</p>
                  <p className={`text-[11px] font-medium mt-0.5 mb-4 ${dm ? 'text-slate-500' : 'text-slate-400'}`}>{mod.desc}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[{ label: mod.stat1Label, val: mod.stat1Val, warn: false }, { label: mod.stat2Label, val: mod.stat2Val, warn: mod.stat2Warn }].map((s, j) => (
                      <div key={j} className={`rounded-xl px-3 py-2.5 ${dm ? 'bg-slate-900' : 'bg-slate-50'}`}>
                        <p className={`text-lg font-black leading-none ${s.warn ? 'text-amber-400' : (dm ? 'text-white' : 'text-slate-900')}`}>{s.val}</p>
                        <p className={`text-[9px] font-bold uppercase tracking-wider mt-0.5 ${dm ? 'text-slate-600' : 'text-slate-400'}`}>{s.label}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Recent activity */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

              {/* Recent Invoices — 2/3 */}
              <div className={`lg:col-span-2 rounded-2xl border transition-colors ${dm ? 'bg-[#0f1623] border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                <div className={`flex items-center justify-between px-5 py-4 border-b ${dm ? 'border-slate-800' : 'border-slate-100'}`}>
                  <div>
                    <p className={`text-sm font-black tracking-tight ${dm ? 'text-white' : 'text-slate-900'}`}>Recent Invoices</p>
                    <p className={`text-[10px] font-medium ${dm ? 'text-slate-600' : 'text-slate-400'}`}>{activeOutlet === 'Bistro' ? bistroName : nkName}</p>
                  </div>
                  <button onClick={() => { setActiveView('invoicing'); triggerToast('Opening Invoicing...', 'success'); }} className={`text-[11px] font-bold cursor-pointer transition-colors ${dm ? 'text-indigo-400 hover:text-indigo-300' : 'text-indigo-600 hover:text-indigo-800'}`}>View All →</button>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {recentInvoicesHub.length === 0 ? (
                    <div className="py-10 text-center"><p className={`text-xs ${dm ? 'text-slate-600' : 'text-slate-400'}`}>No invoices yet</p></div>
                  ) : recentInvoicesHub.map(inv => (
                    <div key={inv.Invoice_ID} className={`flex items-center justify-between px-5 py-3.5 transition-colors ${dm ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50/80'}`}>
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${dm ? 'bg-slate-800' : 'bg-slate-100'}`}>
                          <svg className={`w-4 h-4 ${dm ? 'text-slate-500' : 'text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
                        </div>
                        <div className="min-w-0">
                          <button
                            onClick={() => {
                              setPreviewInvoiceId(inv.Invoice_ID);
                              setIsPreviewOpen(true);
                              setActiveView('invoicing');
                            }}
                            className={`text-xs font-black font-mono tracking-tight truncate block cursor-pointer transition-colors ${dm ? 'text-indigo-400 hover:text-indigo-300' : 'text-indigo-700 hover:text-indigo-900'}`}
                          >
                            {inv.Invoice_ID}
                          </button>
                          <p className={`text-[10px] truncate ${dm ? 'text-slate-500' : 'text-slate-400'}`}>{inv.Customer_Name} · {inv.Date?.split('T')[0] || '-'}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className={`text-xs font-black font-mono ${dm ? 'text-slate-200' : 'text-slate-800'}`}>{currHub} {(Number(inv.Total_Amount) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</span>
                        <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${inv.Status === 'Paid' ? (dm ? 'bg-emerald-500/15 text-emerald-400' : 'bg-emerald-100 text-emerald-700') : (dm ? 'bg-amber-500/15 text-amber-400' : 'bg-amber-100 text-amber-700')}`}>{inv.Status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Saved Payslips — 1/3 */}
              <div className={`rounded-2xl border transition-colors ${dm ? 'bg-[#0f1623] border-slate-800' : 'bg-white border-slate-200 shadow-sm'}`}>
                <div className={`flex items-center justify-between px-5 py-4 border-b ${dm ? 'border-slate-800' : 'border-slate-100'}`}>
                  <p className={`text-sm font-black tracking-tight ${dm ? 'text-white' : 'text-slate-900'}`}>Saved Payslips</p>
                  <button onClick={() => { setActiveView('payroll'); triggerToast('Opening Payroll...', 'success'); }} className={`text-[11px] font-bold cursor-pointer transition-colors ${dm ? 'text-indigo-400 hover:text-indigo-300' : 'text-indigo-600 hover:text-indigo-800'}`}>View All →</button>
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800/60">
                  {recentPayslipsHub.length === 0 ? (
                    <div className="py-10 text-center"><p className={`text-xs ${dm ? 'text-slate-600' : 'text-slate-400'}`}>No saved payslips yet</p></div>
                  ) : recentPayslipsHub.map(ps => {
                    const emp = db.employees?.find(e => e.Employee_ID === ps.Employee_ID);
                    return (
                      <div key={ps.Payslip_ID} className={`px-5 py-3.5 transition-colors ${dm ? 'hover:bg-slate-800/50' : 'hover:bg-slate-50/80'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className={`text-[11px] font-black truncate ${dm ? 'text-slate-200' : 'text-slate-800'}`}>{emp?.Employee_Name || ps.Employee_ID}</p>
                            <p className={`text-[9px] font-semibold mt-0.5 ${dm ? 'text-slate-600' : 'text-slate-400'}`}>{(() => {
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
                          <p className={`text-[11px] font-black font-mono shrink-0 ${dm ? 'text-indigo-400' : 'text-indigo-600'}`}>{currHub} {(Number(ps.Final_Net_Pay) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</p>
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
          <CompanyProfilesModal profiles={profiles} isDark={isDark} onClose={() => setIsProfilesOpen(false)} onSave={handleProfilesSave} />
        )}
        {isSettingsOpen && (
          <SettingsModal currentSheetId={spreadsheetId} isDark={isDark} onClose={() => setIsSettingsOpen(false)} onSave={handleSettingsSave} />
        )}
        <ToastContainer toasts={toasts} onRemove={removeToast} />
      </div>
    );
  }

  return (
    <div className={wrapClass}>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex">

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
          onRefresh={() => loadData(accessToken, spreadsheetId)}
          onSignOut={handleSignOut}
          onOpenSettings={() => { setIsSettingsOpen(true); setIsMobileNavOpen(false); }}
          onOpenProfiles={() => { setIsProfilesOpen(true); setIsMobileNavOpen(false); }}
          user={user}
          isMobileOpen={isMobileNavOpen}
          onMobileClose={() => setIsMobileNavOpen(false)}
        />

        <div className="flex-1 min-w-0 flex flex-col">
          {/* Top bar */}
          <header className="bg-white dark:bg-slate-950 border-b border-gray-200 dark:border-slate-800 px-4 md:px-6 py-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              {/* Hamburger — mobile only */}
              <button
                onClick={() => setIsMobileNavOpen(true)}
                className="md:hidden p-1.5 -ml-1 rounded-lg text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer flex-shrink-0"
                aria-label="Open navigation"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <h1 className="text-sm font-bold text-gray-900 dark:text-white">{viewTitle[activeView]}</h1>
                <p className="text-[10px] text-gray-400 dark:text-slate-500 flex items-center gap-1.5">
                  <span className="truncate">{activeBranchLocation}</span>
                  {isSyncing && <span className="text-indigo-500 font-semibold flex-shrink-0">· Syncing…</span>}
                </p>
              </div>
            </div>
            {isDataLoading && (
              <span className="flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-slate-400 flex-shrink-0">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </span>
            )}
          </header>

          {/* Module content */}
          <main className="flex-1 overflow-y-auto p-6">
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
                    .catch(() => triggerToast('Sync failed after delete.', 'error'));
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
          </main>
        </div>
      </div>
      {isProfilesOpen && (
        <CompanyProfilesModal
          profiles={profiles}
          isDark={isDark}
          onClose={() => setIsProfilesOpen(false)}
          onSave={handleProfilesSave}
        />
      )}
      {isSettingsOpen && (
        <SettingsModal
          currentSheetId={spreadsheetId}
          isDark={isDark}
          onClose={() => setIsSettingsOpen(false)}
          onSave={handleSettingsSave}
        />
      )}
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
          const parentCompanyName = profile?.company_name || '';
          const storeOutletName = profile?.store_name || '';

          // Portal straight to <body> so printing isn't constrained by any ancestor in
          // the app's own layout (sidebar, page wrappers, etc.) — see print CSS below.
          return createPortal(
            <div id="preview-studio-overlay" className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-2 sm:p-4 overflow-y-auto w-full h-full">
              <style dangerouslySetInnerHTML={{__html: `
                @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&family=Playfair+Display:ital,wght@0,600;1,400&family=Space+Grotesk:wght@500;700&display=swap');
                @media print {
                  @page { size: A4 portrait; margin: 0mm; }
                  body, html { margin: 0 !important; padding: 0 !important; background: white !important; }
                  /* The whole app (mounted at #root) is a sibling of this portaled overlay
                     under <body> — hide it outright so it can't push the print area down
                     or get counted as extra pages. visibility:hidden alone keeps layout
                     boxes in place, which is why this must be display:none. */
                  #root { display: none !important; }
                  body * { visibility: hidden !important; }
                  #invoice-print-area, #invoice-print-area * { visibility: visible !important; }
                  /* visibility:hidden keeps layout boxes in place — the header/footer bars
                     must be fully removed (display:none), not just hidden, or they leave a
                     blank gap above/below the content. */
                  #preview-studio-header, #preview-studio-footer { display: none !important; }
                  /* Ancestors must not constrain height/overflow/padding/centering, or
                     content gets clipped to page 1 or pushed down by leftover flex spacing. */
                  #preview-studio-overlay, #preview-studio-dialog, #preview-stage-container {
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
                  #invoice-print-area {
                    position: static !important;
                    width: 210mm !important;
                    min-height: 297mm !important;
                    height: auto !important;
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

              <div id="preview-studio-dialog" className="bg-gray-100 text-slate-900 w-full max-w-6xl rounded-2xl shadow-2xl flex flex-col overflow-hidden text-left h-[90vh]">

                {/* Header */}
                <div id="preview-studio-header" className="px-6 py-4 bg-slate-900 text-white flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-gray-800 gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                    <h3 className="text-sm font-bold tracking-tight">Invoice Preview</h3>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
                    <button
                      onClick={() => window.print()}
                      className="px-4 py-1.5 cursor-pointer bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 transition-all shadow-md active:scale-95"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                      Print / Save A4
                    </button>
                    <button
                      onClick={() => { setIsPreviewOpen(false); setPreviewInvoiceId(null); }}
                      className="p-1 px-1.5 hover:bg-white/10 rounded-lg transition-all text-gray-400 hover:text-white cursor-pointer"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">

                  {/* RIGHT: Paper canvas — no flex here on purpose; margin:auto on the page
                      itself centers it reliably on every browser without depending on any
                      flexbox cross-axis sizing behavior. */}
                  <div id="preview-stage-container" className="bg-slate-800 p-2 sm:p-8 rounded-2xl overflow-auto w-full">
                    <div
                      id="invoice-print-area"
                      className={`bg-white w-full max-w-[210mm] mx-auto text-gray-800 shadow-2xl relative min-h-[297mm] flex flex-col justify-between transition-all border border-gray-300 ${customStyles.padding || 'p-8'} ${customStyles.body_size || 'text-xs'}`}
                      style={{
                        borderColor: customStyles.primary_color,
                        fontFamily: customStyles.font_family === 'Space Grotesk' ? '"Space Grotesk", sans-serif' :
                                    customStyles.font_family === 'Outfit' ? '"Outfit", sans-serif' :
                                    customStyles.font_family === 'Playfair Display' ? '"Playfair Display", serif' :
                                    customStyles.font_family === 'JetBrains Mono' ? '"JetBrains Mono", monospace' : 'inherit'
                      }}
                    >
                      <div>
                        {/* Top accent bar */}
                        {activeTemp === 'modern' && (
                          <div className="absolute top-0 left-0 right-0 h-4" style={{ backgroundImage: `linear-gradient(to right, ${customStyles.primary_color}, #F59E0B)` }} />
                        )}
                        {activeTemp === 'bold' && (
                          <div className="absolute top-0 left-0 right-0 h-8 flex items-center justify-end px-6 text-[9px] font-bold tracking-widest text-white uppercase" style={{ backgroundColor: customStyles.primary_color }}>
                            Official Customer Invoice Receipt Ledger
                          </div>
                        )}

                        {/* Header: logo + company + address */}
                        <div className={`mt-4 flex gap-4 mb-6 ${
                          customStyles.layout_order === 'logo-right' ? 'flex-row-reverse justify-between items-start' :
                          customStyles.layout_order === 'stacked' ? 'flex-col items-center justify-center text-center' :
                          'flex-row justify-between items-start'
                        }`}>
                          <div className={`flex gap-4 items-center ${customStyles.layout_order === 'stacked' ? 'flex-col' : 'flex-row'}`}>
                            {profile?.logo_url && (profile.logo_url.startsWith('http') || profile.logo_url.startsWith('data:image')) ? (
                              <img src={profile.logo_url} alt="Logo" className="max-h-20 w-auto max-w-[140px] object-contain" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white font-black text-xl uppercase shadow-lg" style={{ backgroundColor: customStyles.primary_color }}>
                                {profile?.logo_url ? profile.logo_url.substring(0, 2) : (invoice.Company === 'Bistro' ? 'LB' : 'NK')}
                              </div>
                            )}
                            <div className={customStyles.layout_order === 'stacked' ? 'text-center' : 'text-left'}>
                              {parentCompanyName && <p className="text-[9px] font-extrabold uppercase text-gray-400 tracking-wider mb-0.5">{parentCompanyName}</p>}
                              <h1 className={`font-black tracking-tight text-gray-900 leading-tight ${customStyles.title_size || 'text-2xl'}`}>
                                {profile?.name || (invoice.Company === 'Bistro' ? 'La Bistro Cafe' : 'Nasi Kandar Heritage')}
                              </h1>
                              {storeOutletName && (
                                <p className="text-[10px] font-bold mt-0.5 uppercase" style={{ color: customStyles.primary_color }}>
                                  Outlet: {storeOutletName}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className={`text-[10px] text-gray-500 leading-relaxed space-y-0.5 shrink-0 ${customStyles.layout_order === 'stacked' ? 'text-center' : customStyles.layout_order === 'logo-right' ? 'text-left' : 'text-right'}`}>
                            <p className="font-semibold text-gray-700">{profile?.address}</p>
                            <p>Contact: {profile?.phone} | {profile?.email}</p>
                          </div>
                        </div>

                        <hr className="border-gray-200 mb-5" />

                        {/* Invoice ID + Status */}
                        <div className="flex items-start justify-between mb-5 gap-4">
                          <div className="flex-1">
                            <span className="text-[9px] font-extrabold text-gray-400 uppercase tracking-widest block mb-1">Invoice Code ID</span>
                            <h3 className="text-2xl font-black text-gray-900 font-mono tracking-tight leading-none mb-3">{invoice.Invoice_ID}</h3>
                            <span className="text-[9px] font-extrabold text-gray-400 uppercase tracking-widest block mb-1">Issued Stamp</span>
                            <p className="text-xs font-semibold text-slate-700">{invoice.Date?.split('T')[0] || invoice.Date}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <span className="text-[9px] font-extrabold text-gray-400 uppercase tracking-widest block mb-2">Status Summary</span>
                            <span className="inline-block px-4 py-1.5 rounded-lg font-extrabold text-[10px] uppercase tracking-widest text-white"
                              style={{ backgroundColor: invoice.Status === 'Paid' ? '#059669' : customStyles.primary_color }}>
                              {invoice.Status === 'Paid' ? 'PAID' : 'PENDING'}
                            </span>
                          </div>
                        </div>

                        <hr className="border-gray-100 mb-5" />

                        {/* Customer block */}
                        <div className="print-keep-together border border-gray-200 rounded-2xl p-4 mb-6 bg-white">
                          <span className="text-[8px] font-extrabold text-gray-400 uppercase tracking-widest block mb-2">Bill To Registered Customer</span>
                          <p className="text-sm font-black text-gray-900 mb-0.5">{invoice.Customer_Name}</p>
                          <p className="text-[10.5px] text-gray-500">Mobile / Email: {invoice.Customer_Contact && invoice.Customer_Contact !== '-' ? invoice.Customer_Contact : '-'}</p>
                          {invoice.Customer_Address && invoice.Customer_Address !== '-' && (
                            <div className="mt-3 pt-3 border-t border-gray-100">
                              <span className="text-[8px] font-extrabold text-gray-400 uppercase tracking-widest block mb-1">Physical Location Address:</span>
                              <p className="text-[10.5px] text-gray-600 font-medium">{invoice.Customer_Address}</p>
                            </div>
                          )}
                        </div>

                        {/* Line items table */}
                        <div className="print-keep-together mb-6 overflow-hidden rounded-xl border border-gray-200">
                          <table className="w-full table-fixed text-[11px] border-collapse text-left">
                            <thead>
                              <tr className="text-white text-[10px] font-bold uppercase tracking-wider"
                                style={{ backgroundColor: customStyles.primary_color }}>
                                <th className="py-2.5 px-3 w-8">#</th>
                                <th className="py-2.5 px-2">Item Description</th>
                                <th className="py-2.5 px-2 text-right w-20">Unit Price</th>
                                <th className="py-2.5 px-2 text-center w-14">Qty</th>
                                <th className="py-2.5 px-3 text-right w-20">Subtotal</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {items.length > 0 ? items.map((item, idx) => (
                                <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                                  <td className="py-2.5 px-3 text-gray-400 font-mono">{idx + 1}</td>
                                  <td className="py-2.5 px-2 font-semibold text-gray-900 break-words">{item.Item_Name}</td>
                                  <td className="py-2.5 px-2 text-right font-mono text-gray-600">{item.Price === 0 ? <span className="text-emerald-600 font-extrabold">FREE</span> : `${currencySymbol} ${item.Price.toFixed(2)}`}</td>
                                  <td className="py-2.5 px-2 text-center font-mono text-gray-600">{item.Quantity}</td>
                                  <td className="py-2.5 px-3 text-right font-bold text-gray-900 font-mono">{(item.Subtotal ?? 0) === 0 ? <span className="text-emerald-600 font-extrabold">FREE</span> : `${currencySymbol} ${(item.Subtotal ?? item.Quantity * item.Price).toFixed(2)}`}</td>
                                </tr>
                              )) : (
                                <tr>
                                  <td colSpan={5} className="py-6 text-center text-gray-400 italic text-xs">No line items recorded</td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>

                        {/* Totals + remittance */}
                        <div className="print-keep-together flex flex-col sm:flex-row justify-between items-start gap-5 mb-8">
                          <div className="flex-1 space-y-3 max-w-xs">
                            {invoice.Notes && invoice.Notes.trim() && (
                              <div>
                                <span className="text-[8px] font-extrabold text-gray-400 uppercase tracking-widest block mb-1">Remarks / Notes</span>
                                <p className="text-[10.5px] text-gray-600 leading-relaxed">{invoice.Notes}</p>
                              </div>
                            )}
                            <div>
                              <span className="text-[8px] font-extrabold text-gray-400 uppercase tracking-widest block mb-1">Remittance Instructions</span>
                              <p className="text-[11px] text-slate-800 font-bold">{profile?.payment_info || 'Direct cash settlement before collection.'}</p>
                            </div>
                          </div>
                          <div className="w-full sm:w-[230px] border border-gray-200 rounded-xl p-4 bg-white space-y-2.5 shrink-0">
                            <div className="flex justify-between items-center text-[11px]">
                              <span className="text-gray-500">Subtotal Amount:</span>
                              <span className="font-mono font-semibold text-gray-800">{currencySymbol} {(invoice.Subtotal_Amount ?? invoice.Total_Amount).toFixed(2)}</span>
                            </div>
                            {invoice.Discount_Type && invoice.Discount_Type !== 'none' && (
                              <div className="flex justify-between items-center text-[11px]">
                                <span className="text-gray-500">Discount:</span>
                                <span className="font-mono font-bold text-amber-700">
                                  {invoice.Discount_Type === 'percentage' ? `${invoice.Discount_Value}% Off` : `-${currencySymbol} ${(invoice.Discount_Value || 0).toFixed(2)}`}
                                </span>
                              </div>
                            )}
                            <div className="border-t border-gray-200 pt-2.5 flex justify-between items-center">
                              <span className="text-sm font-black text-gray-900">Grand Total:</span>
                              <span className="text-sm font-black font-mono" style={{ color: customStyles.primary_color }}>
                                {currencySymbol} {invoice.Total_Amount.toFixed(2)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Footer */}
                      <div className="border-t border-gray-200 pt-5 mt-auto text-center space-y-1 select-none">
                        <p className="text-[9px] font-bold text-gray-500 italic uppercase tracking-wide leading-relaxed">
                          {customStyles.terms_footer || profile?.footer_text || 'Payment is due within 30 days.'}
                        </p>
                        <p className="text-[8px] font-mono text-gray-300 uppercase tracking-widest">Generated Securely by BizEazyInvoicing</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Footer bar */}
                <div id="preview-studio-footer" className="p-4 flex justify-end bg-slate-900 border-t border-slate-800">
                  <button onClick={() => { setIsPreviewOpen(false); setPreviewInvoiceId(null); }}
                    className="px-5 py-2 cursor-pointer bg-slate-800 hover:bg-slate-700 text-gray-200 font-extrabold text-xs rounded-xl">
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
