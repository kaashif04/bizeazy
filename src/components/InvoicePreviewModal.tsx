/**
 * InvoicePreviewModal.tsx — Complete file
 * ─────────────────────────────────────────────────────────────
 * FILE: src/components/InvoicePreviewModal.tsx
 *
 * Contains two exports:
 *   1. downloadInvoicePDF()  — jsPDF generator matching the
 *      original deployed app PDF layout exactly (color top bar,
 *      circle monogram, 3-col meta row, autoTable, totals box,
 *      footer text). Drop-in for downloadPremiumPDF().
 *
 *   2. <InvoicePreviewModal> — Full-screen React preview that
 *      renders the invoice in-browser before downloading, styled
 *      identically to the PDF layout.
 *
 * HOW TO ADD TO App.tsx — 5 steps:
 * ─────────────────────────────────────────────────────────────
 * STEP 1  Add import (top of App.tsx):
 *   import { InvoicePreviewModal, downloadInvoicePDF } from './components/InvoicePreviewModal';
 *
 * STEP 2  Add state (near other modal states in App.tsx):
 *   const [previewModalId, setPreviewModalId] = useState<string | null>(null);
 *
 * STEP 3  Replace every downloadPremiumPDF(id) call with:
 *   downloadInvoicePDF(id, db, profiles, customStyles, currentCurrencySymbol)
 *
 * STEP 4  Wire preview (eye-icon) buttons to:
 *   setPreviewModalId(invoiceId)
 *
 * STEP 5  Add modal JSX before closing </div> of App return:
 *   {previewModalId && (
 *     <InvoicePreviewModal
 *       invoiceId={previewModalId}
 *       db={db}
 *       profiles={profiles}
 *       customStyles={customStyles}
 *       onClose={() => setPreviewModalId(null)}
 *     />
 *   )}
 * ─────────────────────────────────────────────────────────────
 */

import React from 'react';
import { X } from 'lucide-react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  Invoice, InvoiceItem, CompanyProfile,
  TemplateCustomization, DatabaseState
} from '../types';

declare module 'jspdf' {
  interface jsPDF { lastAutoTable: { finalY: number }; }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const hexToRgb = (hex: string): [number, number, number] => {
  const clean = (hex || '').replace('#', '');
  if (clean.length < 6) return [180, 83, 9];
  return [
    parseInt(clean.slice(0, 2), 16) || 30,
    parseInt(clean.slice(2, 4), 16) || 140,
    parseInt(clean.slice(4, 6), 16) || 120,
  ];
};

const getOutletConfig = (invoice: Invoice, profiles: CompanyProfile[]) => {
  return profiles.find(p => p.id === invoice.Company) || null;
};

const drawMonogram = (
  doc: jsPDF,
  storeName: string,
  themeColor: [number, number, number],
  text?: string
) => {
  doc.setFillColor(...themeColor);
  doc.circle(26, 24, 11, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(11);
  const label = text
    ? text.substring(0, 3).toUpperCase()
    : storeName.split(' ').map((w: string) => w[0]).join('').substring(0, 3).toUpperCase();
  doc.text(label, 26, 28, { align: 'center' });
};

// ─────────────────────────────────────────────────────────────
// PDF GENERATOR — matches original deployed app layout exactly
// ─────────────────────────────────────────────────────────────
export const downloadInvoicePDF = (
  invoiceId: string,
  db: DatabaseState,
  profiles: CompanyProfile[],
  customStyles?: TemplateCustomization,
  fallbackCurrency = 'RM'
): void => {
  const invoice = db.invoices.find(i => i.Invoice_ID === invoiceId);
  if (!invoice) { console.error('Invoice not found:', invoiceId); return; }

  const subItems = db.invoice_items.filter(i => i.Invoice_ID === invoiceId);
  const profile  = getOutletConfig(invoice, profiles);
  const isBistro = invoice.Company === 'Bistro';

  const outletCfg = {
    store_name:      profile?.store_name || profile?.name || (isBistro ? 'La Bistro Cafe' : 'Nasi Kandar Heritage'),
    company_name:    profile?.company_name || '',
    subtitle:        profile?.subtitle    || (isBistro ? 'Gourmet Western & Artisan Brews' : 'Traditional Penang Curry & Street Spices'),
    address:         profile?.address     || (isBistro ? '100-B, Macalister Road, Georgetown' : '45-C, Chulia Street, Georgetown'),
    email:           profile?.email       || 'accounts@culinaryholding.com',
    phone:           profile?.phone       || (isBistro ? '+60 4-234 5678' : '+60 4-876 5432'),
    currency_symbol: profile?.currency_symbol || invoice.Currency_Symbol || fallbackCurrency,
    footer_text:     customStyles?.terms_footer || profile?.footer_text ||
                     (isBistro ? 'Thank you for dining with us! Payment is due within 3 days.'
                               : 'Please settle invoice balance to secure order.'),
    logo_url:        profile?.logo_url     || '',
    payment_info:    profile?.payment_info || '',
  };

  const themeColor: [number, number, number] = customStyles?.primary_color
    ? hexToRgb(customStyles.primary_color)
    : (isBistro ? [180, 83, 9] : [6, 95, 70]);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Top color bar
  doc.setFillColor(...themeColor);
  doc.rect(0, 0, 210, 8, 'F');

  // Logo / monogram
  let textLeftOffset = 14;
  const logoUrl = (outletCfg.logo_url || '').trim();

  if (logoUrl) {
    try {
      const ext = logoUrl.includes('data:image/png') || logoUrl.endsWith('.png') ? 'PNG' : 'JPEG';
      doc.addImage(logoUrl, ext, 14, 12, 24, 24);
      textLeftOffset = 42;
    } catch (_) {
      drawMonogram(doc, outletCfg.store_name, themeColor);
      textLeftOffset = 42;
    }
  } else {
    drawMonogram(doc, outletCfg.store_name, themeColor);
    textLeftOffset = 42;
  }

  // Company name
  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(31, 41, 55);
  doc.text(outletCfg.store_name, textLeftOffset, 22);

  if (outletCfg.company_name) {
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text(outletCfg.company_name.toUpperCase(), textLeftOffset, 27);
  }

  doc.setFont('Helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(107, 114, 128);
  const addressLine = [outletCfg.subtitle, outletCfg.address].filter(Boolean).join(' | ');
  const splitAddr   = doc.splitTextToSize(addressLine, 120);
  const addrBaseY   = outletCfg.company_name ? 32 : 28;
  doc.text(splitAddr, textLeftOffset, addrBaseY);
  const contactLineY = addrBaseY + splitAddr.length * 3.5;
  if (outletCfg.phone || outletCfg.email) {
    doc.text(`Contact: ${outletCfg.phone}  |  ${outletCfg.email}`, textLeftOffset, contactLineY);
  }

  // Right: INVOICE title
  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(...themeColor);
  doc.text('INVOICE', 196, 22, { align: 'right' });

  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(31, 41, 55);
  doc.text(`Invoice ID: ${invoice.Invoice_ID}`, 196, 28, { align: 'right' });

  // Divider
  doc.setDrawColor(229, 231, 235);
  doc.setLineWidth(0.4);
  doc.line(14, 42, 196, 42);

  // 3-column metadata
  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(107, 114, 128);
  doc.text('DATE OF ISSUE',    14,  50);
  doc.text('OUTLET / ORIGIN',  65,  50);
  doc.text('BILL TO (PATRON)', 120, 50);

  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(31, 41, 55);
  doc.text(invoice.Date ? invoice.Date.toString().split('T')[0] : '-', 14, 55);
  doc.text(outletCfg.store_name, 65, 55);
  doc.text(invoice.Customer_Name, 120, 55);

  const matchingCust = db.customers.find(
    c => (c.Customer_Name || '').toLowerCase() === (invoice.Customer_Name || '').toLowerCase()
  );
  const contactVal = (invoice.Customer_Contact && invoice.Customer_Contact !== '-')
    ? invoice.Customer_Contact
    : (matchingCust?.Contact || 'No contact recorded');

  doc.setFont('Helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(75, 85, 99);
  doc.text(`Contact: ${contactVal}`, 120, 60);

  if (invoice.Customer_Address && invoice.Customer_Address !== '-') {
    const addrSplit = doc.splitTextToSize(invoice.Customer_Address, 70);
    doc.text(addrSplit, 120, 64.5);
  }

  // Items table
  const currency    = outletCfg.currency_symbol;
  const tableHeaders = [[
    'ID',
    'Description of Item or Service',
    'Qty',
    `Unit Price (${currency})`,
    `Subtotal (${currency})`
  ]];

  const tableRows = subItems.length > 0
    ? subItems.map((item, idx) => [
        String(idx + 1),
        String(item.Item_Name || ''),
        String(item.Quantity ?? ''),
        (Number(item.Price)    || 0).toFixed(2),
        (Number(item.Subtotal) || 0).toFixed(2),
      ])
    : [['—', 'No itemised line records', '', '', (Number(invoice.Total_Amount) || 0).toFixed(2)]];

  autoTable(doc, {
    startY: 70,
    head: tableHeaders,
    body: tableRows,
    theme: 'striped',
    headStyles: {
      fillColor: themeColor,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 9,
      halign: 'left',
    },
    columnStyles: {
      0: { cellWidth: 10 },
      1: { cellWidth: 100 },
      2: { cellWidth: 15, halign: 'center' },
      3: { cellWidth: 30, halign: 'right' },
      4: { cellWidth: 27, halign: 'right' },
    },
    styles: { fontSize: 8.5, font: 'Helvetica', cellPadding: 3 },
    margin: { left: 14, right: 14 },
  });

  let finalY = (doc as any).lastAutoTable.finalY + 8;
  if (finalY > 250) { doc.addPage(); finalY = 20; }

  // Totals box
  doc.setFillColor(249, 250, 251);
  doc.rect(130, finalY, 66, 24, 'F');
  doc.setDrawColor(229, 231, 235);
  doc.rect(130, finalY, 66, 24, 'S');

  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(107, 114, 128);
  doc.text('Subtotal Amount:', 135, finalY + 8);
  doc.text('Grand Total:',     135, finalY + 17);

  doc.setFont('Helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(75, 85, 99);
  doc.text(
    `${currency} ${(Number(invoice.Subtotal_Amount) || Number(invoice.Total_Amount) || 0).toFixed(2)}`,
    191, finalY + 8, { align: 'right' }
  );

  doc.setFont('Helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...themeColor);
  doc.text(
    `${currency} ${(Number(invoice.Total_Amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    191, finalY + 17, { align: 'right' }
  );

  // Payment info left of totals
  if (outletCfg.payment_info) {
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text('REMITTANCE INSTRUCTIONS', 14, finalY + 5);
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(17, 24, 39);
    doc.text(outletCfg.payment_info, 14, finalY + 11);
  }

  if (invoice.Notes?.trim()) {
    const noteY = outletCfg.payment_info ? finalY + 18 : finalY + 5;
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(107, 114, 128);
    doc.text('REMARKS', 14, noteY);
    doc.setFont('Helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(75, 85, 99);
    const noteSplit = doc.splitTextToSize(invoice.Notes, 110);
    doc.text(noteSplit, 14, noteY + 5);
  }

  // Footer
  const footerY = finalY + 38;
  doc.setFont('Helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(107, 114, 128);
  const footerSplit = doc.splitTextToSize(outletCfg.footer_text, 182);
  doc.text(footerSplit, 14, footerY);

  doc.setFont('Helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(156, 163, 175);
  doc.text('GENERATED SECURELY BY BIZEAZYINVOICING', 14, footerY + footerSplit.length * 3.5 + 2);

  doc.save(`INVOICE_${invoice.Invoice_ID}_${invoice.Customer_Name.replace(/\s+/g, '_')}.pdf`);
};

// ─────────────────────────────────────────────────────────────
// REACT IN-APP PREVIEW MODAL
// ─────────────────────────────────────────────────────────────
interface InvoicePreviewModalProps {
  invoiceId: string | null;
  db: DatabaseState;
  profiles: CompanyProfile[];
  customStyles?: TemplateCustomization;
  onClose: () => void;
  onDownload: (id: string) => void;
}

export const InvoicePreviewModal: React.FC<InvoicePreviewModalProps> = ({
  invoiceId, db, profiles, customStyles, onClose, onDownload,
}) => {
  if (!invoiceId) return null;

  const invoice = db.invoices.find(i => i.Invoice_ID === invoiceId);
  if (!invoice) return null;

  const items    = db.invoice_items.filter(i => i.Invoice_ID === invoiceId);
  const profile  = getOutletConfig(invoice, profiles);
  const isBistro = invoice.Company === 'Bistro';

  const outletCfg = {
    store_name:   profile?.store_name    || profile?.name || (isBistro ? 'La Bistro Cafe' : 'Nasi Kandar Heritage'),
    company_name: profile?.company_name  || '',
    subtitle:     profile?.subtitle      || (isBistro ? 'Gourmet Western & Artisan Brews' : 'Traditional Penang Curry & Street Spices'),
    address:      profile?.address       || '',
    email:        profile?.email         || '',
    phone:        profile?.phone         || '',
    currency:     profile?.currency_symbol || invoice.Currency_Symbol || 'RM',
    footer_text:  customStyles?.terms_footer || profile?.footer_text || `Thank you for choosing ${profile?.name || invoice.Company}!`,
    logo_url:     profile?.logo_url      || '',
    payment_info: profile?.payment_info  || '',
  };

  const accent   = customStyles?.primary_color || (isBistro ? '#B45309' : '#065F46');
  const fmt      = (n: number) => `${outletCfg.currency} ${Number(n).toFixed(2)}`;
  const subtotal = invoice.Subtotal_Amount ?? invoice.Total_Amount;

  const matchingCust = db.customers.find(
    c => (c.Customer_Name || '').toLowerCase() === (invoice.Customer_Name || '').toLowerCase()
  );
  const contactVal = (invoice.Customer_Contact && invoice.Customer_Contact !== '-')
    ? invoice.Customer_Contact
    : (matchingCust?.Contact || '');

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-8 px-4"
      onClick={onClose}
    >
      {/* Floating toolbar */}
      <div
        className="fixed top-4 right-4 z-[70] flex items-center gap-2"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={() => onDownload(invoiceId)}
          className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-black rounded-xl shadow-xl transition-all cursor-pointer"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
              d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Download PDF
        </button>
        <button
          onClick={onClose}
          className="w-9 h-9 flex items-center justify-center bg-white/10 hover:bg-white/20 text-white rounded-xl border border-white/20 transition-all cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* A4 Preview Card */}
      <div
        className="w-full max-w-[800px] bg-white rounded-xl shadow-2xl overflow-hidden mt-14 mb-8"
        style={{ fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Color top bar */}
        <div className="h-2 w-full" style={{ backgroundColor: accent }} />

        <div className="px-10 pt-8 pb-2">

          {/* Header row */}
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-4">
              {outletCfg.logo_url ? (
                <img
                  src={outletCfg.logo_url}
                  alt="logo"
                  className="w-14 h-14 object-contain rounded"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div
                  className="w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-black flex-shrink-0"
                  style={{ backgroundColor: accent }}
                >
                  {outletCfg.store_name.split(' ').map((w: string) => w[0]).join('').substring(0, 3).toUpperCase()}
                </div>
              )}
              <div>
                {outletCfg.company_name && (
                  <p className="text-[9px] font-bold uppercase tracking-widest mb-0.5" style={{ color: accent }}>
                    {outletCfg.company_name}
                  </p>
                )}
                <h2 className="text-2xl font-black text-slate-900 leading-tight">{outletCfg.store_name}</h2>
                <p className="text-[10px] text-slate-500 leading-snug mt-0.5 max-w-xs">
                  {[outletCfg.subtitle, outletCfg.address].filter(Boolean).join(' | ')}
                </p>
                {(outletCfg.phone || outletCfg.email) && (
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    Contact: {[outletCfg.phone, outletCfg.email].filter(Boolean).join('  |  ')}
                  </p>
                )}
              </div>
            </div>

            <div className="text-right flex-shrink-0">
              <p className="text-3xl font-black" style={{ color: accent }}>INVOICE</p>
              <p className="text-sm font-bold text-slate-800 mt-0.5">{invoice.Invoice_ID}</p>
            </div>
          </div>

          {/* Divider */}
          <hr className="border-slate-200 mb-5" />

          {/* 3-column meta */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Date of Issue</p>
              <p className="text-sm font-bold text-slate-800">{invoice.Date?.split('T')[0] || '-'}</p>
            </div>
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Outlet / Origin</p>
              <p className="text-sm font-bold text-slate-800">{outletCfg.store_name}</p>
            </div>
            <div>
              <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Bill To (Patron)</p>
              <p className="text-sm font-bold text-slate-800">{invoice.Customer_Name}</p>
              {contactVal && <p className="text-xs text-slate-500">Contact: {contactVal}</p>}
              {invoice.Customer_Address && invoice.Customer_Address !== '-' && (
                <p className="text-xs text-slate-500 mt-0.5">{invoice.Customer_Address}</p>
              )}
            </div>
          </div>

          {/* Items table */}
          <div className="rounded-xl overflow-hidden border border-slate-200 mb-6">
            <div
              className="grid text-[9px] font-black text-white uppercase tracking-wide px-4 py-3"
              style={{ backgroundColor: accent, gridTemplateColumns: '32px 1fr 44px 80px 80px' }}
            >
              <span>ID</span>
              <span>Description of Item or Service</span>
              <span className="text-center">Qty</span>
              <span className="text-right">Unit Price ({outletCfg.currency})</span>
              <span className="text-right">Subtotal ({outletCfg.currency})</span>
            </div>

            {items.length > 0 ? items.map((item, idx) => (
              <div
                key={item.Item_ID || idx}
                className="grid px-4 py-2.5 text-[11px] border-t border-slate-100"
                style={{
                  gridTemplateColumns: '32px 1fr 44px 80px 80px',
                  backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f9fafb',
                }}
              >
                <span className="text-slate-500 font-bold">{idx + 1}</span>
                <span className="text-slate-800">{item.Item_Name}</span>
                <span className="text-center text-slate-700 font-mono">{item.Quantity}</span>
                <span className="text-right text-slate-700 font-mono">{(Number(item.Price) || 0).toFixed(2)}</span>
                <span className="text-right text-slate-900 font-mono font-bold">{(Number(item.Subtotal) || 0).toFixed(2)}</span>
              </div>
            )) : (
              <div
                className="grid px-4 py-3 text-[11px] border-t border-slate-100 bg-white"
                style={{ gridTemplateColumns: '32px 1fr 44px 80px 80px' }}
              >
                <span className="text-slate-400">—</span>
                <span className="text-slate-400 italic">No itemised line records</span>
                <span />
                <span />
                <span className="text-right font-mono font-bold text-slate-800">
                  {fmt(invoice.Total_Amount)}
                </span>
              </div>
            )}
          </div>

          {/* Bottom: payment info + totals */}
          <div className="flex gap-6 mb-8">
            <div className="flex-1 space-y-3">
              {outletCfg.payment_info && (
                <div>
                  <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">Remittance Instructions</p>
                  <p className="text-sm font-bold text-slate-800">{outletCfg.payment_info}</p>
                </div>
              )}
              {invoice.Notes?.trim() && (
                <div>
                  <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">Remarks</p>
                  <p className="text-xs text-slate-600 leading-relaxed">{invoice.Notes}</p>
                </div>
              )}
            </div>

            <div className="w-56 border border-slate-200 rounded-xl p-4 bg-gray-50 self-start space-y-2 flex-shrink-0">
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Subtotal Amount:</span>
                <span className="font-mono font-bold text-slate-700">{fmt(subtotal)}</span>
              </div>
              {(invoice.Discount_Value ?? 0) > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">Discount:</span>
                  <span className="font-mono font-bold text-red-500">
                    {invoice.Discount_Type === 'percentage'
                      ? `-${invoice.Discount_Value}%`
                      : `-${fmt(invoice.Discount_Value ?? 0)}`}
                  </span>
                </div>
              )}
              <div className="flex justify-between items-center pt-1.5 border-t border-slate-200">
                <span className="text-sm font-black text-slate-900">Grand Total:</span>
                <span className="text-sm font-black font-mono" style={{ color: accent }}>
                  {outletCfg.currency}{' '}
                  {(Number(invoice.Total_Amount) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer band */}
        <div className="border-t border-slate-200 px-10 py-3 bg-gray-50 text-center space-y-0.5">
          <p className="text-[10px] italic text-slate-500">{outletCfg.footer_text}</p>
          <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">
            Generated Securely by BizEazyInvoicing
          </p>
        </div>
      </div>
    </div>
  );
};

export default InvoicePreviewModal;