import React, { useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus, Search, FileText, CheckCircle, X, Trash2,
  RefreshCw, Edit, Eye, CalendarPlus, Printer, ArrowRightCircle, ChefHat,
} from 'lucide-react';
import {
  DatabaseState, Quotation, QuotationDay, QuotationItem, Customer, CompanyProfile,
  PricingMode, PackageSubMode, ServingStyle, TemplateCustomization, Invoice, InvoiceItem,
} from '../types';
import { generateInvoiceId } from './InvoicingModule';

interface QuotationModuleProps {
  db: DatabaseState;
  setDb: React.Dispatch<React.SetStateAction<DatabaseState>>;
  profiles: CompanyProfile[];
  activeBranchLocation: string;
  isDarkMode: boolean;
  triggerToast: (msg: string, type: 'success' | 'error' | 'warning' | 'info') => void;
  syncStateToSheets: (
    spreadsheetId: string,
    token: string,
    db: DatabaseState,
    profiles: CompanyProfile[],
    activeBranch: string,
  ) => Promise<void>;
  spreadsheetId: string;
  accessToken: string;
  isSyncing: boolean;
  setIsSyncing: (val: boolean) => void;
}

interface DayItemForm {
  Item_ID: string;
  Item_Name: string;
  Quantity: number;
  Price: number;
}

// A Session is a single sitting within a day (e.g. Breakfast, Lunch, Dinner) —
// each with its own time and its own menu, since a day's meals can differ completely.
interface SessionForm {
  Session_ID: string;
  Session_Label: string;
  Session_Time: string;
  items: DayItemForm[];
}

interface DayForm {
  Day_ID: string;
  Event_Date: string;
  Pax: number;
  Serving_Style: ServingStyle;
  Day_Package_Rate: number;
  sessions: SessionForm[];
}

const SERVING_STYLES: ServingStyle[] = ['Packed Bento Boxes', 'Buffet Setup', 'Dome Serving'];

const DEFAULT_CATERING_TERMS =
  'A 50% deposit is required to confirm the booking date. The remaining balance must be cleared on or before the final event date. Final headcount and menu changes must be finalized at least 3 working days prior to the first scheduled event date.';

// ─── Quotation ID generator ────────────────────────────────────────────────
// Uses the same per-company "Invoice Prefix / Series" (CompanyProfile.series_format)
// that Invoice IDs already use, instead of a hardcoded outlet name.
function generateQuotationId(
  outlet: 'Bistro' | 'Nasi Kandar',
  profiles: CompanyProfile[],
  existingQuotations: Quotation[],
): string {
  const profile = profiles.find(p => p.id === outlet);
  const rawPrefix = profile?.series_format || (outlet === 'Bistro' ? 'BIS-26-' : 'NK-26-');
  const cleanPrefix = rawPrefix.replace(/-+$/, '') || (outlet === 'Bistro' ? 'BIS' : 'NK');
  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long' });
  const year = now.getFullYear();
  const escapedPrefix = cleanPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idPattern = new RegExp(`^QTN-${escapedPrefix}-(\\d+)-`);
  let maxNum = 10000;
  existingQuotations.forEach(q => {
    const m = q.Quotation_ID?.match(idPattern);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  });
  return `QTN-${cleanPrefix}-${maxNum + 1}-${month}-${year}`;
}

function isExpired(validUntil?: string): boolean {
  if (!validUntil) return false;
  return new Date(validUntil) < new Date(new Date().toDateString());
}

function formatEventDate(dateStr: string): string {
  if (!dateStr) return 'No date set';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── Quotation → Invoice conversion ────────────────────────────────────────
// Package-priced quotations stay collapsed on the invoice — never reveal the
// hidden per-item prices, even after billing.
function buildConvertedInvoiceItems(
  quotation: Quotation,
  days: QuotationDay[],
  items: QuotationItem[],
  invoiceId: string,
): InvoiceItem[] {
  const sortedDays = [...days].sort((a, b) => a.Event_Date.localeCompare(b.Event_Date));
  const out: InvoiceItem[] = [];
  let idx = 0;
  const nextId = () => `ITEM-${invoiceId}-${++idx}`;

  if (quotation.Pricing_Mode === 'package' && quotation.Package_Sub_Mode === 'flat_total') {
    const total = quotation.Flat_Package_Total || 0;
    out.push({
      Item_ID: nextId(), Invoice_ID: invoiceId,
      Item_Name: `Catering Package — Full Contract (${sortedDays.length} day${sortedDays.length === 1 ? '' : 's'})`,
      Quantity: 1, Price: total, Subtotal: total,
    });
  } else if (quotation.Pricing_Mode === 'package') {
    sortedDays.forEach(day => {
      const rate = day.Day_Package_Rate || 0;
      out.push({
        Item_ID: nextId(), Invoice_ID: invoiceId,
        Item_Name: `Catering Package — ${formatEventDate(day.Event_Date)}`,
        Quantity: 1, Price: rate, Subtotal: rate,
      });
    });
  } else {
    sortedDays.forEach(day => {
      items.filter(it => it.Day_ID === day.Day_ID).forEach(it => {
        const sessionPart = it.Session_Label ? ` (${it.Session_Label})` : '';
        out.push({
          Item_ID: nextId(), Invoice_ID: invoiceId,
          Item_Name: `${formatEventDate(day.Event_Date)}${sessionPart}: ${it.Item_Name}`,
          Quantity: it.Quantity, Price: it.Price, Subtotal: it.Subtotal || it.Quantity * it.Price,
        });
      });
    });
  }

  let charges: { label: string; amount: number }[] = [];
  try { charges = JSON.parse(quotation.Extra_Charges_JSON || '[]'); } catch { /* keep empty */ }
  charges.filter(c => c.label?.trim()).forEach(c => {
    out.push({
      Item_ID: nextId(), Invoice_ID: invoiceId,
      Item_Name: c.label, Quantity: 1, Price: c.amount || 0, Subtotal: c.amount || 0,
    });
  });

  return out;
}

function computeQuotationTotals(
  days: DayForm[],
  pricingMode: PricingMode,
  packageSubMode: PackageSubMode,
  flatPackageTotal: number,
  extraCharges: { label: string; amount: number }[],
  discountType: 'none' | 'percentage' | 'fixed',
  discountValue: number,
) {
  let subtotal = 0;
  if (pricingMode === 'package') {
    subtotal = packageSubMode === 'flat_total'
      ? (flatPackageTotal || 0)
      : days.reduce((s, d) => s + (d.Day_Package_Rate || 0), 0);
  } else {
    subtotal = days.reduce((s, d) => s + d.sessions.reduce((s2, sess) =>
      s2 + sess.items.reduce((s3, it) => s3 + (it.Quantity || 0) * (it.Price || 0), 0), 0), 0);
  }
  const chargesTotal = extraCharges.reduce((s, c) => s + (c.amount || 0), 0);
  const discountAmt = discountType === 'percentage'
    ? subtotal * (discountValue || 0) / 100
    : discountType === 'fixed' ? (discountValue || 0) : 0;
  const total = Math.max(0, subtotal + chargesTotal - discountAmt);
  return { subtotal, chargesTotal, discountAmt, total };
}

// ─── Preview / Print modal ──────────────────────────────────────────────────
interface PreviewData {
  quotation: Quotation;
  days: QuotationDay[];
  items: QuotationItem[];
  profile: CompanyProfile;
}

// Falls back to this when an outlet has no Design settings saved yet in Company Profiles.
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

function fontFamilyCss(font: string): string {
  return font === 'Space Grotesk' ? '"Space Grotesk", sans-serif'
    : font === 'Outfit' ? '"Outfit", sans-serif'
    : font === 'Playfair Display' ? '"Playfair Display", serif'
    : font === 'JetBrains Mono' ? '"JetBrains Mono", monospace'
    : 'Inter, system-ui, sans-serif';
}

function QuotationPreviewModal({ data, onClose }: { data: PreviewData; onClose: () => void }) {
  const { quotation, days, items, profile } = data;
  const customStyles = profile?.template || DEFAULT_TEMPLATE;
  const accent = customStyles.primary_color;
  const currency = profile?.currency_symbol || 'RM';
  const storeName = profile?.store_name || profile?.name || quotation.Company;
  const corpName = profile?.company_name || '';
  const expired = isExpired(quotation.Valid_Until);
  const sortedDays = [...days].sort((a, b) => a.Event_Date.localeCompare(b.Event_Date));

  let charges: { label: string; amount: number }[] = [];
  try { charges = JSON.parse(quotation.Extra_Charges_JSON || '[]'); } catch { /* keep empty */ }

  const subtotal = quotation.Subtotal_Amount ?? quotation.Total_Amount;
  const chargesTotal = charges.reduce((s, c) => s + (c.amount || 0), 0);
  const discountAmt = quotation.Discount_Type === 'percentage'
    ? subtotal * (quotation.Discount_Value || 0) / 100
    : quotation.Discount_Type === 'fixed' ? (quotation.Discount_Value || 0) : 0;

  // Portal straight to <body> so printing isn't constrained by any ancestor in the
  // app's own layout (sidebar, page wrappers, etc.) — see print CSS below for why.
  return createPortal(
    <div id="quotation-preview-overlay" className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-2 sm:p-4 overflow-y-auto w-full h-full">
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          @page { size: A4 portrait; margin: 0mm; }
          body, html { margin: 0 !important; padding: 0 !important; background: white !important; }
          /* The whole app (mounted at #root) is a sibling of this portaled overlay under
             <body> — hide it outright so it can't push the print area down or get counted
             as extra pages. visibility:hidden alone keeps layout boxes in place, which is
             why this must be display:none. */
          #root { display: none !important; }
          body * { visibility: hidden !important; }
          #quotation-print-area, #quotation-print-area * { visibility: visible !important; }
          #quotation-preview-header { display: none !important; }
          /* Ancestors must not constrain height/overflow/padding/centering, or content
             gets clipped to page 1 or pushed down by leftover flex spacing. */
          #quotation-preview-overlay, #quotation-preview-dialog, #quotation-stage-container {
            position: static !important; height: auto !important;
            max-height: none !important; overflow: visible !important;
            padding: 0 !important; margin: 0 !important; display: block !important;
          }
          #quotation-print-area {
            position: static !important;
            width: 210mm !important; min-height: 297mm !important; height: auto !important;
            transform: none !important; background: white !important; border: none !important;
            box-shadow: none !important; margin: 0 !important;
            -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important;
          }
          /* Never split a day, a session's menu table, or the totals box across a page
             boundary — push the whole block to the next page instead of cutting it off. */
          .print-keep-together { break-inside: avoid-page; page-break-inside: avoid; }
        }
        /* On screen, just fill the available width up to a real A4 width and let it scroll
           vertically — the Tailwind classes (w-full max-w-[210mm]) already do this. No
           scale-down transform here: shrinking the whole page to fit a phone screen made
           every line of text microscopic. Only @media print forces the literal 210mm size. */
      `}} />

      <div id="quotation-preview-dialog" className="bg-gray-100 text-slate-900 w-full max-w-5xl rounded-2xl shadow-2xl flex flex-col overflow-hidden text-left h-[90vh]">
        {/* Header bar */}
        <div id="quotation-preview-header" className="px-6 py-4 bg-slate-900 text-white flex justify-between items-center border-b border-gray-800 gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            <h3 className="text-sm font-bold tracking-tight">Quotation Preview</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="px-4 py-1.5 cursor-pointer bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 transition-all shadow-md active:scale-95"
            >
              <Printer className="w-3.5 h-3.5" />
              Print / Save A4
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-gray-400 hover:text-white cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Paper canvas — no flex here on purpose; margin:auto on the page itself centers
            it reliably on every browser without depending on any flexbox cross-axis sizing
            behavior, which is what was leaving a side gap on real mobile browsers. */}
        <div id="quotation-stage-container" className="flex-1 bg-slate-800 p-2 sm:p-8 overflow-auto w-full">
          <div
            id="quotation-print-area"
            className={`@container bg-white w-full max-w-[210mm] mx-auto text-gray-800 shadow-2xl relative overflow-hidden min-h-[297mm] flex flex-col justify-between border border-gray-300 ${customStyles.padding || 'p-8'} ${customStyles.body_size || 'text-xs'}`}
            style={{ borderColor: accent, fontFamily: fontFamilyCss(customStyles.font_family) }}
          >
            <div>
              <div className="absolute top-0 left-0 right-0 h-4" style={{ backgroundImage: `linear-gradient(to right, ${accent}, #F59E0B)` }} />

              {/* Header: logo + company + address. Uses a CONTAINER query (@lg, keyed off
                  this page's own rendered width via @container above) rather than a
                  viewport media query — @media (min-width) during print evaluates against
                  the device's screen, not the printed A4 page, which made mobile print
                  diverge from desktop. A container query instead reads this element's own
                  width, which is genuinely 210mm during print regardless of device, so
                  print/desktop always render this row layout; only the on-screen mobile
                  preview (where this element is actually narrow) gets the stacked version. */}
              <div className={`mt-4 flex flex-col items-center text-center gap-3 mb-6 @lg:gap-4 ${
                customStyles.layout_order === 'logo-right' ? '@lg:flex-row-reverse @lg:justify-between @lg:items-start @lg:text-left' :
                customStyles.layout_order === 'stacked' ? '@lg:flex-col @lg:items-center @lg:justify-center @lg:text-center' :
                '@lg:flex-row @lg:justify-between @lg:items-start @lg:text-left'
              }`}>
                <div className={`flex gap-4 items-center min-w-0 ${customStyles.layout_order === 'stacked' ? 'flex-col' : 'flex-row'}`}>
                  {profile?.logo_url ? (
                    <img src={profile.logo_url} alt="Logo" className="max-h-20 w-auto max-w-[140px] object-contain shrink-0" referrerPolicy="no-referrer" />
                  ) : (
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white font-black text-xl uppercase shadow-lg shrink-0" style={{ backgroundColor: accent }}>
                      {quotation.Company === 'Bistro' ? 'LB' : 'NK'}
                    </div>
                  )}
                  <div className="min-w-0">
                    {corpName && <p className="text-[9px] font-extrabold uppercase text-gray-400 tracking-wider mb-0.5 break-words">{corpName}</p>}
                    <h1 className={`font-black tracking-tight text-gray-900 leading-tight break-words ${customStyles.title_size || 'text-2xl'}`}>{storeName}</h1>
                  </div>
                </div>
                {/* min-w-0 (not shrink-0) lets this wrap instead of forcing the header row
                    wider than the page — flex items default to a content-based minimum
                    width that ignores normal text wrapping unless this is set. */}
                <div className={`text-[10px] text-gray-500 leading-relaxed space-y-0.5 min-w-0 break-words text-center @lg:max-w-[55%] ${
                  customStyles.layout_order === 'logo-right' ? '@lg:text-left' : customStyles.layout_order === 'stacked' ? '@lg:text-center' : '@lg:text-right'
                }`}>
                  {profile?.address && <p className="font-semibold text-gray-700">{profile.address}</p>}
                  <p>Contact: {[profile?.phone, profile?.email].filter(Boolean).join(' | ')}</p>
                </div>
              </div>

              <hr className="border-gray-200 mb-5" />

              {/* Quotation ID + Validity */}
              <div className="flex items-start justify-between mb-5 gap-4">
                <div className="flex-1">
                  <span className="text-[9px] font-extrabold text-gray-400 uppercase tracking-widest block mb-1">Quotation</span>
                  <h3 className="text-2xl font-black text-gray-900 font-mono tracking-tight leading-none mb-3">{quotation.Quotation_ID}</h3>
                  <span className="text-[9px] font-extrabold text-gray-400 uppercase tracking-widest block mb-1">Issued Stamp</span>
                  <p className="text-xs font-semibold text-slate-700">{quotation.Date}</p>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-[9px] font-extrabold text-gray-400 uppercase tracking-widest block mb-2">Validity</span>
                  {quotation.Valid_Until ? (
                    <span className="inline-block px-4 py-1.5 rounded-lg font-extrabold text-[10px] uppercase tracking-widest text-white"
                      style={{ backgroundColor: expired ? '#DC2626' : accent }}>
                      {expired ? 'Expired' : `Valid Until ${quotation.Valid_Until}`}
                    </span>
                  ) : (
                    <span className="text-[10px] text-gray-400">No expiry set</span>
                  )}
                </div>
              </div>

              <hr className="border-gray-100 mb-5" />

              {/* Client block */}
              <div className="print-keep-together border border-gray-200 rounded-2xl p-4 mb-6 bg-white">
                <span className="text-[8px] font-extrabold text-gray-400 uppercase tracking-widest block mb-2">Prepared For</span>
                <p className="text-sm font-black text-gray-900 mb-0.5">{quotation.Customer_Name}</p>
                <p className="text-[10.5px] text-gray-500">Mobile / Email: {quotation.Customer_Contact && quotation.Customer_Contact !== '-' ? quotation.Customer_Contact : '-'}</p>
                {quotation.Customer_Address && quotation.Customer_Address !== '-' && (
                  <p className="text-[10.5px] text-gray-600 font-medium mt-1">{quotation.Customer_Address}</p>
                )}
              </div>

              {/* Day-by-day breakdown */}
              <div className="space-y-4 mb-6">
                {sortedDays.length === 0 && (
                  <p className="text-center text-gray-400 italic py-4">No event dates recorded.</p>
                )}
                {sortedDays.map(day => {
                  const dayItems = items.filter(it => it.Day_ID === day.Day_ID);
                  const dayItemTotal = dayItems.reduce((s, it) => s + (it.Subtotal || it.Quantity * it.Price), 0);
                  // Group this day's items back into their sessions (Breakfast/Lunch/Dinner/etc.)
                  const sessionGroups: { label: string; time: string; rows: QuotationItem[] }[] = [];
                  dayItems.forEach(it => {
                    const label = it.Session_Label || '';
                    const time = it.Session_Time || '';
                    let group = sessionGroups.find(g => g.label === label && g.time === time);
                    if (!group) { group = { label, time, rows: [] }; sessionGroups.push(group); }
                    group.rows.push(it);
                  });
                  return (
                    <div key={day.Day_ID} className="print-keep-together border border-gray-200 rounded-xl overflow-hidden">
                      <div className="px-3 py-2.5 flex flex-wrap items-center justify-between gap-2 text-white" style={{ backgroundColor: accent }}>
                        <div>
                          <p className="text-[11px] font-bold">{formatEventDate(day.Event_Date)}</p>
                          <p className="text-[9px] opacity-90">{day.Pax} pax &middot; {day.Serving_Style}</p>
                        </div>
                        {quotation.Pricing_Mode === 'package' && quotation.Package_Sub_Mode === 'per_day' && (
                          <span className="text-[10px] font-extrabold bg-white/20 px-2.5 py-1 rounded-lg">
                            {currency} {(day.Day_Package_Rate || 0).toFixed(2)}
                          </span>
                        )}
                      </div>

                      {sessionGroups.length === 0 && (
                        <p className="py-3 text-center text-gray-400 italic text-[10.5px]">No menu items added</p>
                      )}

                      {sessionGroups.map((group, gi) => {
                        const groupTotal = group.rows.reduce((s, it) => s + (it.Subtotal || it.Quantity * it.Price), 0);
                        return (
                          <div key={gi} className={`print-keep-together ${gi > 0 ? 'border-t border-gray-200' : ''}`}>
                            {(group.label || group.time) && (
                              <div className="px-3 py-2 bg-gray-50 flex items-center justify-between gap-2 border-l-[3px]" style={{ borderColor: accent }}>
                                <span className="text-[11px] font-extrabold uppercase tracking-wide" style={{ color: accent }}>{group.label || 'Session'}</span>
                                {group.time && <span className="text-[10px] font-bold text-gray-700">{group.time}</span>}
                              </div>
                            )}
                            <table className="w-full table-fixed text-[10.5px] border-collapse">
                              <thead>
                                <tr className="bg-gray-50 text-gray-500 text-[9px] font-bold uppercase tracking-wide">
                                  <th className="py-1.5 px-3 text-left">Menu Item</th>
                                  <th className="py-1.5 px-2 text-center w-16">Qty</th>
                                  {quotation.Pricing_Mode === 'itemized' && <th className="py-1.5 px-2 text-right w-20">Unit Price</th>}
                                  {quotation.Pricing_Mode === 'itemized' && <th className="py-1.5 px-3 text-right w-20">Subtotal</th>}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100">
                                {group.rows.map(it => (
                                  <tr key={it.Item_ID}>
                                    <td className="py-1.5 px-3 font-medium text-gray-800 break-words">{it.Item_Name}</td>
                                    <td className="py-1.5 px-2 text-center text-gray-600">{it.Quantity}</td>
                                    {quotation.Pricing_Mode === 'itemized' && <td className="py-1.5 px-2 text-right text-gray-600 font-mono">{currency} {it.Price.toFixed(2)}</td>}
                                    {quotation.Pricing_Mode === 'itemized' && <td className="py-1.5 px-3 text-right font-bold text-gray-900 font-mono">{currency} {(it.Subtotal || it.Quantity * it.Price).toFixed(2)}</td>}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {quotation.Pricing_Mode === 'itemized' && (
                              <div className="px-3 py-1 text-right text-[9px] font-bold text-gray-500">
                                Session Subtotal: {currency} {groupTotal.toFixed(2)}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {quotation.Pricing_Mode === 'itemized' && dayItems.length > 0 && (
                        <div className="px-3 py-1.5 bg-gray-100 text-right text-[10px] font-bold text-gray-700 border-t border-gray-200">
                          Day Subtotal: {currency} {dayItemTotal.toFixed(2)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Totals — @lg container query (see header above for why container query,
                  not sm: viewport breakpoint). */}
              <div className="flex justify-end mb-8 print-keep-together">
                <div className="w-full @lg:w-[260px] border border-gray-200 rounded-xl p-4 bg-white space-y-2.5 shrink-0">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-gray-500">Subtotal Amount:</span>
                    <span className="font-mono font-semibold text-gray-800">{currency} {subtotal.toFixed(2)}</span>
                  </div>
                  {charges.map((c, i) => (
                    <div key={i} className="flex justify-between items-center text-[11px]">
                      <span className="text-gray-500">{c.label}:</span>
                      {c.amount === 0 ? (
                        <span className="font-mono font-extrabold text-emerald-600">FREE</span>
                      ) : (
                        <span className="font-mono text-gray-700">{currency} {c.amount.toFixed(2)}</span>
                      )}
                    </div>
                  ))}
                  {quotation.Discount_Type && quotation.Discount_Type !== 'none' && (
                    <div className="flex justify-between items-center text-[11px]">
                      <span className="text-gray-500">Discount:</span>
                      <span className="font-mono font-bold text-amber-700">-{currency} {discountAmt.toFixed(2)}</span>
                    </div>
                  )}
                  <div className="border-t border-gray-200 pt-2.5 flex justify-between items-center">
                    <span className="text-sm font-black text-gray-900">Grand Total:</span>
                    <span className="text-sm font-black font-mono" style={{ color: accent }}>{currency} {quotation.Total_Amount.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="border-t border-gray-200 pt-5 mt-auto text-center space-y-1 select-none">
              <p className="text-[9px] font-bold text-gray-500 italic leading-relaxed">
                {quotation.Catering_Terms || DEFAULT_CATERING_TERMS}
              </p>
              <p className="text-[8px] font-mono text-gray-300 uppercase tracking-widest">Generated Securely by BizEazyInvoicing</p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Kitchen Prep Sheet — internal, price-free, for the chef ────────────────
// Same printable-area architecture as the Preview modal (portal to <body>,
// keep-together blocks, multi-page flow) but stripped down to only what the
// kitchen needs: date/time, pax, serving style, and the menu with quantities.
function KitchenSheetModal({ data, onClose }: { data: PreviewData; onClose: () => void }) {
  const { quotation, days, items, profile } = data;
  const customStyles = profile?.template || DEFAULT_TEMPLATE;
  const accent = customStyles.primary_color;
  const storeName = profile?.store_name || profile?.name || quotation.Company;
  const sortedDays = [...days].sort((a, b) => a.Event_Date.localeCompare(b.Event_Date));

  return createPortal(
    <div id="kitchen-sheet-overlay" className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-2 sm:p-4 overflow-y-auto w-full h-full">
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          @page { size: A4 portrait; margin: 0mm; }
          body, html { margin: 0 !important; padding: 0 !important; background: white !important; }
          #root { display: none !important; }
          body * { visibility: hidden !important; }
          #kitchen-sheet-print-area, #kitchen-sheet-print-area * { visibility: visible !important; }
          #kitchen-sheet-header { display: none !important; }
          #kitchen-sheet-overlay, #kitchen-sheet-dialog, #kitchen-sheet-stage {
            position: static !important; height: auto !important;
            max-height: none !important; overflow: visible !important;
            padding: 0 !important; margin: 0 !important; display: block !important;
          }
          #kitchen-sheet-print-area {
            position: static !important;
            width: 210mm !important; min-height: 297mm !important; height: auto !important;
            transform: none !important; background: white !important; border: none !important;
            box-shadow: none !important; margin: 0 !important;
            -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important;
          }
          .print-keep-together { break-inside: avoid-page; page-break-inside: avoid; }
        }
        /* On screen, just fill the available width up to a real A4 width and let it scroll
           vertically — the Tailwind classes (w-full max-w-[210mm]) already do this. No
           scale-down transform here: shrinking the whole page to fit a phone screen made
           every line of text microscopic. Only @media print forces the literal 210mm size. */
      `}} />

      <div id="kitchen-sheet-dialog" className="bg-gray-100 text-slate-900 w-full max-w-5xl rounded-2xl shadow-2xl flex flex-col overflow-hidden text-left h-[90vh]">
        <div id="kitchen-sheet-header" className="px-6 py-4 bg-slate-900 text-white flex justify-between items-center border-b border-gray-800 gap-3">
          <div className="flex items-center gap-2.5">
            <ChefHat className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-bold tracking-tight">Kitchen Prep Sheet</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="px-4 py-1.5 cursor-pointer bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl flex items-center gap-1.5 transition-all shadow-md active:scale-95"
            >
              <Printer className="w-3.5 h-3.5" />
              Print / Save A4
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded-lg transition-all text-gray-400 hover:text-white cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* No flex here on purpose — see Quotation preview for why */}
        <div id="kitchen-sheet-stage" className="flex-1 bg-slate-800 p-2 sm:p-8 overflow-auto w-full">
          <div
            id="kitchen-sheet-print-area"
            className="bg-white w-full max-w-[210mm] mx-auto text-gray-900 shadow-2xl relative overflow-hidden min-h-[297mm] flex flex-col border border-gray-300 p-8 text-xs"
            style={{ fontFamily: fontFamilyCss(customStyles.font_family) }}
          >
            <div>
              <div className="absolute top-0 left-0 right-0 h-4" style={{ backgroundImage: `linear-gradient(to right, ${accent}, #F59E0B)` }} />

              <div className="mt-4 flex items-center justify-between mb-1">
                <div>
                  <h1 className="font-black tracking-tight text-gray-900 text-2xl">{storeName}</h1>
                  <p className="text-xs font-bold uppercase tracking-wide" style={{ color: accent }}>Kitchen Prep Sheet — Internal Use Only</p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] font-extrabold text-gray-400 uppercase tracking-widest">Quotation Ref</p>
                  <p className="text-sm font-mono font-bold text-gray-800">{quotation.Quotation_ID}</p>
                </div>
              </div>

              <hr className="border-gray-200 my-4" />

              <div className="mb-6 print-keep-together">
                <p className="text-[10px] text-gray-500">
                  Client: <span className="font-bold text-gray-900">{quotation.Customer_Name}</span>
                </p>
                {quotation.Notes && quotation.Notes.trim() && (
                  <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                    <p className="text-[9px] font-extrabold text-amber-700 uppercase tracking-widest mb-1">Special Notes</p>
                    <p className="text-xs text-gray-800">{quotation.Notes}</p>
                  </div>
                )}
              </div>

              {sortedDays.length === 0 && (
                <p className="text-center text-gray-400 italic py-4">No event dates recorded.</p>
              )}

              <div className="space-y-4">
                {sortedDays.map(day => {
                  const dayItems = items.filter(it => it.Day_ID === day.Day_ID);
                  const sessionGroups: { label: string; time: string; rows: QuotationItem[] }[] = [];
                  dayItems.forEach(it => {
                    const label = it.Session_Label || '';
                    const time = it.Session_Time || '';
                    let group = sessionGroups.find(g => g.label === label && g.time === time);
                    if (!group) { group = { label, time, rows: [] }; sessionGroups.push(group); }
                    group.rows.push(it);
                  });

                  return (
                    <div key={day.Day_ID} className="print-keep-together border border-gray-200 rounded-xl overflow-hidden">
                      <div className="px-3 py-2.5 flex flex-wrap items-center justify-between gap-2 text-white" style={{ backgroundColor: accent }}>
                        <p className="text-[12px] font-extrabold">{formatEventDate(day.Event_Date)}</p>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-extrabold bg-white/20 px-2.5 py-1 rounded-lg uppercase">{day.Serving_Style}</span>
                          <span className="text-[10px] font-extrabold bg-white/20 px-2.5 py-1 rounded-lg">PAX: {day.Pax}</span>
                        </div>
                      </div>

                      {sessionGroups.length === 0 && (
                        <p className="py-3 text-center text-gray-400 italic text-[10.5px]">No menu items added</p>
                      )}

                      {sessionGroups.map((group, gi) => (
                        <div key={gi} className="print-keep-together border-t border-gray-100 first:border-t-0">
                          <div className="px-3 py-2 bg-gray-50 flex items-center justify-between gap-2 border-l-[3px]" style={{ borderColor: accent }}>
                            <span className="text-[11px] font-extrabold uppercase tracking-wide" style={{ color: accent }}>{group.label || 'Session'}</span>
                            {group.time && <span className="text-[10px] font-bold text-gray-700">{group.time}</span>}
                          </div>
                          <table className="w-full table-fixed text-[11px] border-collapse">
                            <thead>
                              <tr className="bg-gray-50 text-gray-500 text-[9px] font-bold uppercase tracking-wide">
                                <th className="py-1.5 px-3 text-left">Menu Item</th>
                                <th className="py-1.5 px-3 text-right w-20">Qty</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {group.rows.map(it => (
                                <tr key={it.Item_ID}>
                                  <td className="py-1.5 px-3 font-semibold text-gray-900 break-words">{it.Item_Name}</td>
                                  <td className="py-1.5 px-3 text-right font-mono font-bold text-gray-700">{it.Quantity}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-gray-200 pt-4 mt-6 text-center">
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">Internal Kitchen Use Only — Not for Client Distribution</p>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Component ──────────────────────────────────────────────────────────────
export default function QuotationModule({
  db, setDb, profiles, activeBranchLocation, isDarkMode,
  triggerToast, syncStateToSheets, spreadsheetId, accessToken,
  isSyncing, setIsSyncing,
}: QuotationModuleProps) {

  const [search, setSearch] = useState('');
  const [filterOutlet, setFilterOutlet] = useState<'All' | 'Bistro' | 'Nasi Kandar'>('All');

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingQuotation, setEditingQuotation] = useState<Quotation | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [kitchenSheetData, setKitchenSheetData] = useState<PreviewData | null>(null);

  const [modalOutlet, setModalOutlet] = useState<'Bistro' | 'Nasi Kandar'>('Bistro');
  const [modalDate, setModalDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [modalValidUntil, setModalValidUntil] = useState('');
  const [modalCustomer, setModalCustomer] = useState('');
  const [modalContact, setModalContact] = useState('');
  const [modalAddress, setModalAddress] = useState('');
  const [modalNotes, setModalNotes] = useState('');
  const [saveCustomer, setSaveCustomer] = useState(false);
  const [customerSuggestions, setCustomerSuggestions] = useState<Customer[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [pricingMode, setPricingMode] = useState<PricingMode>('itemized');
  const [packageSubMode, setPackageSubMode] = useState<PackageSubMode>('per_day');
  const [flatPackageTotal, setFlatPackageTotal] = useState(0);
  const [days, setDays] = useState<DayForm[]>([]);
  const [itemDrafts, setItemDrafts] = useState<Record<string, { name: string; qty: number; price: number }>>({});

  const [discountType, setDiscountType] = useState<'none' | 'percentage' | 'fixed'>('none');
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [includeExtraCharge, setIncludeExtraCharge] = useState(false);
  const [extraCharges, setExtraCharges] = useState<{ label: string; amount: number }[]>([{ label: 'Delivery', amount: 0 }]);
  const [cateringTerms, setCateringTerms] = useState(DEFAULT_CATERING_TERMS);

  // ── Derived ───────────────────────────────────────────────────────────────
  const activeProfile = useMemo(() => {
    const isBistro = activeBranchLocation.toLowerCase().includes('bistro');
    return profiles.find(p => isBistro ? p.id === 'Bistro' : p.id === 'Nasi Kandar') || profiles[0];
  }, [profiles, activeBranchLocation]);

  const currency = activeProfile?.currency_symbol || 'RM';
  const fmt = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return db.quotations.filter(quo => {
      if (filterOutlet !== 'All' && quo.Company !== filterOutlet) return false;
      if (q) {
        return (
          (quo.Quotation_ID || '').toLowerCase().includes(q) ||
          (quo.Customer_Name || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [db.quotations, search, filterOutlet]);

  const stats = useMemo(() => {
    const all = db.quotations;
    const expiredCount = all.filter(q => isExpired(q.Valid_Until)).length;
    return {
      total: all.reduce((s, q) => s + (Number(q.Total_Amount) || 0), 0),
      count: all.length,
      expiredCount,
      activeCount: all.length - expiredCount,
    };
  }, [db.quotations]);

  const liveTotals = useMemo(
    () => computeQuotationTotals(days, pricingMode, packageSubMode, flatPackageTotal, includeExtraCharge ? extraCharges : [], discountType, discountValue),
    [days, pricingMode, packageSubMode, flatPackageTotal, includeExtraCharge, extraCharges, discountType, discountValue],
  );

  // ── Day / session / item helpers ──────────────────────────────────────────
  const addDay = () => {
    const newDay: DayForm = {
      Day_ID: `DAY-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      Event_Date: '', Pax: 0,
      Serving_Style: 'Buffet Setup', Day_Package_Rate: 0, sessions: [],
    };
    setDays(prev => [...prev, newDay]);
  };
  const removeDay = (dayId: string) => {
    setDays(prev => prev.filter(d => d.Day_ID !== dayId));
  };
  const updateDay = (dayId: string, patch: Partial<DayForm>) => {
    setDays(prev => prev.map(d => d.Day_ID === dayId ? { ...d, ...patch } : d));
  };

  const addSession = (dayId: string) => {
    const newSession: SessionForm = {
      Session_ID: `SESS-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      Session_Label: '', Session_Time: '', items: [],
    };
    setDays(prev => prev.map(d => d.Day_ID === dayId ? { ...d, sessions: [...d.sessions, newSession] } : d));
  };
  const removeSession = (dayId: string, sessionId: string) => {
    setDays(prev => prev.map(d => d.Day_ID === dayId ? { ...d, sessions: d.sessions.filter(s => s.Session_ID !== sessionId) } : d));
    setItemDrafts(prev => { const next = { ...prev }; delete next[sessionId]; return next; });
  };
  const updateSession = (dayId: string, sessionId: string, patch: Partial<SessionForm>) => {
    setDays(prev => prev.map(d => d.Day_ID === dayId
      ? { ...d, sessions: d.sessions.map(s => s.Session_ID === sessionId ? { ...s, ...patch } : s) }
      : d));
  };

  const getDraft = (sessionId: string) => itemDrafts[sessionId] || { name: '', qty: 1, price: 0 };
  const setDraft = (sessionId: string, patch: Partial<{ name: string; qty: number; price: number }>) => {
    setItemDrafts(prev => ({ ...prev, [sessionId]: { ...getDraft(sessionId), ...patch } }));
  };
  const addItemToSession = (dayId: string, sessionId: string) => {
    const draft = getDraft(sessionId);
    if (!draft.name.trim()) return;
    const newItem: DayItemForm = {
      Item_ID: `QITM-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      Item_Name: draft.name.trim(), Quantity: draft.qty || 1, Price: draft.price || 0,
    };
    setDays(prev => prev.map(d => d.Day_ID === dayId
      ? { ...d, sessions: d.sessions.map(s => s.Session_ID === sessionId ? { ...s, items: [...s.items, newItem] } : s) }
      : d));
    setDraft(sessionId, { name: '', qty: 1, price: 0 });
  };
  const removeItemFromSession = (dayId: string, sessionId: string, itemId: string) => {
    setDays(prev => prev.map(d => d.Day_ID === dayId
      ? { ...d, sessions: d.sessions.map(s => s.Session_ID === sessionId ? { ...s, items: s.items.filter(i => i.Item_ID !== itemId) } : s) }
      : d));
  };
  const updateItemInSession = (dayId: string, sessionId: string, itemId: string, patch: Partial<DayItemForm>) => {
    setDays(prev => prev.map(d => d.Day_ID === dayId
      ? { ...d, sessions: d.sessions.map(s => s.Session_ID === sessionId ? { ...s, items: s.items.map(i => i.Item_ID === itemId ? { ...i, ...patch } : i) } : s) }
      : d));
  };

  // ── Customer autocomplete ─────────────────────────────────────────────────
  const handleCustomerInput = (val: string) => {
    setModalCustomer(val);
    if (!val.trim()) { setCustomerSuggestions([]); setShowSuggestions(false); return; }
    const matches = db.customers.filter(c => c.Customer_Name.toLowerCase().includes(val.toLowerCase())).slice(0, 6);
    setCustomerSuggestions(matches);
    setShowSuggestions(matches.length > 0);
  };
  const selectCustomer = (c: Customer) => {
    setModalCustomer(c.Customer_Name);
    setModalContact(c.Contact || '');
    setModalAddress(c.Address === '-' ? '' : (c.Address || ''));
    setShowSuggestions(false);
  };

  // ── Open modal (create OR edit) ───────────────────────────────────────────
  const openModal = (quotation?: Quotation) => {
    if (quotation) {
      setEditingQuotation(quotation);
      setModalOutlet(quotation.Company);
      setModalDate(quotation.Date);
      setModalValidUntil(quotation.Valid_Until || '');
      setModalCustomer(quotation.Customer_Name);
      setModalContact(quotation.Customer_Contact === '-' ? '' : (quotation.Customer_Contact || ''));
      setModalAddress(quotation.Customer_Address === '-' ? '' : (quotation.Customer_Address || ''));
      setModalNotes(quotation.Notes || '');
      setPricingMode(quotation.Pricing_Mode);
      setPackageSubMode(quotation.Package_Sub_Mode || 'per_day');
      setFlatPackageTotal(quotation.Flat_Package_Total || 0);
      setCateringTerms(quotation.Catering_Terms || DEFAULT_CATERING_TERMS);
      setDiscountType(quotation.Discount_Type || 'none');
      setDiscountValue(quotation.Discount_Value || 0);
      setSaveCustomer(false);

      let charges: { label: string; amount: number }[] = [];
      try { charges = JSON.parse(quotation.Extra_Charges_JSON || '[]'); } catch { /* keep empty */ }
      setIncludeExtraCharge(charges.length > 0);
      setExtraCharges(charges.length > 0 ? charges : [{ label: 'Delivery', amount: 0 }]);

      const existingDays = db.quotation_days.filter(d => d.Quotation_ID === quotation.Quotation_ID);
      const formDays: DayForm[] = existingDays.map(d => {
        const dayItems = db.quotation_items.filter(it => it.Day_ID === d.Day_ID);
        // Group items back into sessions by their saved Session_Label + Session_Time pair.
        const sessionMap = new Map<string, SessionForm>();
        dayItems.forEach(it => {
          const label = it.Session_Label || '';
          const time = it.Session_Time || '';
          const key = `${label}|||${time}`;
          if (!sessionMap.has(key)) {
            sessionMap.set(key, {
              Session_ID: `SESS-${d.Day_ID}-${sessionMap.size}`,
              Session_Label: label, Session_Time: time, items: [],
            });
          }
          sessionMap.get(key)!.items.push({
            Item_ID: it.Item_ID, Item_Name: it.Item_Name, Quantity: it.Quantity, Price: it.Price,
          });
        });
        return {
          Day_ID: d.Day_ID,
          Event_Date: d.Event_Date,
          Pax: d.Pax,
          Serving_Style: d.Serving_Style,
          Day_Package_Rate: d.Day_Package_Rate || 0,
          sessions: Array.from(sessionMap.values()),
        };
      });
      setDays(formDays);
      setItemDrafts({});
    } else {
      setEditingQuotation(null);
      const isBistro = activeBranchLocation.toLowerCase().includes('bistro');
      setModalOutlet(isBistro ? 'Bistro' : 'Nasi Kandar');
      setModalDate(new Date().toISOString().slice(0, 10));
      setModalValidUntil('');
      setModalCustomer(''); setModalContact(''); setModalAddress(''); setModalNotes('');
      setPricingMode('itemized');
      setPackageSubMode('per_day');
      setFlatPackageTotal(0);
      setCateringTerms(DEFAULT_CATERING_TERMS);
      setDiscountType('none');
      setDiscountValue(0);
      setIncludeExtraCharge(false);
      setExtraCharges([{ label: 'Delivery', amount: 0 }]);
      setDays([]);
      setItemDrafts({});
      setSaveCustomer(false);
    }
    setIsModalOpen(true);
  };

  // ── Submit (create or update) ─────────────────────────────────────────────
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalCustomer.trim()) { triggerToast('Customer name is required.', 'warning'); return; }
    if (days.length === 0) { triggerToast('Add at least one event date.', 'warning'); return; }
    if (days.some(d => !d.Event_Date)) { triggerToast('Every day container needs a date.', 'warning'); return; }

    const totals = computeQuotationTotals(days, pricingMode, packageSubMode, flatPackageTotal, includeExtraCharge ? extraCharges : [], discountType, discountValue);
    const quotationId = editingQuotation ? editingQuotation.Quotation_ID : generateQuotationId(modalOutlet, profiles, db.quotations);

    const quotationRecord: Quotation = {
      Quotation_ID: quotationId,
      Date: modalDate,
      Valid_Until: modalValidUntil || undefined,
      Company: modalOutlet,
      Customer_Name: modalCustomer.trim(),
      Customer_Contact: modalContact.trim() || '-',
      Customer_Address: modalAddress.trim() || '-',
      Pricing_Mode: pricingMode,
      Package_Sub_Mode: pricingMode === 'package' ? packageSubMode : undefined,
      Flat_Package_Total: pricingMode === 'package' && packageSubMode === 'flat_total' ? flatPackageTotal : 0,
      Extra_Charges_JSON: includeExtraCharge ? JSON.stringify(extraCharges.filter(c => c.label.trim())) : '',
      Discount_Type: discountType,
      Discount_Value: discountValue,
      Subtotal_Amount: totals.subtotal,
      Total_Amount: totals.total,
      Catering_Terms: cateringTerms.trim(),
      Notes: modalNotes.trim(),
      Branch_Location: activeBranchLocation,
    };

    const updatedQuotations = editingQuotation
      ? db.quotations.map(q => q.Quotation_ID === quotationId ? quotationRecord : q)
      : [quotationRecord, ...db.quotations];

    const newDays: QuotationDay[] = days.map(d => ({
      Day_ID: d.Day_ID, Quotation_ID: quotationId, Event_Date: d.Event_Date,
      Pax: d.Pax,
      Serving_Style: d.Serving_Style,
      Day_Package_Rate: pricingMode === 'package' && packageSubMode === 'per_day' ? d.Day_Package_Rate : 0,
    }));

    const newItems: QuotationItem[] = days.flatMap(d => d.sessions.flatMap(sess => sess.items
      .filter(it => it.Item_Name.trim())
      .map(it => ({
        Item_ID: it.Item_ID, Quotation_ID: quotationId, Day_ID: d.Day_ID,
        Session_Label: sess.Session_Label.trim(), Session_Time: sess.Session_Time.trim(),
        Item_Name: it.Item_Name.trim(), Quantity: it.Quantity,
        Price: pricingMode === 'itemized' ? it.Price : 0,
        Subtotal: pricingMode === 'itemized' ? it.Quantity * it.Price : 0,
      }))));

    const updatedDays = [...db.quotation_days.filter(d => d.Quotation_ID !== quotationId), ...newDays];
    const updatedItems = [...db.quotation_items.filter(it => it.Quotation_ID !== quotationId), ...newItems];

    let updatedCustomers = [...db.customers];
    if (saveCustomer && modalCustomer.trim()) {
      const exists = updatedCustomers.some(c => c.Customer_Name.toLowerCase() === modalCustomer.toLowerCase().trim());
      if (!exists) {
        updatedCustomers.push({
          Customer_Name: modalCustomer.trim(), Contact: modalContact.trim() || '-',
          Customer_Type: 'Regular', Branch_Location: activeBranchLocation,
        });
      }
    }

    const nextDb: DatabaseState = {
      ...db,
      quotations: updatedQuotations,
      quotation_days: updatedDays,
      quotation_items: updatedItems,
      customers: updatedCustomers,
    };

    setDb(nextDb);
    setIsModalOpen(false);
    triggerToast(editingQuotation ? `Quotation ${quotationId} updated locally.` : `Quotation ${quotationId} created.`, 'info');

    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast(`${quotationId} saved to Google Sheets!`, 'success');
    } catch (err: any) {
      triggerToast(`Sync failed: ${err.message}`, 'error');
    } finally {
      setIsSyncing(false);
    }
  }, [editingQuotation, modalOutlet, modalDate, modalValidUntil, modalCustomer, modalContact, modalAddress, modalNotes,
    pricingMode, packageSubMode, flatPackageTotal, days, cateringTerms, discountType, discountValue,
    includeExtraCharge, extraCharges, saveCustomer,
    db, profiles, activeBranchLocation, spreadsheetId, accessToken, setDb, triggerToast, syncStateToSheets, setIsSyncing]);

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (quotationId: string) => {
    if (!window.confirm(`Delete quotation ${quotationId}? This cannot be undone.`)) return;
    const nextDb: DatabaseState = {
      ...db,
      quotations: db.quotations.filter(q => q.Quotation_ID !== quotationId),
      quotation_days: db.quotation_days.filter(d => d.Quotation_ID !== quotationId),
      quotation_items: db.quotation_items.filter(it => it.Quotation_ID !== quotationId),
    };
    setDb(nextDb);
    setIsModalOpen(false);
    triggerToast(`Quotation ${quotationId} deleted.`, 'success');
    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
    } catch (err: any) {
      triggerToast(`Sync failed after delete: ${err.message}`, 'error');
    } finally {
      setIsSyncing(false);
    }
  }, [db, profiles, activeBranchLocation, spreadsheetId, accessToken, setDb, triggerToast, syncStateToSheets, setIsSyncing]);

  const handleConvertToInvoice = useCallback(async (quotation: Quotation) => {
    if (quotation.Converted_Invoice_ID) return;
    if (!window.confirm(`Convert ${quotation.Quotation_ID} to a real invoice for ${quotation.Customer_Name}? This creates a new billable record you can collect payment against.`)) return;

    const qDays = db.quotation_days.filter(d => d.Quotation_ID === quotation.Quotation_ID);
    const qItems = db.quotation_items.filter(it => it.Quotation_ID === quotation.Quotation_ID);
    const invoiceId = generateInvoiceId(quotation.Company, profiles, db.invoices);
    const newItems = buildConvertedInvoiceItems(quotation, qDays, qItems, invoiceId);

    const newInvoice: Invoice = {
      Invoice_ID: invoiceId,
      Date: new Date().toISOString().slice(0, 10),
      Company: quotation.Company,
      Customer_Name: quotation.Customer_Name,
      Customer_Type: db.customers.some(c => c.Customer_Name.toLowerCase() === quotation.Customer_Name.toLowerCase()) ? 'Regular' : 'New',
      Status: 'Pending',
      Total_Amount: quotation.Total_Amount,
      Discount_Type: quotation.Discount_Type === 'fixed' ? 'flat' : (quotation.Discount_Type || 'none'),
      Discount_Value: quotation.Discount_Value || 0,
      Subtotal_Amount: quotation.Subtotal_Amount ?? quotation.Total_Amount,
      Customer_Contact: quotation.Customer_Contact || '-',
      Customer_Address: quotation.Customer_Address || '-',
      Notes: `Converted from Quotation ${quotation.Quotation_ID}${quotation.Notes ? ' — ' + quotation.Notes : ''}`,
      Branch_Location: quotation.Branch_Location || activeBranchLocation,
    };

    const nextDb: DatabaseState = {
      ...db,
      invoices: [newInvoice, ...db.invoices],
      invoice_items: [...db.invoice_items, ...newItems],
      quotations: db.quotations.map(q => q.Quotation_ID === quotation.Quotation_ID ? { ...q, Converted_Invoice_ID: invoiceId } : q),
    };

    setDb(nextDb);
    setIsModalOpen(false);
    triggerToast(`Converted to Invoice ${invoiceId}.`, 'info');
    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast(`${invoiceId} saved to Google Sheets!`, 'success');
    } catch (err: any) {
      triggerToast(`Saved locally but Sheets Sync failed: ${err.message}`, 'error');
    } finally {
      setIsSyncing(false);
    }
  }, [db, profiles, activeBranchLocation, spreadsheetId, accessToken, setDb, triggerToast, syncStateToSheets, setIsSyncing]);

  const openPreview = (q: Quotation) => {
    const qDays = db.quotation_days.filter(d => d.Quotation_ID === q.Quotation_ID);
    const qItems = db.quotation_items.filter(it => it.Quotation_ID === q.Quotation_ID);
    const profile = profiles.find(p => p.id === q.Company) || profiles[0];
    if (!profile) { triggerToast('No company profile found for this outlet.', 'error'); return; }
    setPreviewData({ quotation: q, days: qDays, items: qItems, profile });
  };

  const openKitchenSheet = (q: Quotation) => {
    const qDays = db.quotation_days.filter(d => d.Quotation_ID === q.Quotation_ID);
    const qItems = db.quotation_items.filter(it => it.Quotation_ID === q.Quotation_ID);
    const profile = profiles.find(p => p.id === q.Company) || profiles[0];
    if (!profile) { triggerToast('No company profile found for this outlet.', 'error'); return; }
    setKitchenSheetData({ quotation: q, days: qDays, items: qItems, profile });
  };

  const inputClass = `w-full px-3 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
    isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
  }`;
  const smallInputClass = `px-2.5 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
    isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
  }`;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Quoted Value', value: `${currency} ${fmt(stats.total)}`, sub: `${stats.count} quotations` },
          { label: 'Active', value: String(stats.activeCount), sub: 'within validity' },
          { label: 'Expired', value: String(stats.expiredCount), sub: 'past valid-until date' },
        ].map(s => (
          <div key={s.label} className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-xl px-4 py-3">
            <div className="text-[10px] font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider">{s.label}</div>
            <div className="text-base font-black text-gray-900 dark:text-white font-mono mt-0.5">{s.value}</div>
            <div className="text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Search ID, customer…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className={`pl-9 pr-3 py-2 text-xs rounded-lg border w-full focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
              }`}
            />
          </div>
          <button
            onClick={() => openModal()}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-3.5 py-2 rounded-lg transition-colors cursor-pointer shadow-sm shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">New Quotation</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
        <select
          value={filterOutlet}
          onChange={e => setFilterOutlet(e.target.value as typeof filterOutlet)}
          className={`w-full px-3 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
            isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
          }`}
        >
          <option value="All">All Outlets</option>
          {profiles.map(p => <option key={p.id} value={p.id}>{p.store_name || p.name}</option>)}
        </select>
      </div>

      {/* Quotation table */}
      <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center">
            <FileText className="w-8 h-8 text-gray-200 dark:text-slate-700 mx-auto mb-3" />
            <p className="text-xs font-bold text-gray-500 dark:text-slate-400">
              {db.quotations.length === 0 ? 'No quotations yet — create your first one.' : 'No quotations match these filters.'}
            </p>
          </div>
        ) : (
          <>
          <div className="hidden md:block overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className={`border-b text-[10px] font-bold uppercase tracking-wider ${
                isDarkMode ? 'bg-slate-950/40 border-slate-800 text-slate-400' : 'bg-gray-50 border-gray-200 text-gray-500'
              }`}>
                <tr>
                  <th className="px-5 py-3">Quotation ID</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Valid Until</th>
                  <th className="px-4 py-3">Outlet</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Pricing</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-gray-100'}`}>
                {filtered.map(q => {
                  const p = profiles.find(pr => pr.id === q.Company);
                  const curr = p?.currency_symbol || 'RM';
                  const expired = isExpired(q.Valid_Until);
                  return (
                    <tr key={q.Quotation_ID} className="hover:bg-gray-50/50 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-5 py-3.5 font-mono font-bold text-gray-900 dark:text-white whitespace-nowrap">{q.Quotation_ID}</td>
                      <td className="px-4 py-3.5 text-gray-500 dark:text-slate-400 whitespace-nowrap">{q.Date}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap">
                        {q.Valid_Until ? (
                          <span className={`text-[10px] font-bold ${expired ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                            {expired ? 'Expired' : q.Valid_Until}
                          </span>
                        ) : <span className="text-gray-400 text-[10px]">—</span>}
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase whitespace-nowrap ${
                          q.Company === 'Bistro'
                            ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
                            : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400'
                        }`}>
                          {p?.store_name || q.Company}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 font-medium text-gray-700 dark:text-slate-300 max-w-[160px] truncate">{q.Customer_Name}</td>
                      <td className="px-4 py-3.5">
                        <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-400 whitespace-nowrap">
                          {q.Pricing_Mode === 'package' ? `Package · ${q.Package_Sub_Mode === 'flat_total' ? 'Flat' : 'Per-Day'}` : 'Itemized'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right font-black font-mono text-gray-900 dark:text-white whitespace-nowrap">
                        {curr} {Number(q.Total_Amount).toFixed(2)}
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                          {q.Converted_Invoice_ID ? (
                            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400" title={`Converted to ${q.Converted_Invoice_ID}`}>
                              Converted → {q.Converted_Invoice_ID}
                            </span>
                          ) : (
                            <button onClick={() => handleConvertToInvoice(q)} className="flex items-center gap-1 text-[10px] font-bold text-emerald-600 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300 cursor-pointer transition-colors" title="Convert to Invoice">
                              <ArrowRightCircle className="w-3.5 h-3.5" /> Convert
                            </button>
                          )}
                          <button onClick={() => openModal(q)} className="p-1 text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 rounded cursor-pointer transition-colors" title="Edit quotation">
                            <Edit className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => openKitchenSheet(q)} className="flex items-center gap-1 text-[10px] font-bold text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 cursor-pointer transition-colors" title="Kitchen prep sheet (no prices)">
                            <ChefHat className="w-3.5 h-3.5" /> Kitchen Sheet
                          </button>
                          <button onClick={() => openPreview(q)} className="flex items-center gap-1 text-[10px] font-bold text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 cursor-pointer transition-colors">
                            <Eye className="w-3.5 h-3.5" /> Preview
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden divide-y divide-gray-100 dark:divide-slate-800">
            {filtered.map(q => {
              const expired = isExpired(q.Valid_Until);
              return (
                <div key={q.Quotation_ID} className={`p-4 space-y-3 ${isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-gray-50/60'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`text-xs font-black font-mono break-all ${isDarkMode ? 'text-indigo-400' : 'text-indigo-700'}`}>{q.Quotation_ID}</span>
                        {q.Valid_Until && (
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${
                            expired ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                          }`}>{expired ? 'Expired' : 'Active'}</span>
                        )}
                      </div>
                      <p className={`text-xs font-semibold truncate ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>{q.Customer_Name}</p>
                      <p className={`text-[10px] mt-0.5 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>{q.Date}</p>
                    </div>
                    <p className={`text-sm font-black font-mono shrink-0 ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>{currency} {Number(q.Total_Amount).toFixed(2)}</p>
                  </div>

                  {q.Converted_Invoice_ID && (
                    <div className="px-2.5 py-1.5 text-[10px] font-bold rounded-lg bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 text-center">
                      Converted → {q.Converted_Invoice_ID}
                    </div>
                  )}

                  {/* Actions — own row, evenly spaced, so they don't crowd the ID/customer text */}
                  <div className="grid grid-cols-2 gap-1.5">
                    <button onClick={() => openModal(q)} className={`flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-bold rounded-lg cursor-pointer transition-colors ${isDarkMode ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                      <Edit className="w-3 h-3" /> Edit
                    </button>
                    <button onClick={() => openPreview(q)} className={`flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-bold rounded-lg cursor-pointer transition-colors ${isDarkMode ? 'bg-indigo-950/40 text-indigo-400 hover:bg-indigo-900/50' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}`}>
                      <Eye className="w-3 h-3" /> Preview
                    </button>
                    <button onClick={() => openKitchenSheet(q)} className={`flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-bold rounded-lg cursor-pointer transition-colors ${isDarkMode ? 'bg-amber-950/30 text-amber-400 hover:bg-amber-900/40' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}>
                      <ChefHat className="w-3 h-3" /> Kitchen Sheet
                    </button>
                    {!q.Converted_Invoice_ID && (
                      <button onClick={() => handleConvertToInvoice(q)} className={`flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-bold rounded-lg cursor-pointer transition-colors ${isDarkMode ? 'bg-emerald-950/30 text-emerald-400 hover:bg-emerald-900/40' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
                        <ArrowRightCircle className="w-3 h-3" /> Convert
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}
      </div>

      {/* ── Create / Edit Quotation Modal ─────────────────────────────────── */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className={`w-full max-w-6xl rounded-2xl shadow-2xl flex flex-col max-h-[92vh] ${
            isDarkMode ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-gray-200'
          }`}>
            <div className={`flex items-center justify-between px-6 py-4 border-b flex-shrink-0 ${isDarkMode ? 'border-slate-800' : 'border-gray-100'}`}>
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-500" />
                <h2 className="text-sm font-bold text-gray-900 dark:text-white">
                  {editingQuotation ? `Edit Quotation — ${editingQuotation.Quotation_ID}` : 'New Quotation'}
                </h2>
              </div>
              <button onClick={() => setIsModalOpen(false)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.4fr] gap-6">

                {/* Left: metadata */}
                <div className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Outlet *</label>
                    <div className="flex gap-2">
                      {(['Bistro', 'Nasi Kandar'] as const).map(outlet => (
                        <button
                          key={outlet}
                          type="button"
                          onClick={() => setModalOutlet(outlet)}
                          className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-colors cursor-pointer ${
                            modalOutlet === outlet
                              ? 'bg-indigo-600 border-indigo-600 text-white'
                              : isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-300 hover:border-slate-500' : 'bg-white border-gray-200 text-gray-700 hover:border-gray-300'
                          }`}
                        >
                          {profiles.find(p => p.id === outlet)?.store_name || outlet}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Issue Date *</label>
                      <input type="date" value={modalDate} onChange={e => setModalDate(e.target.value)} className={`${inputClass} ${isDarkMode ? '[color-scheme:dark]' : '[color-scheme:light]'}`} required />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Valid Until</label>
                      <input type="date" value={modalValidUntil} onChange={e => setModalValidUntil(e.target.value)} className={`${inputClass} ${isDarkMode ? '[color-scheme:dark]' : '[color-scheme:light]'}`} />
                    </div>
                  </div>

                  <div className="relative">
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Customer Name *</label>
                    <input
                      type="text"
                      value={modalCustomer}
                      onChange={e => handleCustomerInput(e.target.value)}
                      onFocus={() => modalCustomer && setShowSuggestions(customerSuggestions.length > 0)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                      placeholder="Type to search existing customers…"
                      className={inputClass}
                      required
                      autoComplete="off"
                    />
                    {showSuggestions && (
                      <div className={`absolute z-10 w-full mt-1 rounded-xl border shadow-lg max-h-36 overflow-y-auto ${isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-gray-200'}`}>
                        {customerSuggestions.map(c => (
                          <button key={c.Customer_Name} type="button" onMouseDown={() => selectCustomer(c)}
                            className={`w-full text-left px-3 py-2 text-xs font-semibold flex justify-between items-center cursor-pointer ${isDarkMode ? 'hover:bg-slate-800 text-slate-200' : 'hover:bg-gray-50 text-gray-800'}`}>
                            <span>{c.Customer_Name}</span>
                            <span className="text-[10px] text-gray-400 dark:text-slate-500 font-mono">{c.Contact || 'No contact'}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Contact / Email</label>
                    <input type="text" value={modalContact} onChange={e => setModalContact(e.target.value)} placeholder="Phone, email, or billing reference…" className={inputClass} />
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Address</label>
                    <input type="text" value={modalAddress} onChange={e => setModalAddress(e.target.value)} placeholder="Delivery / billing address…" className={inputClass} />
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Notes</label>
                    <textarea value={modalNotes} onChange={e => setModalNotes(e.target.value)} placeholder="Optional remarks…" rows={2} className={`${inputClass} resize-none`} />
                  </div>

                  {/* Pricing mode */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Pricing Mode</label>
                    <div className="flex gap-2 mb-2">
                      {([['itemized', 'Itemized Pricing'], ['package', 'Package / Set Menu']] as const).map(([val, label]) => (
                        <button key={val} type="button" onClick={() => setPricingMode(val)}
                          className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-colors cursor-pointer ${
                            pricingMode === val ? 'bg-indigo-600 border-indigo-600 text-white' : isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-300' : 'bg-white border-gray-200 text-gray-700'
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {pricingMode === 'package' && (
                      <div className="flex gap-2">
                        {([['per_day', 'Per-Day Rate'], ['flat_total', 'Flat Total Rate']] as const).map(([val, label]) => (
                          <button key={val} type="button" onClick={() => setPackageSubMode(val)}
                            className={`flex-1 py-1.5 text-[11px] font-bold rounded-lg border transition-colors cursor-pointer ${
                              packageSubMode === val ? 'bg-amber-500 border-amber-500 text-white' : isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-300' : 'bg-white border-gray-200 text-gray-700'
                            }`}>
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                    {pricingMode === 'package' && packageSubMode === 'flat_total' && (
                      <div className="mt-2">
                        <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Flat Package Total ({currency})</label>
                        <input type="number" min="0" step="any" value={flatPackageTotal || ''} onChange={e => setFlatPackageTotal(Number(e.target.value))} className={`${inputClass} font-mono`} />
                      </div>
                    )}
                  </div>

                  {/* Discount */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Discount (Optional)</label>
                    <div className="flex gap-2">
                      <select value={discountType} onChange={e => setDiscountType(e.target.value as 'none' | 'percentage' | 'fixed')} className={smallInputClass}>
                        <option value="none">No Discount</option>
                        <option value="percentage">Percentage (%)</option>
                        <option value="fixed">Fixed Amount (RM)</option>
                      </select>
                      {discountType !== 'none' && (
                        <input type="number" min="0" step="any" value={discountValue || ''} onChange={e => setDiscountValue(Number(e.target.value))}
                          placeholder={discountType === 'percentage' ? 'e.g. 10' : 'e.g. 50'} className={`flex-1 ${smallInputClass}`} />
                      )}
                    </div>
                  </div>

                  {/* Extra charges */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">Other Catering Charges</label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" checked={includeExtraCharge} onChange={e => setIncludeExtraCharge(e.target.checked)} className="accent-indigo-600 cursor-pointer" />
                        <span className="text-[10px] font-semibold text-gray-500 dark:text-slate-400">Include in quotation</span>
                      </label>
                    </div>
                    {includeExtraCharge && (
                      <div className="space-y-2">
                        {extraCharges.map((charge, idx) => (
                          <div key={idx} className="flex flex-wrap gap-1.5 items-center">
                            <select
                              value={['Delivery', 'Service', 'Packaging'].includes(charge.label) ? charge.label : 'Custom'}
                              onChange={e => {
                                const val = e.target.value;
                                setExtraCharges(prev => prev.map((c, i) => i === idx ? { ...c, label: val === 'Custom' ? '' : val } : c));
                              }}
                              className={smallInputClass}
                            >
                              <option value="Delivery">Delivery</option>
                              <option value="Service">Service</option>
                              <option value="Packaging">Packaging</option>
                              <option value="Custom">Custom…</option>
                            </select>
                            {!['Delivery', 'Service', 'Packaging'].includes(charge.label) && (
                              <input type="text" placeholder="Label" value={charge.label}
                                onChange={e => setExtraCharges(prev => prev.map((c, i) => i === idx ? { ...c, label: e.target.value } : c))}
                                className={`w-28 ${smallInputClass}`} />
                            )}
                            <input type="number" min="0" step="any" value={charge.amount}
                              onChange={e => setExtraCharges(prev => prev.map((c, i) => i === idx ? { ...c, amount: Number(e.target.value) } : c))}
                              placeholder="0" className={`w-20 font-mono ${smallInputClass}`} />
                            <span className={`text-[10px] font-bold ${charge.amount === 0 ? 'text-emerald-600' : 'text-gray-400 dark:text-slate-500'}`}>
                              {charge.amount === 0 ? 'FREE' : `${currency} ${charge.amount.toFixed(2)}`}
                            </span>
                            {extraCharges.length > 1 && (
                              <button type="button" onClick={() => setExtraCharges(prev => prev.filter((_, i) => i !== idx))}
                                className="text-rose-400 hover:text-rose-600 cursor-pointer p-0.5 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        ))}
                        <button type="button" onClick={() => setExtraCharges(prev => [...prev, { label: 'Delivery', amount: 0 }])}
                          className={`flex items-center gap-1 text-[10px] font-bold cursor-pointer hover:underline ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>
                          <Plus className="w-3 h-3" /> Add another charge
                        </button>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Catering Terms & Conditions</label>
                    <textarea value={cateringTerms} onChange={e => setCateringTerms(e.target.value)} rows={3} className={`${inputClass} resize-none`} />
                  </div>

                  {!editingQuotation && (
                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <input type="checkbox" checked={saveCustomer} onChange={e => setSaveCustomer(e.target.checked)} className="mt-0.5 accent-indigo-600" />
                      <div>
                        <span className="text-xs font-semibold text-gray-800 dark:text-slate-200 block">Save customer to database</span>
                        <span className="text-[10px] text-gray-400 dark:text-slate-500">Adds this customer to your Sheets profile list.</span>
                      </div>
                    </label>
                  )}
                </div>

                {/* Right: day containers */}
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">Event Dates *</label>
                    <button type="button" onClick={addDay}
                      className="flex items-center gap-1 text-[10px] font-bold cursor-pointer hover:underline text-indigo-500 dark:text-indigo-400">
                      <CalendarPlus className="w-3.5 h-3.5" /> Add Event Date
                    </button>
                  </div>

                  <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
                    {days.length === 0 && (
                      <p className={`text-[11px] text-center py-6 rounded-xl border ${isDarkMode ? 'border-slate-700 text-slate-500' : 'border-gray-200 text-gray-400'}`}>
                        No event dates yet — click "Add Event Date" to start building the schedule.
                      </p>
                    )}
                    {days.map((day, dIdx) => {
                      const dayTotal = day.sessions.reduce((s, sess) => s + sess.items.reduce((s2, it) => s2 + it.Quantity * it.Price, 0), 0);
                      return (
                        <div key={day.Day_ID} className={`rounded-xl border p-3 space-y-2.5 ${isDarkMode ? 'border-slate-700 bg-slate-950' : 'border-gray-200 bg-gray-50'}`}>
                          <div className="flex items-center justify-between">
                            <span className={`text-[10px] font-bold uppercase tracking-wider ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>Day {dIdx + 1}</span>
                            <button type="button" onClick={() => removeDay(day.Day_ID)} className="text-rose-400 hover:text-rose-600 cursor-pointer p-0.5 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <input type="date" value={day.Event_Date} onChange={e => updateDay(day.Day_ID, { Event_Date: e.target.value })} className={`w-full ${isDarkMode ? '[color-scheme:dark]' : '[color-scheme:light]'} ${smallInputClass}`} required />
                            <input type="number" min="0" placeholder="Pax" value={day.Pax || ''} onChange={e => updateDay(day.Day_ID, { Pax: Number(e.target.value) })} className={`font-mono ${smallInputClass}`} />
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <select value={day.Serving_Style} onChange={e => updateDay(day.Day_ID, { Serving_Style: e.target.value as ServingStyle })} className={smallInputClass}>
                              {SERVING_STYLES.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                            {pricingMode === 'package' && packageSubMode === 'per_day' && (
                              <input type="number" min="0" step="any" placeholder={`Day Rate (${currency})`}
                                value={day.Day_Package_Rate || ''} onChange={e => updateDay(day.Day_ID, { Day_Package_Rate: Number(e.target.value) })}
                                className={`font-mono ${smallInputClass}`} />
                            )}
                          </div>

                          {/* Sessions — a day can have Breakfast, Lunch, Dinner etc. each with its own menu */}
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <p className={`text-[9px] font-bold uppercase tracking-wider ${isDarkMode ? 'text-slate-500' : 'text-gray-400'}`}>Sessions / Sittings</p>
                              <button type="button" onClick={() => addSession(day.Day_ID)}
                                className={`flex items-center gap-1 text-[9px] font-bold cursor-pointer hover:underline ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}>
                                <Plus className="w-3 h-3" /> Add Session
                              </button>
                            </div>

                            {day.sessions.length === 0 && (
                              <p className={`text-[10px] text-center py-3 rounded-lg border ${isDarkMode ? 'border-slate-800 text-slate-600' : 'border-gray-100 text-gray-400'}`}>
                                No sessions yet — e.g. add "Breakfast", "Lunch", "Dinner" as separate sittings with their own menu.
                              </p>
                            )}

                            {day.sessions.map(session => {
                              const draft = getDraft(session.Session_ID);
                              const sessionTotal = session.items.reduce((s, it) => s + it.Quantity * it.Price, 0);
                              return (
                                <div key={session.Session_ID} className={`rounded-lg border p-2 space-y-1.5 ${isDarkMode ? 'border-slate-800 bg-slate-900' : 'border-gray-100 bg-white'}`}>
                                  <div className="flex items-center gap-1.5">
                                    <input type="text" placeholder="Session e.g. Breakfast" value={session.Session_Label}
                                      onChange={e => updateSession(day.Day_ID, session.Session_ID, { Session_Label: e.target.value })}
                                      className={`flex-1 min-w-0 ${smallInputClass}`} />
                                    <input type="text" placeholder="Time e.g. 7:30 AM" value={session.Session_Time}
                                      onChange={e => updateSession(day.Day_ID, session.Session_ID, { Session_Time: e.target.value })}
                                      className={`w-28 ${smallInputClass}`} />
                                    <button type="button" onClick={() => removeSession(day.Day_ID, session.Session_ID)}
                                      className="text-rose-400 hover:text-rose-600 cursor-pointer p-0.5 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30 shrink-0">
                                      <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                  </div>

                                  {/* Items within this session */}
                                  {session.items.map(item => (
                                    <div key={item.Item_ID} className="flex items-center gap-1.5">
                                      <input type="text" value={item.Item_Name} placeholder="Item name"
                                        onChange={e => updateItemInSession(day.Day_ID, session.Session_ID, item.Item_ID, { Item_Name: e.target.value })}
                                        className={`flex-1 min-w-0 ${smallInputClass}`} />
                                      <input type="number" min="0" value={item.Quantity || ''} placeholder="Qty"
                                        onChange={e => updateItemInSession(day.Day_ID, session.Session_ID, item.Item_ID, { Quantity: Number(e.target.value) })}
                                        className={`w-14 text-center font-mono ${smallInputClass}`} />
                                      {pricingMode === 'itemized' && (
                                        <input type="number" min="0" step="any" value={item.Price || ''} placeholder="Price"
                                          onChange={e => updateItemInSession(day.Day_ID, session.Session_ID, item.Item_ID, { Price: Number(e.target.value) })}
                                          className={`w-20 text-right font-mono ${smallInputClass}`} />
                                      )}
                                      {pricingMode === 'itemized' && (
                                        <span className={`w-20 text-right text-[11px] font-mono font-bold shrink-0 ${isDarkMode ? 'text-slate-200' : 'text-gray-800'}`}>
                                          {(item.Quantity * item.Price).toFixed(2)}
                                        </span>
                                      )}
                                      <button type="button" onClick={() => removeItemFromSession(day.Day_ID, session.Session_ID, item.Item_ID)}
                                        className="text-rose-400 hover:text-rose-600 cursor-pointer p-0.5 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30 shrink-0">
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ))}
                                  <div className="flex items-center gap-1.5">
                                    <input type="text" placeholder="Add menu item…" value={draft.name}
                                      onChange={e => setDraft(session.Session_ID, { name: e.target.value })}
                                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addItemToSession(day.Day_ID, session.Session_ID); } }}
                                      className={`flex-1 min-w-0 ${smallInputClass}`} />
                                    <input type="number" min="0" placeholder="Qty" value={draft.qty || ''}
                                      onChange={e => setDraft(session.Session_ID, { qty: Number(e.target.value) })}
                                      className={`w-14 text-center font-mono ${smallInputClass}`} />
                                    {pricingMode === 'itemized' && (
                                      <input type="number" min="0" step="any" placeholder="Price" value={draft.price || ''}
                                        onChange={e => setDraft(session.Session_ID, { price: Number(e.target.value) })}
                                        className={`w-20 text-right font-mono ${smallInputClass}`} />
                                    )}
                                    <button type="button" onClick={() => addItemToSession(day.Day_ID, session.Session_ID)}
                                      className="shrink-0 w-7 h-7 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center cursor-pointer">
                                      <Plus className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                  {pricingMode === 'itemized' && session.items.length > 0 && (
                                    <p className="text-right text-[9px] font-bold text-gray-500 dark:text-slate-400">Session Subtotal: {currency} {sessionTotal.toFixed(2)}</p>
                                  )}
                                </div>
                              );
                            })}
                          </div>

                          {pricingMode === 'itemized' && dayTotal > 0 && (
                            <p className="text-right text-[10px] font-bold text-gray-500 dark:text-slate-400">Day Subtotal: {currency} {dayTotal.toFixed(2)}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Grand total */}
                  <div className={`flex flex-col gap-1 p-3 rounded-xl mt-auto ${isDarkMode ? 'bg-slate-950 border border-slate-800' : 'bg-gray-50 border border-gray-200'}`}>
                    {liveTotals.chargesTotal > 0 && (
                      <div className="flex items-center justify-between text-[10px] text-gray-500 dark:text-slate-400">
                        <span>Extra Charges</span><span className="font-mono">{currency} {liveTotals.chargesTotal.toFixed(2)}</span>
                      </div>
                    )}
                    {liveTotals.discountAmt > 0 && (
                      <div className="flex items-center justify-between text-[10px] text-amber-600 dark:text-amber-400">
                        <span>Discount</span><span className="font-mono">-{currency} {liveTotals.discountAmt.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wider">Grand Total</span>
                      <span className="text-xl font-black text-gray-900 dark:text-white font-mono">{currency} {liveTotals.total.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className={`flex items-center justify-between gap-2 pt-4 mt-4 border-t ${isDarkMode ? 'border-slate-800' : 'border-gray-100'}`}>
                <div className="flex items-center gap-2">
                  {editingQuotation && (
                    <button type="button" onClick={() => handleDelete(editingQuotation.Quotation_ID)}
                      className="px-4 py-2 text-xs font-bold rounded-xl border cursor-pointer transition-colors bg-rose-50 hover:bg-rose-100 text-rose-600 border-rose-200 dark:bg-rose-950/30 dark:hover:bg-rose-900/40 dark:text-rose-400 dark:border-rose-800">
                      Delete Quotation
                    </button>
                  )}
                  {editingQuotation && (
                    editingQuotation.Converted_Invoice_ID ? (
                      <span className="px-3 py-2 text-xs font-bold rounded-xl bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400">
                        Converted → {editingQuotation.Converted_Invoice_ID}
                      </span>
                    ) : (
                      <button type="button" onClick={() => handleConvertToInvoice(editingQuotation)}
                        className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl border cursor-pointer transition-colors bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:hover:bg-emerald-900/40 dark:text-emerald-400 dark:border-emerald-800">
                        <ArrowRightCircle className="w-3.5 h-3.5" /> Convert to Invoice
                      </button>
                    )
                  )}
                  {editingQuotation && (
                    <button type="button" onClick={() => openKitchenSheet(editingQuotation)}
                      className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-xl border cursor-pointer transition-colors bg-amber-50 hover:bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:hover:bg-amber-900/40 dark:text-amber-400 dark:border-amber-800">
                      <ChefHat className="w-3.5 h-3.5" /> Kitchen Sheet
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setIsModalOpen(false)}
                    className={`px-4 py-2 text-xs font-bold rounded-xl border cursor-pointer transition-colors ${isDarkMode ? 'bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
                    Cancel
                  </button>
                  <button type="submit" disabled={isSyncing}
                    className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-bold text-xs rounded-xl transition-colors cursor-pointer shadow-sm">
                    {isSyncing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                    {isSyncing ? 'Saving…' : (editingQuotation ? 'Update Quotation' : 'Generate & Save')}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Preview modal ──────────────────────────────────────────────────── */}
      {previewData && (
        <QuotationPreviewModal data={previewData} onClose={() => setPreviewData(null)} />
      )}

      {/* ── Kitchen prep sheet modal ──────────────────────────────────────── */}
      {kitchenSheetData && (
        <KitchenSheetModal data={kitchenSheetData} onClose={() => setKitchenSheetData(null)} />
      )}
    </div>
  );
}
