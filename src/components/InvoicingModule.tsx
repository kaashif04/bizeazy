import React, { useState, useMemo, useCallback } from 'react';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  Plus, Search, Download, FileText, CheckCircle, X, Trash2,
  ShieldAlert, RefreshCw, Edit, Eye,
} from 'lucide-react';
import { DatabaseState, Invoice, InvoiceItem, Customer, CompanyProfile } from '../types';

interface InvoicingModuleProps {
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
  isStaff: boolean;
  onPreviewInvoice?: (invoiceId: string) => void;
  onDownloadPDF?: (invoiceId: string) => void;
  onDeleteInvoice?: (invoiceId: string) => void;
}

interface LineItem {
  name: string;
  qty: number;
  price: number;
}

// ─── Invoice ID generator ─────────────────────────────────────────────────────
function generateInvoiceId(
  outlet: 'Bistro' | 'Nasi Kandar',
  profiles: CompanyProfile[],
  existingInvoices: Invoice[],
): string {
  const profile = profiles.find(p => p.id === outlet);
  const prefix = profile?.series_format || (outlet === 'Bistro' ? 'BIS-26-' : 'NK-26-');
  let maxIndex = 0;
  existingInvoices.forEach(inv => {
    if (inv.Invoice_ID?.startsWith(prefix)) {
      const n = parseInt(inv.Invoice_ID.substring(prefix.length), 10);
      if (!isNaN(n) && n > maxIndex) maxIndex = n;
    }
  });
  return prefix + String(maxIndex + 1).padStart(4, '0');
}

// ─── jsPDF generation — matches AI Studio quality ────────────────────────────
function generatePDF(invoice: Invoice, items: InvoiceItem[], profile: CompanyProfile) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const isBistro = invoice.Company === 'Bistro';
  const themeRGB: [number, number, number] = isBistro ? [180, 83, 9] : [6, 95, 70];
  const currency   = profile.currency_symbol || 'RM';
  const storeName  = profile.store_name || profile.name;
  const corpName   = (profile.company_name || '').toUpperCase();

  // ── HEADER: logo + company names (left) | address + contact (right) ─────────
  let logoLoaded = false;
  const logoUrl = (profile.logo_url || '').trim();
  if (logoUrl.startsWith('data:image')) {
    const fmt = logoUrl.includes('image/png') ? 'PNG' : 'JPEG';
    try { doc.addImage(logoUrl, fmt, 14, 10, 22, 22); logoLoaded = true; } catch {}
  } else if (logoUrl.startsWith('http')) {
    try { doc.addImage(logoUrl, 'PNG', 14, 10, 22, 22); logoLoaded = true; } catch {}
  }
  const nameX = logoLoaded ? 40 : 14;

  if (corpName) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(107, 114, 128);
    doc.text(corpName, nameX, 15);
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(corpName ? 17 : 19);
  doc.setTextColor(17, 24, 39);
  doc.text(storeName, nameX, corpName ? 23 : 20);

  // Right column: address + contact
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(75, 85, 99);
  if (profile.address) {
    const addrLines = doc.splitTextToSize(profile.address, 90);
    doc.text(addrLines, 196, 13, { align: 'right' });
  }
  const contactStr = [profile.phone, profile.email].filter(Boolean).join(' | ');
  if (contactStr) doc.text(`Contact: ${contactStr}`, 196, profile.address ? 22 : 13, { align: 'right' });

  // ── DIVIDER ─────────────────────────────────────────────────────────────────
  doc.setDrawColor(209, 213, 219);
  doc.setLineWidth(0.5);
  doc.line(14, 33, 196, 33);

  // ── INVOICE METADATA BOX ────────────────────────────────────────────────────
  let y = 41;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(156, 163, 175);
  doc.text('INVOICE CODE ID', 14, y);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(17, 24, 39);
  doc.text(invoice.Invoice_ID, 14, y + 8);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(156, 163, 175);
  doc.text('ISSUED STAMP', 14, y + 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(17, 24, 39);
  doc.text(invoice.Date || '', 14, y + 19);

  // Status badge (right)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(156, 163, 175);
  doc.text('STATUS SUMMARY', 138, y);

  const isPaid = invoice.Status === 'Paid';
  const badgeClr: [number, number, number] = isPaid ? [5, 150, 105] : [217, 119, 6];
  doc.setFillColor(...badgeClr);
  doc.roundedRect(138, y + 3, 34, 9, 1.5, 1.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  doc.text(invoice.Status.toUpperCase(), 155, y + 9, { align: 'center' });

  // ── DIVIDER ─────────────────────────────────────────────────────────────────
  y += 27;
  doc.setDrawColor(209, 213, 219);
  doc.line(14, y, 196, y);
  y += 7;

  // ── BILL TO block ───────────────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(156, 163, 175);
  doc.text('BILL TO REGISTERED CUSTOMER', 14, y);
  y += 5;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(17, 24, 39);
  doc.text(invoice.Customer_Name, 14, y);
  y += 5;

  if (invoice.Customer_Contact && invoice.Customer_Contact !== '-') {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(75, 85, 99);
    doc.text(`Mobile / Email: ${invoice.Customer_Contact}`, 14, y);
    y += 5;
  }

  if (invoice.Customer_Address && invoice.Customer_Address !== '-') {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text('PHYSICAL LOCATION ADDRESS:', 14, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(75, 85, 99);
    const addrLines = doc.splitTextToSize(invoice.Customer_Address, 120);
    doc.text(addrLines, 14, y);
    y += addrLines.length * 4.5;
  }

  y += 3;
  doc.setDrawColor(209, 213, 219);
  doc.line(14, y, 196, y);
  y += 6;

  // ── ITEMS TABLE ─────────────────────────────────────────────────────────────
  const tableRows = items.map((item, idx) => [
    String(idx + 1),
    item.Item_Name || '',
    `${currency} ${Number(item.Price).toFixed(2)}`,
    String(item.Quantity),
    `${currency} ${Number(item.Subtotal).toFixed(2)}`,
  ]);
  if (tableRows.length === 0) {
    tableRows.push(['—', 'No itemised line records', '', '', `${currency} ${Number(invoice.Total_Amount).toFixed(2)}`]);
  }

  autoTable(doc, {
    startY: y,
    head: [['#', 'ITEM DESCRIPTION', `UNIT PRICE`, 'QTY', 'SUBTOTAL']],
    body: tableRows,
    theme: 'grid',
    headStyles: { fillColor: themeRGB, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
    columnStyles: {
      0: { cellWidth: 10, halign: 'center' },
      1: { cellWidth: 88 },
      2: { cellWidth: 34, halign: 'right' },
      3: { cellWidth: 18, halign: 'center' },
      4: { cellWidth: 32, halign: 'right' },
    },
    styles: { fontSize: 9, cellPadding: 3.5 },
    margin: { left: 14, right: 14 },
  });

  const tableEnd: number = (doc as any).lastAutoTable.finalY + 8;

  // ── REMITTANCE (left) + TOTALS BOX (right) ────────────────────────────────
  const hasRemittance = !!(profile as any).payment_info;
  if (hasRemittance) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text('REMITTANCE INSTRUCTIONS', 14, tableEnd);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(17, 24, 39);
    const remitLines = doc.splitTextToSize((profile as any).payment_info, 85);
    doc.text(remitLines, 14, tableEnd + 6);
  }

  const subtotal = Number(invoice.Subtotal_Amount) || Number(invoice.Total_Amount);
  const boxX = 120, boxY = tableEnd - 2;
  doc.setDrawColor(209, 213, 219);
  doc.setLineWidth(0.3);
  doc.rect(boxX, boxY, 76, 26);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  doc.text('Subtotal Amount:', boxX + 4, boxY + 8);
  doc.setTextColor(17, 24, 39);
  doc.text(`${currency} ${subtotal.toFixed(2)}`, 192, boxY + 8, { align: 'right' });

  doc.setDrawColor(209, 213, 219);
  doc.line(boxX, boxY + 13, boxX + 76, boxY + 13);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...themeRGB);
  doc.text('Grand Total:', boxX + 4, boxY + 21);
  doc.text(
    `${currency} ${Number(invoice.Total_Amount).toLocaleString('en-MY', { minimumFractionDigits: 2 })}`,
    192, boxY + 21, { align: 'right' },
  );

  // ── FOOTER ───────────────────────────────────────────────────────────────────
  const footerY = 276;
  doc.setDrawColor(209, 213, 219);
  doc.setLineWidth(0.4);
  doc.line(14, footerY - 5, 196, footerY - 5);

  if (profile.footer_text) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(75, 85, 99);
    const ftLines = doc.splitTextToSize(profile.footer_text, 170);
    doc.text(ftLines, 105, footerY, { align: 'center' });
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(156, 163, 175);
  doc.text('GENERATED SECURELY BY BIZEAZYINVOICING', 105, footerY + 6, { align: 'center' });

  doc.save(`INVOICE_${invoice.Invoice_ID}_${invoice.Customer_Name.replace(/\s+/g, '_')}.pdf`);
}

// ─── Invoice Preview Modal ────────────────────────────────────────────────────
interface PreviewState {
  invoice: Invoice;
  items: InvoiceItem[];
  profile: CompanyProfile;
}

function InvoicePreviewModal({
  invoice, items, profile, onClose, onDownload,
}: PreviewState & { onClose: () => void; onDownload: () => void }) {
  const isBistro    = invoice.Company === 'Bistro';
  const themeHeader = isBistro ? 'bg-[#b45309] text-white' : 'bg-[#065f46] text-white';
  const themeTotal  = isBistro ? 'text-amber-700' : 'text-emerald-700';
  const currency    = profile.currency_symbol || 'RM';
  const storeName   = profile.store_name || profile.name;
  const subtotal    = Number(invoice.Subtotal_Amount) || Number(invoice.Total_Amount);
  const paymentInfo = (profile as any).payment_info as string | undefined;

  return (
    <div className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex flex-col items-center overflow-y-auto py-4 px-4">
      {/* Sticky action bar */}
      <div className="w-full max-w-3xl sticky top-0 z-10 bg-gray-900 rounded-t-xl flex items-center justify-between px-5 py-3 shadow-xl flex-shrink-0">
        <div className="flex items-center gap-2 text-white min-w-0">
          <FileText className="w-4 h-4 text-indigo-400 flex-shrink-0" />
          <span className="text-sm font-bold truncate">Invoice Preview — {invoice.Invoice_ID}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={onDownload}
            className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold px-4 py-2 rounded-lg cursor-pointer transition-colors shadow-sm"
          >
            <Download className="w-3.5 h-3.5" />
            Download PDF
          </button>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-white cursor-pointer rounded-lg hover:bg-gray-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Invoice paper */}
      <div className="w-full max-w-3xl bg-white shadow-2xl rounded-b-xl text-gray-900 flex-shrink-0" style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
        <div className="p-10">

          {/* ── Header ─────────────────────────────────────────────────── */}
          <div className="flex justify-between items-start mb-6 gap-4">
            <div className="flex items-start gap-4 min-w-0">
              {profile.logo_url && (
                <img
                  src={profile.logo_url}
                  alt="Logo"
                  className="w-16 h-16 object-contain flex-shrink-0"
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
              )}
              <div className="min-w-0">
                {profile.company_name && (
                  <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{profile.company_name}</p>
                )}
                <h1 className="text-3xl font-black tracking-tight text-gray-900 leading-tight">{storeName}</h1>
              </div>
            </div>
            <div className="text-right text-sm text-gray-500 max-w-[250px] flex-shrink-0">
              {profile.address && <p className="leading-snug">{profile.address}</p>}
              {(profile.phone || profile.email) && (
                <p className="mt-1 text-xs">Contact: {[profile.phone, profile.email].filter(Boolean).join(' | ')}</p>
              )}
            </div>
          </div>

          <hr className="border-gray-200 mb-6" />

          {/* ── Invoice metadata ────────────────────────────────────────── */}
          <div className="flex justify-between items-start mb-6">
            <div>
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">Invoice Code ID</p>
              <p className="text-4xl font-black tracking-tight mt-0.5">{invoice.Invoice_ID}</p>
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mt-4">Issued Stamp</p>
              <p className="text-sm font-semibold mt-0.5">{invoice.Date}</p>
            </div>
            <div className="text-right">
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">Status Summary</p>
              <span className={`inline-block mt-1.5 px-5 py-1.5 rounded text-xs font-black uppercase text-white ${
                invoice.Status === 'Paid' ? 'bg-emerald-500' : 'bg-amber-500'
              }`}>
                {invoice.Status}
              </span>
            </div>
          </div>

          <hr className="border-gray-200 mb-6" />

          {/* ── Bill To ─────────────────────────────────────────────────── */}
          <div className="mb-6">
            <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mb-2">Bill To Registered Customer</p>
            <p className="text-xl font-bold">{invoice.Customer_Name}</p>
            {invoice.Customer_Contact && invoice.Customer_Contact !== '-' && (
              <p className="text-sm text-gray-600 mt-0.5">Mobile / Email: {invoice.Customer_Contact}</p>
            )}
            {invoice.Customer_Address && invoice.Customer_Address !== '-' && (
              <>
                <p className="text-[9px] font-bold text-gray-400 uppercase tracking-wider mt-3">Physical Location Address:</p>
                <p className="text-sm text-gray-700 mt-0.5">{invoice.Customer_Address}</p>
              </>
            )}
          </div>

          <hr className="border-gray-200 mb-4" />

          {/* ── Items table ─────────────────────────────────────────────── */}
          <table className="w-full mb-6 border-collapse">
            <thead>
              <tr className={themeHeader}>
                <th className="py-3 px-3 text-left text-xs font-bold w-10">#</th>
                <th className="py-3 px-3 text-left text-xs font-bold">ITEM DESCRIPTION</th>
                <th className="py-3 px-3 text-right text-xs font-bold">UNIT PRICE</th>
                <th className="py-3 px-3 text-center text-xs font-bold w-14">QTY</th>
                <th className="py-3 px-3 text-right text-xs font-bold">SUBTOTAL</th>
              </tr>
            </thead>
            <tbody>
              {items.length > 0 ? items.map((item, idx) => (
                <tr key={idx} className={`border-b border-gray-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/70'}`}>
                  <td className="py-3 px-3 text-sm text-center text-gray-400">{idx + 1}</td>
                  <td className="py-3 px-3 text-sm">{item.Item_Name}</td>
                  <td className="py-3 px-3 text-sm text-right font-mono">{currency} {Number(item.Price).toFixed(2)}</td>
                  <td className="py-3 px-3 text-sm text-center">{item.Quantity}</td>
                  <td className="py-3 px-3 text-sm text-right font-mono font-semibold">{currency} {Number(item.Subtotal).toFixed(2)}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-gray-400 italic">
                    No line items loaded — click Refresh Data in the sidebar then re-open this preview.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* ── Remittance + Totals ──────────────────────────────────────── */}
          <div className="flex items-start justify-between gap-6">
            <div className="flex-1 min-w-0">
              {paymentInfo && (
                <>
                  <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest mb-1.5">Remittance Instructions</p>
                  <p className="text-sm font-semibold whitespace-pre-line text-gray-800">{paymentInfo}</p>
                </>
              )}
            </div>
            <div className="border border-gray-200 rounded-lg p-4 min-w-[220px] flex-shrink-0">
              <div className="flex justify-between text-sm text-gray-600 mb-2">
                <span>Subtotal Amount:</span>
                <span className="font-mono">{currency} {subtotal.toFixed(2)}</span>
              </div>
              <hr className="border-gray-200 mb-2" />
              <div className={`flex justify-between font-bold text-base ${themeTotal}`}>
                <span>Grand Total:</span>
                <span className="font-mono">{currency} {Number(invoice.Total_Amount).toLocaleString('en-MY', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>

          {/* ── Footer ──────────────────────────────────────────────────── */}
          <div className="mt-10 pt-5 border-t border-gray-200 text-center">
            {profile.footer_text && (
              <p className="text-xs text-gray-500 italic mb-1.5">{profile.footer_text}</p>
            )}
            <p className="text-[9px] text-gray-300 uppercase tracking-widest">Generated Securely by BizEazyInvoicing</p>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function InvoicingModule({
  db, setDb, profiles, activeBranchLocation, isDarkMode,
  triggerToast, syncStateToSheets, spreadsheetId, accessToken,
  isSyncing, setIsSyncing, isStaff, onPreviewInvoice, onDeleteInvoice,
}: InvoicingModuleProps) {

  // ── Filter state ─────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [filterOutlet, setFilterOutlet] = useState<'All' | 'Bistro' | 'Nasi Kandar'>('All');
  const [filterStatus, setFilterStatus] = useState<'All' | 'Paid' | 'Pending'>('All');

  // ── Modal / edit state ────────────────────────────────────────────────────────
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);

  // Form fields
  const [modalOutlet, setModalOutlet] = useState<'Bistro' | 'Nasi Kandar'>('Bistro');
  const [modalDate, setModalDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [modalCustomer, setModalCustomer] = useState('');
  const [modalContact, setModalContact] = useState('');
  const [modalStatus, setModalStatus] = useState<'Paid' | 'Pending'>('Pending');
  const [modalNotes, setModalNotes] = useState('');
  const [lineItems, setLineItems] = useState<LineItem[]>([{ name: '', qty: 1, price: 0 }]);
  const [newItemName, setNewItemName] = useState('');
  const [newItemQty, setNewItemQty] = useState(1);
  const [newItemPrice, setNewItemPrice] = useState(0);
  const [editingItemIdx, setEditingItemIdx] = useState<number | null>(null);
  const [editItem, setEditItem] = useState<LineItem>({ name: '', qty: 1, price: 0 });
  const [saveCustomer, setSaveCustomer] = useState(false);
  const [discountType, setDiscountType] = useState<'none'|'percentage'|'fixed'>('none');
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [includeExtraCharge, setIncludeExtraCharge] = useState(false);
  const [extraCharges, setExtraCharges] = useState<{ label: string; amount: number }[]>([{ label: 'Delivery', amount: 0 }]);
  const [customerSuggestions, setCustomerSuggestions] = useState<Customer[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [isCustomerDirOpen, setIsCustomerDirOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<any>(null);
  const [isCustomerFormOpen, setIsCustomerFormOpen] = useState(false);
  const [custName, setCustName] = useState('');
  const [custContact, setCustContact] = useState('');
  const [custAddress, setCustAddress] = useState('');
  const [custType, setCustType] = useState<'Regular' | 'New'>('Regular');

  // ── Derived ───────────────────────────────────────────────────────────────────
  const activeProfile = useMemo(() => {
    const isBistro = activeBranchLocation.toLowerCase().includes('bistro');
    return profiles.find(p => isBistro ? p.id === 'Bistro' : p.id === 'Nasi Kandar') || profiles[0];
  }, [profiles, activeBranchLocation]);

  const currency = activeProfile?.currency_symbol || 'RM';
  const fmt = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return db.invoices.filter(inv => {
      if (filterOutlet !== 'All' && inv.Company !== filterOutlet) return false;
      if (filterStatus !== 'All' && inv.Status !== filterStatus) return false;
      if (q) {
        return (
          (inv.Invoice_ID || '').toLowerCase().includes(q) ||
          (inv.Customer_Name || '').toLowerCase().includes(q) ||
          (inv.Company || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [db.invoices, search, filterOutlet, filterStatus]);

  const stats = useMemo(() => {
    const all = db.invoices;
    return {
      total: all.reduce((s, i) => s + (Number(i.Total_Amount) || 0), 0),
      paid: all.filter(i => i.Status === 'Paid').reduce((s, i) => s + (Number(i.Total_Amount) || 0), 0),
      pending: all.filter(i => i.Status === 'Pending').reduce((s, i) => s + (Number(i.Total_Amount) || 0), 0),
      count: all.length,
      pendingCount: all.filter(i => i.Status === 'Pending').length,
    };
  }, [db.invoices]);

  const grandTotal = lineItems.reduce((s, i) => s + (i.qty || 0) * (i.price || 0), 0);

  // ── Line item helpers ─────────────────────────────────────────────────────────
  const removeLineItem = (idx: number) => setLineItems(prev => prev.filter((_, i) => i !== idx));
  const addNewItem = () => {
    if (!newItemName.trim()) return;
    setLineItems(prev => [...prev, { name: newItemName.trim(), qty: newItemQty || 1, price: newItemPrice || 0 }]);
    setNewItemName(''); setNewItemQty(1); setNewItemPrice(0);
  };

  // ── Customer autocomplete ─────────────────────────────────────────────────────
  const handleCustomerInput = (val: string) => {
    setModalCustomer(val);
    if (!val.trim()) { setCustomerSuggestions([]); setShowSuggestions(false); return; }
    const matches = db.customers.filter(c =>
      c.Customer_Name.toLowerCase().includes(val.toLowerCase()),
    ).slice(0, 6);
    setCustomerSuggestions(matches);
    setShowSuggestions(matches.length > 0);
  };

  const selectCustomer = (c: Customer) => {
    setModalCustomer(c.Customer_Name);
    setModalContact(c.Contact || '');
    setShowSuggestions(false);
  };

  // ── Open modal (create OR edit) ───────────────────────────────────────────────
  const openModal = (invoice?: Invoice) => {
    if (isStaff) { triggerToast('Staff accounts cannot modify invoices.', 'error'); return; }

    if (invoice) {
      // Edit mode — pre-fill from existing invoice
      setEditingInvoice(invoice);
      setModalOutlet(invoice.Company as 'Bistro' | 'Nasi Kandar');
      setModalDate(invoice.Date);
      setModalCustomer(invoice.Customer_Name);
      setModalContact(invoice.Customer_Contact || '');
      setModalStatus(invoice.Status as 'Paid' | 'Pending');
      setModalNotes(invoice.Notes || '');
      setSaveCustomer(false);
      setDiscountType((invoice.Discount_Type as 'none'|'percentage'|'fixed') || 'none');
      setDiscountValue(invoice.Discount_Value || 0);
      setIncludeExtraCharge(false);
      setExtraCharges([{ label: 'Delivery', amount: 0 }]);
      setNewItemName(''); setNewItemQty(1); setNewItemPrice(0);

      // Convert existing InvoiceItems to form LineItems
      const existingItems = db.invoice_items.filter(i => i.Invoice_ID === invoice.Invoice_ID);
      if (existingItems.length > 0) {
        // Detect trailing extra charges (saved via the checkbox mechanism — qty===1, known label)
        const CHARGE_LABELS = ['Delivery', 'Packaging', 'Service'];
        let splitIdx = existingItems.length;
        while (splitIdx > 0) {
          const item = existingItems[splitIdx - 1];
          if (item.Quantity === 1 && CHARGE_LABELS.includes(item.Item_Name)) {
            splitIdx--;
          } else break;
        }
        const detectedCharges = existingItems.slice(splitIdx).map(i => ({ label: i.Item_Name, amount: i.Price }));
        if (detectedCharges.length > 0) {
          setLineItems(existingItems.slice(0, splitIdx).map(i => ({ name: i.Item_Name, qty: i.Quantity, price: i.Price })));
          setIncludeExtraCharge(true);
          setExtraCharges(detectedCharges);
        } else {
          setLineItems(existingItems.map(i => ({ name: i.Item_Name, qty: i.Quantity, price: i.Price })));
        }
      } else {
        // No item detail stored — show a single placeholder from total
        setLineItems([{ name: 'Service / Item', qty: 1, price: invoice.Total_Amount }]);
      }
    } else {
      // Create mode
      setEditingInvoice(null);
      const isBistro = activeBranchLocation.toLowerCase().includes('bistro');
      setModalOutlet(isBistro ? 'Bistro' : 'Nasi Kandar');
      setModalDate(new Date().toISOString().slice(0, 10));
      setModalCustomer(''); setModalContact(''); setModalStatus('Pending'); setModalNotes('');
      setLineItems([]);
      setNewItemName(''); setNewItemQty(1); setNewItemPrice(0);
      setSaveCustomer(false);
      setDiscountType('none');
      setDiscountValue(0);
      setIncludeExtraCharge(false);
      setExtraCharges([{ label: 'Delivery', amount: 0 }]);
    }

    setIsModalOpen(true);
  };

  // ── Submit (create or update) ─────────────────────────────────────────────────
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalCustomer.trim()) { triggerToast('Customer name is required.', 'warning'); return; }
    const baseItems = lineItems.filter(i => i.name.trim() && i.qty > 0);
    if (baseItems.length === 0) { triggerToast('Add at least one line item with a name and quantity.', 'warning'); return; }
    const validItems = includeExtraCharge
      ? [...baseItems, ...extraCharges.filter(c => c.label.trim()).map(c => ({ name: c.label, qty: 1, price: c.amount }))]
      : baseItems;

    const totalAmount = validItems.reduce((s, i) => s + i.qty * i.price, 0);

    let updatedInvoices: Invoice[];
    let updatedItems: InvoiceItem[];
    let updatedCustomers = [...db.customers];
    let invoiceId: string;

    if (editingInvoice) {
      // ── UPDATE existing invoice ──────────────────────────────────────────────
      invoiceId = editingInvoice.Invoice_ID;
      const updatedInvoice: Invoice = {
        ...editingInvoice,
        Date: modalDate,
        Company: modalOutlet,
        Customer_Name: modalCustomer.trim(),
        Customer_Type: db.customers.some(c => c.Customer_Name.toLowerCase() === modalCustomer.toLowerCase().trim()) ? 'Regular' : 'New',
        Status: modalStatus,
        Total_Amount: totalAmount,
        Discount_Type: discountType,
        Discount_Value: discountValue,
        Subtotal_Amount: totalAmount,
        Customer_Contact: modalContact.trim() || '-',
        Notes: modalNotes.trim(),
        Branch_Location: activeBranchLocation,
      };
      updatedInvoices = db.invoices.map(inv => inv.Invoice_ID === invoiceId ? updatedInvoice : inv);

      // Replace items for this invoice
      const newInvoiceItems: InvoiceItem[] = validItems.map((item, idx) => ({
        Item_ID: `ITEM-${invoiceId}-${idx + 1}`,
        Invoice_ID: invoiceId,
        Item_Name: item.name.trim(),
        Quantity: item.qty,
        Price: item.price,
        Subtotal: item.qty * item.price,
      }));
      updatedItems = [
        ...db.invoice_items.filter(i => i.Invoice_ID !== invoiceId),
        ...newInvoiceItems,
      ];
    } else {
      // ── CREATE new invoice ───────────────────────────────────────────────────
      invoiceId = generateInvoiceId(modalOutlet, profiles, db.invoices);
      const newInvoice: Invoice = {
        Invoice_ID: invoiceId,
        Date: modalDate,
        Company: modalOutlet,
        Customer_Name: modalCustomer.trim(),
        Customer_Type: db.customers.some(c => c.Customer_Name.toLowerCase() === modalCustomer.toLowerCase().trim()) ? 'Regular' : 'New',
        Status: modalStatus,
        Total_Amount: totalAmount,
        Discount_Type: discountType,
        Discount_Value: discountValue,
        Subtotal_Amount: totalAmount,
        Currency_Symbol: currency,
        Is_Past_Entry: false,
        Customer_Contact: modalContact.trim() || '-',
        Customer_Address: '-',
        Template: 'modern',
        Notes: modalNotes.trim(),
        Branch_Location: activeBranchLocation,
      };
      updatedInvoices = [newInvoice, ...db.invoices];

      updatedItems = [
        ...db.invoice_items,
        ...validItems.map((item, idx) => ({
          Item_ID: `ITEM-${invoiceId}-${idx + 1}`,
          Invoice_ID: invoiceId,
          Item_Name: item.name.trim(),
          Quantity: item.qty,
          Price: item.price,
          Subtotal: item.qty * item.price,
        })),
      ];

      if (saveCustomer && modalCustomer.trim()) {
        const exists = updatedCustomers.some(c => c.Customer_Name.toLowerCase() === modalCustomer.toLowerCase().trim());
        if (!exists) {
          updatedCustomers.push({
            Customer_Name: modalCustomer.trim(),
            Contact: modalContact.trim() || '-',
            Customer_Type: 'Regular',
            Branch_Location: activeBranchLocation,
          });
        }
      }
    }

    const nextDb: DatabaseState = {
      ...db,
      invoices: updatedInvoices,
      invoice_items: updatedItems,
      customers: updatedCustomers,
    };

    setDb(nextDb);
    setIsModalOpen(false);
    triggerToast(editingInvoice ? `Invoice ${invoiceId} updated locally.` : `Invoice ${invoiceId} created.`, 'info');

    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast(`${invoiceId} saved to Google Sheets!`, 'success');
    } catch (err: any) {
      triggerToast(`Sync failed: ${err.message}`, 'error');
    } finally {
      setIsSyncing(false);
    }
  }, [editingInvoice, modalOutlet, modalDate, modalCustomer, modalContact, modalStatus,
    modalNotes, lineItems, saveCustomer, discountType, discountValue,
    extraCharges, includeExtraCharge,
    db, profiles, activeBranchLocation, currency,
    spreadsheetId, accessToken, setDb, triggerToast, syncStateToSheets, setIsSyncing]);

  // ── Status toggle ─────────────────────────────────────────────────────────────
  const toggleStatus = useCallback(async (invoiceId: string, current: 'Paid' | 'Pending') => {
    if (isStaff) { triggerToast('Read-only mode.', 'error'); return; }
    const next = current === 'Paid' ? 'Pending' : 'Paid';
    const nextDb: DatabaseState = {
      ...db,
      invoices: db.invoices.map(inv => inv.Invoice_ID === invoiceId ? { ...inv, Status: next } : inv),
    };
    setDb(nextDb);
    try {
      setIsSyncing(true);
      await syncStateToSheets(spreadsheetId, accessToken, nextDb, profiles, activeBranchLocation);
      triggerToast(`${invoiceId} marked ${next}.`, 'success');
    } catch (err: any) {
      triggerToast(`Sync failed: ${err.message}`, 'error');
    } finally {
      setIsSyncing(false);
    }
  }, [db, isStaff, profiles, activeBranchLocation, spreadsheetId, accessToken, setDb, triggerToast, syncStateToSheets, setIsSyncing]);

  const inputClass = `w-full px-3 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
    isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
  }`;

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      {/* Read-only banner */}
      {isStaff && (
        <div className="flex items-center gap-3 p-3.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-xl text-xs text-amber-700 dark:text-amber-400 font-semibold">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          Staff view — read only. Invoice creation and edits are restricted.
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Invoiced', value: `${currency} ${fmt(stats.total)}`, sub: `${stats.count} invoices` },
          { label: 'Collected', value: `${currency} ${fmt(stats.paid)}`, sub: `${stats.count - stats.pendingCount} paid` },
          { label: 'Outstanding', value: `${currency} ${fmt(stats.pending)}`, sub: `${stats.pendingCount} pending` },
        ].map(s => (
          <div key={s.label} className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-xl px-4 py-3">
            <div className="text-[10px] font-bold text-gray-400 dark:text-slate-500 uppercase tracking-wider">{s.label}</div>
            <div className="text-base font-black text-gray-900 dark:text-white font-mono mt-0.5">{s.value}</div>
            <div className="text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">{s.sub}</div>
          </div>
        ))}
        <div
          className={`rounded-xl px-4 py-3 cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md border ${
            isDarkMode
              ? 'bg-slate-900 border-slate-800 hover:border-indigo-700'
              : 'bg-white border-gray-200 hover:border-indigo-300 shadow-sm'
          }`}
          onClick={() => setIsCustomerDirOpen(true)}
        >
          <div className={`w-7 h-7 rounded-xl flex items-center justify-center mb-2 ${
            isDarkMode ? 'bg-purple-500/10 text-purple-400' : 'bg-purple-50 text-purple-600'
          }`}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
            </svg>
          </div>
          <div className="text-base font-black text-gray-900 dark:text-white font-mono mt-0.5">{db.customers?.length ?? 0}</div>
          <div className={`text-[10px] font-bold uppercase tracking-wider ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>Saved Customers</div>
          <div className={`text-[10px] font-medium mt-0.5 ${isDarkMode ? 'text-purple-400' : 'text-purple-600'}`}>Click to manage →</div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="space-y-2">
        {/* Row 1: search + New Invoice button */}
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
          {!isStaff && (
            <button
              onClick={() => openModal()}
              className="flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-3.5 py-2 rounded-lg transition-colors cursor-pointer shadow-sm shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">New Invoice</span>
              <span className="sm:hidden">New</span>
            </button>
          )}
        </div>
        {/* Row 2: filters */}
        <div className="flex items-center gap-2">
          <select
            value={filterOutlet}
            onChange={e => setFilterOutlet(e.target.value as typeof filterOutlet)}
            className={`flex-1 px-3 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
              isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
            }`}
          >
            <option value="All">All Outlets</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.store_name || p.name}</option>)}
          </select>
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as typeof filterStatus)}
            className={`flex-1 px-3 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
              isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
            }`}
          >
            <option value="All">All Statuses</option>
            <option value="Paid">Paid</option>
            <option value="Pending">Pending</option>
          </select>
        </div>
      </div>

      {/* Invoice table */}
      <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 text-center">
            <FileText className="w-8 h-8 text-gray-200 dark:text-slate-700 mx-auto mb-3" />
            <p className="text-xs font-bold text-gray-500 dark:text-slate-400">
              {db.invoices.length === 0 ? 'No invoices yet — create your first one.' : 'No invoices match these filters.'}
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
                  <th className="px-5 py-3">Invoice ID</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Outlet</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-slate-800' : 'divide-gray-100'}`}>
                {filtered.map(inv => {
                  const p = profiles.find(pr => pr.id === inv.Company);
                  const curr = p?.currency_symbol || 'RM';
                  return (
                    <tr key={inv.Invoice_ID} className="hover:bg-gray-50/50 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-5 py-3.5 font-mono font-bold text-gray-900 dark:text-white whitespace-nowrap">{inv.Invoice_ID}</td>
                      <td className="px-4 py-3.5 text-gray-500 dark:text-slate-400 whitespace-nowrap">{inv.Date}</td>
                      <td className="px-4 py-3.5">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase whitespace-nowrap ${
                          inv.Company === 'Bistro'
                            ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
                            : 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400'
                        }`}>
                          {p?.store_name || inv.Company}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 font-medium text-gray-700 dark:text-slate-300 max-w-[160px] truncate">{inv.Customer_Name}</td>
                      <td className="px-4 py-3.5 text-right font-black font-mono text-gray-900 dark:text-white whitespace-nowrap">
                        {curr} {Number(inv.Total_Amount).toFixed(2)}
                      </td>
                      <td className="px-4 py-3.5 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase inline-flex items-center gap-1 ${
                          inv.Status === 'Paid'
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
                            : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
                        }`}>
                          <span className={`w-1 h-1 rounded-full flex-shrink-0 ${inv.Status === 'Paid' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                          {inv.Status}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                          {!isStaff && (
                            <>
                              <button
                                onClick={() => openModal(inv)}
                                className="p-1 text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 rounded cursor-pointer transition-colors"
                                title="Edit invoice"
                              >
                                <Edit className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => toggleStatus(inv.Invoice_ID, inv.Status)}
                                disabled={isSyncing}
                                className={`text-[10px] font-bold cursor-pointer transition-colors hover:underline ${
                                  inv.Status === 'Paid'
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-emerald-600 dark:text-emerald-400'
                                }`}
                              >
                                {inv.Status === 'Paid' ? 'Pending' : 'Paid'}
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => onPreviewInvoice?.(inv.Invoice_ID)}
                            className="flex items-center gap-1 text-[10px] font-bold text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 cursor-pointer transition-colors"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            Preview
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list — visible only on small screens */}
          <div className="md:hidden divide-y divide-gray-100 dark:divide-slate-800">
            {filtered.map(inv => (
              <div key={inv.Invoice_ID} className={`p-4 ${isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-gray-50/60'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-xs font-black font-mono ${isDarkMode ? 'text-indigo-400' : 'text-indigo-700'}`}>
                        {inv.Invoice_ID}
                      </span>
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                        inv.Status === 'Paid'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
                      }`}>{inv.Status}</span>
                    </div>
                    <p className={`text-xs font-semibold truncate ${isDarkMode ? 'text-slate-200' : 'text-slate-800'}`}>
                      {inv.Customer_Name}
                    </p>
                    <p className={`text-[10px] mt-0.5 ${isDarkMode ? 'text-slate-500' : 'text-slate-400'}`}>
                      {inv.Date?.split('T')[0] || inv.Date}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-sm font-black font-mono ${isDarkMode ? 'text-white' : 'text-slate-900'}`}>
                      RM {Number(inv.Total_Amount).toFixed(2)}
                    </p>
                    <div className="flex items-center gap-1.5 mt-2 justify-end">
                      <button
                        onClick={() => onPreviewInvoice?.(inv.Invoice_ID)}
                        className={`px-2.5 py-1 text-[10px] font-bold rounded-lg cursor-pointer transition-colors ${
                          isDarkMode ? 'bg-slate-700 text-indigo-400 hover:bg-slate-600' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                        }`}
                      >Preview</button>
                      {!isStaff && (
                        <button
                          onClick={() => openModal(inv)}
                          className={`px-2.5 py-1 text-[10px] font-bold rounded-lg cursor-pointer transition-colors ${
                            isDarkMode ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                          }`}
                        >Edit</button>
                      )}
                      {!isStaff && (
                        <button
                          onClick={() => toggleStatus(inv.Invoice_ID, inv.Status)}
                          disabled={isSyncing}
                          className={`px-2.5 py-1 text-[10px] font-bold rounded-lg cursor-pointer transition-colors ${
                            isDarkMode
                              ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                          }`}
                        >{inv.Status === 'Paid' ? 'Pending' : 'Paid'}</button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          </>
        )}
      </div>

      {/* ── Create / Edit Invoice Modal ────────────────────────────────────── */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className={`w-full max-w-5xl rounded-2xl shadow-2xl flex flex-col max-h-[92vh] ${
            isDarkMode ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-gray-200'
          }`}>
            {/* Header */}
            <div className={`flex items-center justify-between px-6 py-4 border-b flex-shrink-0 ${
              isDarkMode ? 'border-slate-800' : 'border-gray-100'
            }`}>
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-500" />
                <h2 className="text-sm font-bold text-gray-900 dark:text-white">
                  {editingInvoice ? `Edit Invoice — ${editingInvoice.Invoice_ID}` : 'New Invoice'}
                </h2>
              </div>
              <button onClick={() => setIsModalOpen(false)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.5fr] gap-6">

                {/* Left: metadata */}
                <div className="space-y-4">
                  {/* Outlet */}
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
                              : isDarkMode
                                ? 'bg-slate-950 border-slate-700 text-slate-300 hover:border-slate-500'
                                : 'bg-white border-gray-200 text-gray-700 hover:border-gray-300'
                          }`}
                        >
                          {profiles.find(p => p.id === outlet)?.store_name || outlet}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Date */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Invoice Date *</label>
                    <input type="date" value={modalDate} onChange={e => setModalDate(e.target.value)} className={inputClass} required />
                  </div>

                  {/* Customer with autocomplete */}
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
                      <div className={`absolute z-10 w-full mt-1 rounded-xl border shadow-lg max-h-36 overflow-y-auto ${
                        isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-white border-gray-200'
                      }`}>
                        {customerSuggestions.map(c => (
                          <button
                            key={c.Customer_Name}
                            type="button"
                            onMouseDown={() => selectCustomer(c)}
                            className={`w-full text-left px-3 py-2 text-xs font-semibold flex justify-between items-center cursor-pointer ${
                              isDarkMode ? 'hover:bg-slate-800 text-slate-200' : 'hover:bg-gray-50 text-gray-800'
                            }`}
                          >
                            <span>{c.Customer_Name}</span>
                            <span className="text-[10px] text-gray-400 dark:text-slate-500 font-mono">{c.Contact || 'No contact'}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Contact */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Contact / Email</label>
                    <input type="text" value={modalContact} onChange={e => setModalContact(e.target.value)} placeholder="Phone, email, or billing reference…" className={inputClass} />
                  </div>

                  {/* Status */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Payment Status</label>
                    <select value={modalStatus} onChange={e => setModalStatus(e.target.value as 'Paid' | 'Pending')} className={inputClass}>
                      <option value="Pending">Pending / Uncollected</option>
                      <option value="Paid">Paid</option>
                    </select>
                  </div>

                  {/* Notes */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">Notes</label>
                    <textarea value={modalNotes} onChange={e => setModalNotes(e.target.value)} placeholder="Optional remarks…" rows={2} className={`${inputClass} resize-none`} />
                  </div>

                  {/* Discount option */}
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5">
                      Discount (Optional)
                    </label>
                    <div className="flex gap-2">
                      <select
                        value={discountType}
                        onChange={e => setDiscountType(e.target.value as 'none'|'percentage'|'fixed')}
                        className={`px-2.5 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'}`}
                      >
                        <option value="none">No Discount</option>
                        <option value="percentage">Percentage (%)</option>
                        <option value="fixed">Fixed Amount (RM)</option>
                      </select>
                      {discountType !== 'none' && (
                        <input
                          type="number" min="0" step="any"
                          value={discountValue || ''}
                          onChange={e => setDiscountValue(Number(e.target.value))}
                          placeholder={discountType === 'percentage' ? 'e.g. 10' : 'e.g. 50'}
                          className={`flex-1 px-2.5 py-2 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'}`}
                        />
                      )}
                    </div>
                  </div>

                  {/* Extra Charges */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">
                        Extra Charges (Optional)
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={includeExtraCharge}
                          onChange={e => setIncludeExtraCharge(e.target.checked)}
                          className="accent-indigo-600 cursor-pointer"
                        />
                        <span className="text-[10px] font-semibold text-gray-500 dark:text-slate-400">Include in invoice</span>
                      </label>
                    </div>
                    {includeExtraCharge && (
                      <div className="space-y-2">
                        {extraCharges.map((charge, idx) => (
                          <div key={idx} className="flex flex-wrap gap-1.5 items-center">
                            <select
                              value={['Delivery','Packaging','Service'].includes(charge.label) ? charge.label : 'Custom'}
                              onChange={e => {
                                const val = e.target.value;
                                setExtraCharges(prev => prev.map((c, i) => i === idx ? { ...c, label: val === 'Custom' ? '' : val } : c));
                              }}
                              className={`px-2 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'}`}
                            >
                              <option value="Delivery">Delivery</option>
                              <option value="Packaging">Packaging</option>
                              <option value="Service">Service</option>
                              <option value="Custom">Custom…</option>
                            </select>
                            {!['Delivery','Packaging','Service'].includes(charge.label) && (
                              <input
                                type="text"
                                placeholder="Label"
                                value={charge.label}
                                onChange={e => setExtraCharges(prev => prev.map((c, i) => i === idx ? { ...c, label: e.target.value } : c))}
                                className={`w-28 px-2 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'}`}
                              />
                            )}
                            <input
                              type="number" min="0" step="any"
                              value={charge.amount}
                              onChange={e => setExtraCharges(prev => prev.map((c, i) => i === idx ? { ...c, amount: Number(e.target.value) } : c))}
                              placeholder="0"
                              className={`w-20 px-2 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono ${isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'}`}
                            />
                            <span className={`text-[10px] font-bold ${charge.amount === 0 ? 'text-emerald-600' : 'text-gray-400 dark:text-slate-500'}`}>
                              {charge.amount === 0 ? 'FREE' : `RM ${charge.amount.toFixed(2)}`}
                            </span>
                            {extraCharges.length > 1 && (
                              <button
                                type="button"
                                onClick={() => setExtraCharges(prev => prev.filter((_, i) => i !== idx))}
                                className="text-rose-400 hover:text-rose-600 cursor-pointer p-0.5 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                              </button>
                            )}
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setExtraCharges(prev => [...prev, { label: 'Delivery', amount: 0 }])}
                          className={`flex items-center gap-1 text-[10px] font-bold cursor-pointer hover:underline ${isDarkMode ? 'text-indigo-400' : 'text-indigo-600'}`}
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4"/></svg>
                          Add another charge
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Save customer — only on create */}
                  {!editingInvoice && (
                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <input type="checkbox" checked={saveCustomer} onChange={e => setSaveCustomer(e.target.checked)} className="mt-0.5 accent-indigo-600" />
                      <div>
                        <span className="text-xs font-semibold text-gray-800 dark:text-slate-200 block">Save customer to database</span>
                        <span className="text-[10px] text-gray-400 dark:text-slate-500">Adds this customer to your Sheets profile list.</span>
                      </div>
                    </label>
                  )}
                </div>

                {/* Right: line items — AI Studio style */}
                <div className="flex flex-col gap-2">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400">Line Items *</label>

                  {/* Add row input — stacked on mobile, single row on desktop */}
                  <div className={`flex flex-col gap-1.5 p-2 rounded-xl border ${
                    isDarkMode ? 'bg-slate-900 border-slate-700' : 'bg-gray-50 border-gray-200'
                  }`}>
                    {/* Description — full width */}
                    <input
                      type="text"
                      placeholder="Item description"
                      value={newItemName}
                      onChange={e => setNewItemName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNewItem(); } }}
                      className={`w-full px-2.5 py-1.5 text-[11px] rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                        isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
                      }`}
                    />
                    {/* Qty + Price + Add button — always fits */}
                    <div className="flex gap-1.5 items-center">
                      <input
                        type="number" placeholder="Qty" min="0" step="any"
                        value={newItemQty || ''}
                        onChange={e => setNewItemQty(Number(e.target.value))}
                        className={`w-20 px-2 py-1.5 text-[11px] text-center rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                          isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
                        }`}
                      />
                      <input
                        type="number" placeholder="Price RM" min="0" step="any"
                        value={newItemPrice || ''}
                        onChange={e => setNewItemPrice(Number(e.target.value))}
                        className={`flex-1 px-2 py-1.5 text-[11px] text-right rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                          isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={addNewItem}
                        className="shrink-0 w-8 h-8 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Column headers */}
                  {lineItems.length > 0 && (
                    <div
                      className={`grid text-[9px] font-bold uppercase tracking-wider px-2 py-1 ${
                        isDarkMode ? 'text-slate-500' : 'text-gray-400'
                      }`}
                      style={{ gridTemplateColumns: '1fr 48px 72px 68px 52px' }}
                    >
                      <span>Description</span>
                      <span className="text-center">Qty</span>
                      <span className="text-right">Price (RM)</span>
                      <span className="text-right">Subtotal</span>
                      <span className="text-center">Action</span>
                    </div>
                  )}

                  {/* All rows — no scroll, plain list */}
                  <div className="space-y-1">
                    {lineItems.map((item, idx) => (
                      editingItemIdx === idx ? (
                        /* ── Inline edit row ── */
                        <div
                          key={idx}
                          className={`flex flex-wrap gap-1.5 items-center px-2 py-2 rounded-lg ${
                            isDarkMode ? 'bg-slate-800/60' : 'bg-indigo-50'
                          }`}
                        >
                          <input
                            type="text"
                            value={editItem.name}
                            onChange={e => setEditItem(prev => ({ ...prev, name: e.target.value }))}
                            placeholder="Description"
                            className={`flex-1 min-w-[120px] px-2 py-1 text-[11px] rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                              isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
                            }`}
                          />
                          <input
                            type="number" min="0" step="any"
                            value={editItem.qty || ''}
                            onChange={e => setEditItem(prev => ({ ...prev, qty: Number(e.target.value) }))}
                            placeholder="Qty"
                            className={`w-14 px-2 py-1 text-[11px] text-center rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                              isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
                            }`}
                          />
                          <input
                            type="number" min="0" step="any"
                            value={editItem.price || ''}
                            onChange={e => setEditItem(prev => ({ ...prev, price: Number(e.target.value) }))}
                            placeholder="Price"
                            className={`w-20 px-2 py-1 text-[11px] text-right rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${
                              isDarkMode ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-white border-gray-200 text-gray-900'
                            }`}
                          />
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                if (!editItem.name.trim()) return;
                                setLineItems(prev => prev.map((it, i) => i === idx ? { ...editItem } : it));
                                setEditingItemIdx(null);
                              }}
                              className="px-2 py-1 text-[10px] font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingItemIdx(null)}
                              className={`px-2 py-1 text-[10px] font-bold rounded-lg border cursor-pointer ${
                                isDarkMode ? 'border-slate-600 text-slate-300 hover:bg-slate-700' : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                              }`}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ) : (
                        /* ── Display row ── */
                        <div
                          key={idx}
                          className={`grid items-center gap-2 px-2 py-1.5 rounded-lg ${
                            isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-gray-50'
                          }`}
                          style={{ gridTemplateColumns: '1fr 48px 72px 68px 52px' }}
                        >
                          <span className={`text-[11px] font-medium truncate ${isDarkMode ? 'text-slate-200' : 'text-gray-800'}`}>
                            {item.name}
                          </span>
                          <span className={`text-[11px] font-mono text-center ${isDarkMode ? 'text-slate-300' : 'text-gray-600'}`}>
                            {item.qty}
                          </span>
                          <span className={`text-[11px] font-mono text-right ${isDarkMode ? 'text-slate-300' : 'text-gray-600'}`}>
                            {Number(item.price || 0).toFixed(2)}
                          </span>
                          <span className={`text-[11px] font-mono font-bold text-right ${isDarkMode ? 'text-slate-100' : 'text-gray-900'}`}>
                            {((item.qty || 0) * (item.price || 0)).toFixed(2)}
                          </span>
                          <div className="flex items-center justify-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => { setEditItem({ ...item }); setEditingItemIdx(idx); }}
                              className="text-indigo-400 hover:text-indigo-600 cursor-pointer p-1 rounded hover:bg-indigo-50 dark:hover:bg-indigo-950/30"
                            >
                              <Edit className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeLineItem(idx)}
                              className="text-rose-400 hover:text-rose-600 cursor-pointer p-1 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      )
                    ))}
                    {lineItems.length === 0 && (
                      <p className={`text-[10px] text-center py-3 ${isDarkMode ? 'text-slate-600' : 'text-gray-400'}`}>
                        No items yet — fill the row above and press +
                      </p>
                    )}
                  </div>

                  {/* Grand total */}
                  <div className={`flex items-center justify-between p-3 rounded-xl mt-auto ${
                    isDarkMode ? 'bg-slate-950 border border-slate-800' : 'bg-gray-50 border border-gray-200'
                  }`}>
                    <span className="text-xs font-bold text-gray-500 dark:text-slate-400 uppercase tracking-wider">Grand Total</span>
                    <span className="text-xl font-black text-gray-900 dark:text-white font-mono">
                      {currency} {grandTotal.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className={`flex items-center justify-between gap-2 pt-4 mt-4 border-t ${isDarkMode ? 'border-slate-800' : 'border-gray-100'}`}>
                <div>
                  {editingInvoice && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete invoice ${editingInvoice.Invoice_ID}? This cannot be undone.`)) {
                          onDeleteInvoice?.(editingInvoice.Invoice_ID);
                          setIsModalOpen(false);
                        }
                      }}
                      className="px-4 py-2 text-xs font-bold rounded-xl border cursor-pointer transition-colors bg-rose-50 hover:bg-rose-100 text-rose-600 border-rose-200 dark:bg-rose-950/30 dark:hover:bg-rose-900/40 dark:text-rose-400 dark:border-rose-800"
                    >
                      Delete Invoice
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className={`px-4 py-2 text-xs font-bold rounded-xl border cursor-pointer transition-colors ${
                      isDarkMode ? 'bg-transparent border-slate-700 text-slate-300 hover:bg-slate-800' : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSyncing}
                    className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-bold text-xs rounded-xl transition-colors cursor-pointer shadow-sm"
                  >
                    {isSyncing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                    {isSyncing ? 'Saving…' : (editingInvoice ? 'Update Invoice' : 'Generate & Save')}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Customer Directory Modal ──────────────────────────────────────── */}
      {isCustomerDirOpen && (
        <div className="fixed inset-0 z-[55] bg-black/60 flex items-center justify-center p-4">
          <div className={`w-full max-w-3xl rounded-2xl shadow-xl flex flex-col max-h-[85vh] ${isDarkMode ? 'bg-slate-900 border border-slate-800 text-slate-100' : 'bg-white border border-slate-200'}`}>
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-slate-800 shrink-0">
              <h3 className="text-sm font-bold text-indigo-500 uppercase tracking-wider">Saved Customer Records</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setEditingCustomer(null);
                    setCustName(''); setCustContact(''); setCustAddress(''); setCustType('Regular');
                    setIsCustomerFormOpen(true);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg cursor-pointer transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Customer
                </button>
                <button onClick={() => setIsCustomerDirOpen(false)} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer text-gray-400">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Customer form (inline) */}
            {isCustomerFormOpen && (
              <div className={`px-6 py-4 border-b ${isDarkMode ? 'border-slate-700 bg-slate-800/50' : 'border-gray-100 bg-indigo-50/30'}`}>
                <h4 className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider mb-3">
                  {editingCustomer ? 'Edit Customer' : 'New Customer'}
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-[9px] font-bold text-gray-400 uppercase mb-1">Full Name *</label>
                    <input value={custName} onChange={e => setCustName(e.target.value)}
                      placeholder="Customer full name"
                      className={`w-full px-2.5 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-gray-200'}`} />
                  </div>
                  <div>
                    <label className="block text-[9px] font-bold text-gray-400 uppercase mb-1">Contact / Email</label>
                    <input value={custContact} onChange={e => setCustContact(e.target.value)}
                      placeholder="Phone or email"
                      className={`w-full px-2.5 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-gray-200'}`} />
                  </div>
                  <div>
                    <label className="block text-[9px] font-bold text-gray-400 uppercase mb-1">Address</label>
                    <input value={custAddress} onChange={e => setCustAddress(e.target.value)}
                      placeholder="Billing address (optional)"
                      className={`w-full px-2.5 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-gray-200'}`} />
                  </div>
                  <div>
                    <label className="block text-[9px] font-bold text-gray-400 uppercase mb-1">Customer Type</label>
                    <select value={custType} onChange={e => setCustType(e.target.value as 'Regular' | 'New')}
                      className={`w-full px-2.5 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-1 focus:ring-indigo-500 ${isDarkMode ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-gray-200'}`}>
                      <option value="Regular">Regular Client</option>
                      <option value="New">New Client</option>
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setIsCustomerFormOpen(false)}
                    className="px-3 py-1.5 text-xs font-bold rounded-lg border cursor-pointer text-gray-500 hover:bg-gray-50 dark:hover:bg-slate-800">
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (!custName.trim()) return;
                      const newCustomer = {
                        Customer_Name: custName.trim(),
                        Contact: custContact.trim() || '-',
                        Address: custAddress.trim() || '-',
                        Customer_Type: custType,
                        Branch_Location: activeBranchLocation,
                      };
                      if (editingCustomer) {
                        setDb(prev => ({
                          ...prev,
                          customers: prev.customers.map((c: any) =>
                            c.Customer_Name === editingCustomer.Customer_Name ? newCustomer : c
                          )
                        }));
                      } else {
                        setDb(prev => ({
                          ...prev,
                          customers: [...prev.customers, newCustomer]
                        }));
                      }
                      setIsCustomerFormOpen(false);
                      setEditingCustomer(null);
                    }}
                    className="px-3 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer">
                    {editingCustomer ? 'Save Changes' : 'Add Customer'}
                  </button>
                </div>
              </div>
            )}

            {/* Table */}
            <div className="overflow-y-auto flex-1 px-6 py-4">
              {(db?.customers || []).length === 0 ? (
                <p className="text-center text-xs text-gray-400 py-8">No saved customers yet. Click "Add Customer" to create one.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className={`text-[9px] font-bold uppercase tracking-wider border-b ${isDarkMode ? 'border-slate-700 text-slate-400' : 'border-gray-100 text-gray-400'}`}>
                      <th className="text-left py-2 pr-3">Name</th>
                      <th className="text-left py-2 pr-3">Contact</th>
                      <th className="text-left py-2 pr-3">Address</th>
                      <th className="text-left py-2 pr-3">Type</th>
                      <th className="text-right py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50 dark:divide-slate-800/60">
                    {(db?.customers || []).map((c: any, i: number) => (
                      <tr key={i} className={`${isDarkMode ? 'hover:bg-slate-800/40' : 'hover:bg-gray-50/60'}`}>
                        <td className="py-2.5 pr-3 font-semibold text-gray-800 dark:text-slate-200">{c.Customer_Name}</td>
                        <td className="py-2.5 pr-3 text-gray-500 dark:text-slate-400">{c.Contact || '-'}</td>
                        <td className="py-2.5 pr-3 text-gray-500 dark:text-slate-400 max-w-[160px] truncate">{c.Address || '-'}</td>
                        <td className="py-2.5 pr-3">
                          <span className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase ${c.Customer_Type === 'Regular' ? 'bg-emerald-100 text-emerald-700' : 'bg-indigo-100 text-indigo-700'}`}>
                            {c.Customer_Type || 'Regular'}
                          </span>
                        </td>
                        <td className="py-2.5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => {
                                setEditingCustomer(c);
                                setCustName(c.Customer_Name || '');
                                setCustContact(c.Contact === '-' ? '' : (c.Contact || ''));
                                setCustAddress(c.Address === '-' ? '' : (c.Address || ''));
                                setCustType(c.Customer_Type || 'Regular');
                                setIsCustomerFormOpen(true);
                              }}
                              className="text-indigo-500 hover:text-indigo-700 font-bold text-[10px] cursor-pointer hover:underline"
                            >Edit</button>
                            <button
                              onClick={() => {
                                if (window.confirm(`Delete customer "${c.Customer_Name}"?`)) {
                                  setDb(prev => ({
                                    ...prev,
                                    customers: prev.customers.filter((_: any, idx: number) => idx !== i)
                                  }));
                                }
                              }}
                              className="text-rose-400 hover:text-rose-600 font-bold text-[10px] cursor-pointer hover:underline"
                            >Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className={`px-6 py-3 border-t flex justify-end ${isDarkMode ? 'border-slate-800' : 'border-gray-100'}`}>
              <button onClick={() => setIsCustomerDirOpen(false)}
                className="px-4 py-2 text-xs font-bold rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 cursor-pointer">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Invoice Preview Modal ───────────────────────────────────────── */}
      {previewState && (
        <InvoicePreviewModal
          invoice={previewState.invoice}
          items={previewState.items}
          profile={previewState.profile}
          onClose={() => setPreviewState(null)}
          onDownload={() => generatePDF(previewState.invoice, previewState.items, previewState.profile)}
        />
      )}
    </div>
  );
}
