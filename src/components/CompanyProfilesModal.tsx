/**
 * CompanyProfilesModal.tsx — branches/brands/stores, and the look of their
 * documents. One tab per outlet, add and remove as the business changes.
 *
 * An outlet's id is its key in the company's Config tab, so adding one is
 * literally adding a key. Removing one drops that key, which is why removal is
 * refused while any invoice, quotation or employee still points at it.
 */
import React, { useRef, useState } from 'react';
import { Building2, X, Upload, RefreshCw, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { Sheet, sheetBtn } from './ui/Sheet';
import { CompanyProfile, TemplateCustomization, DatabaseState } from '../types';
import { outletLabel, outletColor, newOutletId, outletUsage } from '../utils/outlets';

const ACCENT_SWATCHES = [
  { name: 'Teal', value: '#0D9488' },
  { name: 'Warm Amber', value: '#B45309' },
  { name: 'Emerald', value: '#065F46' },
  { name: 'Classic Slate', value: '#334155' },
  { name: 'Cobalt Blue', value: '#1D4ED8' },
  { name: 'Crimson Rose', value: '#BE123C' },
  { name: 'Royal Indigo', value: '#4338CA' },
  { name: 'Charcoal', value: '#1E293B' },
];

const FIELDS: {
  key: keyof CompanyProfile; label: string; placeholder: string; hint?: string; multiline?: boolean;
}[] = [
  { key: 'name', label: 'Branch / Outlet Name', placeholder: 'Georgetown Branch', hint: 'Shown on invoices, quotations and payslips for this branch' },
  { key: 'company_name', label: 'Corporate Entity Name', placeholder: 'Culinary Holdings Sdn Bhd' },
  { key: 'address', label: 'Physical Address', placeholder: '100-B, Macalister Road, Georgetown' },
  { key: 'email', label: 'Email', placeholder: 'accounts@example.com' },
  { key: 'phone', label: 'Phone', placeholder: '+60 4-234 5678' },
  { key: 'currency_symbol', label: 'Currency Symbol', placeholder: 'RM' },
  { key: 'series_format', label: 'Invoice Prefix / Series', placeholder: 'GT-26-', hint: 'e.g. GT-26- → GT-26-0001. Keep it unique per branch — it is how older records stay attached to this branch if you rename it.' },
  { key: 'payment_info', label: 'Remittance / Bank Details', placeholder: 'Public Bank : 3814096800\nAccount Name : Ya Barr Solutions\nSwift: PBBEMYKL', hint: 'One detail per line — shown under "Remittance Instructions"', multiline: true },
  { key: 'footer_text', label: 'Invoice Footer / Terms', placeholder: 'Thank you for dining with us!', multiline: true },
];

export const DEFAULT_TEMPLATE: TemplateCustomization = {
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

export function CompanyProfilesModal({
  profiles, db, isDark, onClose, onSave,
}: {
  profiles: CompanyProfile[];
  db: DatabaseState;
  isDark: boolean;
  onClose: () => void;
  onSave: (updated: CompanyProfile[]) => Promise<void>;
}) {
  const [outlets, setOutlets] = useState<CompanyProfile[]>(() =>
    profiles.length
      ? profiles.map(p => ({ ...p, template: p.template || DEFAULT_TEMPLATE }))
      : [{
          id: newOutletId(), name: 'Main Branch', store_name: 'Main Branch',
          address: '', email: '', phone: '', currency_symbol: 'RM',
          series_format: 'INV-26-', template: DEFAULT_TEMPLATE,
        }],
  );
  const [activeIdx, setActiveIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const logoInputRef = useRef<HTMLInputElement>(null);

  const current = outlets[activeIdx] || outlets[0];

  const update = (field: keyof CompanyProfile, value: string) =>
    setOutlets(prev => prev.map((o, i) => {
      if (i !== activeIdx) return o;
      // name and store_name are the same thing to the user; keep them together
      // so every read path agrees on what this branch is called.
      if (field === 'name' || field === 'store_name') {
        return { ...o, name: value, store_name: value };
      }
      return { ...o, [field]: value };
    }));

  const updateTemplate = (field: keyof TemplateCustomization, value: string | boolean) =>
    setOutlets(prev => prev.map((o, i) => i === activeIdx
      ? { ...o, template: { ...(o.template || DEFAULT_TEMPLATE), [field]: value } }
      : o));

  const addOutlet = () => {
    const n = outlets.length + 1;
    const next: CompanyProfile = {
      id: newOutletId(),
      name: `Branch ${n}`, store_name: `Branch ${n}`,
      company_name: current?.company_name || '',
      address: '', email: '', phone: '',
      currency_symbol: current?.currency_symbol || 'RM',
      // A distinct series per branch, because that prefix is what keeps older
      // records attached to this branch after a rename.
      series_format: `B${n}-${String(new Date().getFullYear()).slice(2)}-`,
      logo_url: '', footer_text: '', payment_info: '',
      template: { ...DEFAULT_TEMPLATE, primary_color: outletColor(undefined, outlets.length) },
    };
    setOutlets(prev => [...prev, next]);
    setActiveIdx(outlets.length);
    setError('');
  };

  const removeOutlet = (idx: number) => {
    const target = outlets[idx];
    if (outlets.length <= 1) {
      setError('A company needs at least one branch.');
      return;
    }
    // Removing the Config key would leave these rows pointing at an outlet that
    // no longer exists, and they would quietly fall back to the first branch.
    const usage = outletUsage(profiles, target.id, db);
    if (usage.total > 0) {
      const parts = [
        usage.invoices ? `${usage.invoices} invoice${usage.invoices === 1 ? '' : 's'}` : '',
        usage.quotations ? `${usage.quotations} quotation${usage.quotations === 1 ? '' : 's'}` : '',
        usage.employees ? `${usage.employees} employee${usage.employees === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(', ');
      setError(`"${outletLabel(target)}" still has ${parts} attached. Move or delete those first — removing the branch now would orphan them.`);
      return;
    }
    if (!window.confirm(`Remove "${outletLabel(target)}"? It has no records attached.`)) return;
    setOutlets(prev => prev.filter((_, i) => i !== idx));
    setActiveIdx(i => (i >= idx && i > 0 ? i - 1 : i));
    setError('');
  };

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
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        update('logo_url', keepPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const named = outlets.map(o => ({ ...o, name: outletLabel(o), store_name: outletLabel(o) }));
    const labels = named.map(o => outletLabel(o).trim().toLowerCase());
    if (labels.some(l => !l)) { setError('Every branch needs a name.'); return; }
    if (new Set(labels).size !== labels.length) {
      setError('Two branches share the same name. Records are stamped with the branch name, so names must differ.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(named);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = `w-full px-3 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-brand-500 ${
    isDark ? 'bg-ink-950 border-ink-700 text-ink-100' : 'bg-ink-50 border-ink-200 text-ink-900'
  }`;
  const tmpl = current.template || DEFAULT_TEMPLATE;

  return (
    <Sheet
      title="Branches & Documents"
      subtitle={`${outlets.length} ${outlets.length === 1 ? 'branch' : 'branches'}`}
      icon={<Building2 className="w-4 h-4" />}
      onClose={onClose}
      maxWidth="lg"
      footer={
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={sheetBtn.ghost}>Cancel</button>
          <button type="submit" form="branches-form" disabled={saving} className={sheetBtn.primary}>
            {saving && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
            {saving ? 'Saving…' : 'Save to Google Sheets'}
          </button>
        </div>
      }
    >
      <div className="-mx-4 sm:-mx-5 -mt-4">
        {/* Outlet tabs + add */}
        <div className={`flex items-stretch border-b overflow-x-auto sticky top-0 z-10 ${isDark ? 'border-ink-800 bg-ink-900' : 'border-ink-200 bg-ink-50'}`}>
          {outlets.map((o, idx) => (
            <button
              key={o.id}
              type="button"
              onClick={() => { setActiveIdx(idx); setError(''); }}
              className={`px-3 py-2.5 text-xs font-bold whitespace-nowrap transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeIdx === idx
                  ? 'border-b-2 border-brand-500 text-brand-600 dark:text-brand-300'
                  : 'text-ink-500 dark:text-ink-400 hover:text-ink-700 dark:hover:text-ink-200'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: outletColor(o, idx) }} />
              {outletLabel(o)}
            </button>
          ))}
          <button
            type="button"
            onClick={addOutlet}
            title="Add a branch"
            className="px-3 py-2.5 text-xs font-bold text-ink-500 dark:text-ink-400 hover:text-brand-600 dark:hover:text-brand-400 cursor-pointer flex items-center gap-1 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        </div>

        <form id="branches-form" onSubmit={handleSave} className="p-4 sm:p-5 space-y-3">
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-700 dark:text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {FIELDS.map(({ key, label, placeholder, hint, multiline }) => (
            <div key={key}>
              <label className="block text-2xs font-bold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-1">
                {label}
              </label>
              {multiline ? (
                <textarea
                  value={(current[key] as string) || ''}
                  onChange={e => update(key, e.target.value)}
                  placeholder={placeholder}
                  rows={3}
                  className={`${inputCls} resize-y`}
                />
              ) : (
                <input
                  type="text"
                  value={(current[key] as string) || ''}
                  onChange={e => update(key, e.target.value)}
                  placeholder={placeholder}
                  className={inputCls}
                />
              )}
              {hint && <p className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5">{hint}</p>}
            </div>
          ))}

          {/* Logo upload */}
          <div>
            <label className="block text-2xs font-bold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-1.5">
              Branch Logo
            </label>
            <div className="flex items-center gap-3">
              <div className={`w-14 h-14 rounded-xl border flex items-center justify-center flex-shrink-0 overflow-hidden ${isDark ? 'border-ink-700 bg-ink-950' : 'border-ink-200 bg-ink-50'}`}>
                {current.logo_url ? (
                  <img src={current.logo_url} alt="Logo" className="w-full h-full object-contain p-1" />
                ) : (
                  <Building2 className="w-6 h-6 text-ink-300 dark:text-ink-400" />
                )}
              </div>
              <div className="flex flex-col gap-1.5 flex-1">
                <input type="file" ref={logoInputRef} accept="image/*" className="hidden" onChange={handleLogoUpload} />
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${isDark ? 'border-ink-700 text-ink-300 hover:bg-ink-800' : 'border-ink-200 text-ink-700 hover:bg-ink-50'}`}
                >
                  <Upload className="w-3 h-3" />
                  {current.logo_url ? 'Change Logo' : 'Upload Logo'}
                </button>
                {current.logo_url && (
                  <button
                    type="button"
                    onClick={() => update('logo_url', '')}
                    className="flex items-center justify-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg border text-xs font-semibold cursor-pointer text-rose-600 dark:text-rose-300 border-rose-200 dark:border-rose-900/40 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
                  >
                    <X className="w-3 h-3" />
                    Remove
                  </button>
                )}
              </div>
            </div>
            <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1">Auto-resized on upload. Saved with this branch.</p>
          </div>

          {/* Design — applies to both Invoice and Quotation previews for this outlet */}
          <div className={`pt-3 border-t space-y-3 ${isDark ? 'border-ink-800' : 'border-ink-100'}`}>
            <p className="text-2xs font-bold uppercase tracking-wider text-ink-500 dark:text-ink-400">
              Document Design — {outletLabel(current)}
            </p>

            <div className="space-y-1.5">
              <label className="block text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-wide">Brand Primary Accent</label>
              <div className="flex flex-wrap gap-2 items-center">
                {ACCENT_SWATCHES.map(c => (
                  <button key={c.value} type="button" onClick={() => updateTemplate('primary_color', c.value)}
                    className={`w-6 h-6 rounded-full border cursor-pointer hover:scale-110 active:scale-95 transition-transform ${tmpl.primary_color === c.value ? 'ring-2 ring-offset-2 ring-brand-500' : 'border-ink-300 dark:border-ink-600'}`}
                    style={{ backgroundColor: c.value }} title={c.name} />
                ))}
                <input type="text" value={tmpl.primary_color}
                  onChange={e => updateTemplate('primary_color', e.target.value)}
                  className={`w-24 px-2 py-1 text-xs font-mono font-bold rounded border ${isDark ? 'bg-ink-950 border-ink-700 text-ink-100' : 'bg-white border-ink-200 text-ink-900'}`} />
              </div>
            </div>

            <div>
              <label className="block text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-wide mb-1">Typography Font Face</label>
              <select value={tmpl.font_family} onChange={e => updateTemplate('font_family', e.target.value)} className={inputCls}>
                <option value="Inter">Inter (Clean Swiss Sans)</option>
                <option value="Space Grotesk">Space Grotesk (Tech Modernist)</option>
                <option value="Outfit">Outfit (Friendly Circular)</option>
                <option value="Playfair Display">Playfair Display (Serif Elegance)</option>
                <option value="JetBrains Mono">JetBrains Mono (Precision Mono)</option>
              </select>
            </div>

            <div>
              <label className="block text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-wide mb-1">Logo &amp; Brand Alignment</label>
              <div className="grid grid-cols-2 gap-1.5">
                {[
                  { label: 'Standard Left', value: 'logo-left' },
                  { label: 'Push Right', value: 'logo-right' },
                  { label: 'Center Stacked', value: 'stacked' },
                  { label: 'Modern Split', value: 'logo-split' },
                ].map(opt => (
                  <button key={opt.value} type="button" onClick={() => updateTemplate('layout_order', opt.value)}
                    className={`p-2 border rounded-lg font-bold text-2xs tracking-tight transition-all cursor-pointer ${
                      tmpl.layout_order === opt.value
                        ? 'bg-brand-600 border-brand-600 text-white'
                        : isDark ? 'bg-ink-950 border-ink-700 text-ink-300 hover:bg-ink-800' : 'bg-white border-ink-200 text-ink-600 hover:bg-ink-100'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-wide mb-1">Title Size</label>
                <select value={tmpl.title_size} onChange={e => updateTemplate('title_size', e.target.value)} className={inputCls}>
                  <option value="text-lg">Compact (LG)</option>
                  <option value="text-xl">Standard (XL)</option>
                  <option value="text-2xl">Large (2XL)</option>
                  <option value="text-3xl">Display (3XL)</option>
                </select>
              </div>
              <div>
                <label className="block text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-wide mb-1">Body Size</label>
                <select value={tmpl.body_size} onChange={e => updateTemplate('body_size', e.target.value)} className={inputCls}>
                  <option value="text-2xs">Tiny (10px)</option>
                  <option value="text-xs">Standard (12px)</option>
                  <option value="text-sm">Comfort (14px)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-wide mb-1">Sheet Outer Margins</label>
              <div className="grid grid-cols-3 gap-1.5">
                {[{ label: 'Compact', value: 'p-4' }, { label: 'Cozy', value: 'p-8' }, { label: 'Generous', value: 'p-12' }].map(opt => (
                  <button key={opt.value} type="button" onClick={() => updateTemplate('padding', opt.value)}
                    className={`py-1.5 border rounded-lg text-2xs font-bold cursor-pointer transition-all ${
                      tmpl.padding === opt.value
                        ? 'bg-brand-600 border-brand-600 text-white'
                        : isDark ? 'bg-ink-950 border-ink-700 text-ink-500 hover:bg-ink-800' : 'bg-white border-ink-200 text-ink-500 hover:bg-ink-100'
                    }`}>
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-2xs font-bold text-ink-500 dark:text-ink-400 uppercase tracking-wide mb-1">Invoice Footer / Custom Terms</label>
              <textarea rows={2} value={tmpl.terms_footer}
                onChange={e => updateTemplate('terms_footer', e.target.value)}
                placeholder="Thank you for your business!"
                className={`${inputCls} resize-none`} />
            </div>
          </div>

          {/* Remove this branch */}
          {outlets.length > 1 && (
            <div className={`pt-3 border-t ${isDark ? 'border-ink-800' : 'border-ink-100'}`}>
              <button
                type="button"
                onClick={() => removeOutlet(activeIdx)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-bold cursor-pointer text-red-600 dark:text-red-400 border-red-200 dark:border-red-900/40 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove “{outletLabel(current)}”
              </button>
              <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1">
                Only possible while no invoice, quotation or employee is attached to it.
              </p>
            </div>
          )}

        </form>
      </div>
    </Sheet>
  );
}
