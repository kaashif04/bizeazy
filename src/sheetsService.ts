/**
 * sheetsService.ts — COMPLETE FILE WITH LINE ITEMS FIX
 * ─────────────────────────────────────────────────────
 * THE BUG THAT WAS KILLING ITEMS:
 *
 * Your Google Sheet has a separate "Invoice_Items" tab.
 * The Apps Script fetchDataAll returns it as json.data.invoice_items[]
 * BUT the old sheetsService only looked inside row.Invoice_Items_JSON
 * (an embedded column that doesn't exist in your sheet).
 * Result: invoice_items array was ALWAYS empty on load.
 *
 * THE FIX: After the invoices loop, read json.data.invoice_items
 * as a standalone array and push every row into invoice_items[].
 * Both paths are kept so nothing breaks if Invoice_Items_JSON exists.
 * ─────────────────────────────────────────────────────
 */

import {
  DatabaseState, Invoice, InvoiceItem, Payment,
  Customer, CompanyProfile, Employee, Payslip, SalaryAdvance,
  Quotation, QuotationDay, QuotationItem, PricingMode, PackageSubMode, ServingStyle
} from './types';
import { gasGet, gasPost, getApiUrl, setApiUrl, DEFAULT_API_URL, can, loadSession } from './auth';
import { resolveOutletId, outletLabel } from './utils/outlets';

// Sign-in now lives in auth.ts (user ID + password against the Users directory).
// Firebase Google sign-in is gone: the Google token it produced was never used
// for data access — the Apps Script web app reads the sheets as its own owner —
// so it authenticated nobody and gated nothing.
export { getApiUrl, setApiUrl, DEFAULT_API_URL };
export const API_URL = DEFAULT_API_URL;

// The `token` parameter on the exported calls below is vestigial: call sites in
// the modules still pass it, but the live session token is read from auth.ts so
// there is exactly one source of truth.

// ── Row mappers ───────────────────────────────────────────────
const mapInvoicesToRows = (invoices: Invoice[], profiles?: CompanyProfile[]): any[][] => {
  return invoices.map(i => {
    let companyName: string = i.Company;
    if (profiles) {
      const match = profiles.find(p => p.id === i.Company);
      if (match) companyName = outletLabel(match);
    }
    return [
      i.Invoice_ID, i.Date, companyName, i.Customer_Name, i.Status,
      i.Total_Amount, i.Discount_Value || 0,
      i.Subtotal_Amount || i.Total_Amount, i.Notes || '',
      i.Customer_Contact || '-', i.Customer_Address || '-'
    ];
  });
};

const mapItemsToRows = (items: InvoiceItem[]): any[][] =>
  items.map(t => [t.Item_ID, t.Invoice_ID, t.Item_Name, t.Quantity, t.Price, t.Subtotal]);

const mapCustomersToRows = (customers: Customer[]): any[][] =>
  customers.map(c => [c.Customer_Name, c.Contact || '-', c.Customer_Type, c.Address || '-']);

const getSheetRowsAsObjects = (headers: string[], values: any[][]): any[] => {
  if (!values || values.length === 0) return [];
  return values.map(row => {
    const obj: any = {};
    headers.forEach((h, idx) => { obj[h] = row[idx] !== undefined ? row[idx] : ''; });
    return obj;
  });
};

// De-duplicates an array of rows by a key function. The FIRST occurrence of a
// key wins, so callers put the authoritative (current-branch) rows first.
// This is the guard that prevents the sheet from accumulating duplicate rows:
// because loadData() fetches every branch into `db`, the "other branch" merge
// below can re-introduce rows that are already present — dedupe collapses them.
const dedupeByKey = <T>(rows: T[], keyFn: (row: T) => string): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  rows.forEach(row => {
    const key = keyFn(row);
    if (!key) { out.push(row); return; } // keyless rows can't be deduped — keep them
    if (seen.has(key)) return;
    seen.add(key);
    out.push(row);
  });
  return out;
};

// Content key for invoice line items. Invoice items live in TWO places in the
// sheet (the Invoice_Items_JSON column on the invoice row AND the flat
// Invoice_Items tab) and their Item_IDs are regenerated on every edit, so IDs
// are NOT stable enough to dedupe on. Keying by (invoice + name + qty + price +
// subtotal) collapses true duplicates regardless of ID. Used on BOTH read and
// write so the two paths can never disagree.
const invoiceItemKey = (it: any): string =>
  `${String(it.Invoice_ID || '')}|${String(it.Item_Name || '')}|${Number(it.Quantity) || 0}|${Number(it.Price) || 0}|${Number(it.Subtotal) || 0}`;

const isMissingSheetError = (errorMsg: string): boolean => {
  const l = errorMsg.toLowerCase();
  return l.includes('unable to parse') || l.includes('not found') || l.includes('range');
};

// ── initializeSheetsDatabase ──────────────────────────────────
export const initializeSheetsDatabase = async (
  spreadsheetId: string, token: string
): Promise<boolean> => {
  try {
    await gasPost({ action: 'initializeDatabase', spreadsheetId });
    return true;
  } catch (err) {
    console.error('Error initializing database:', err);
    return false;
  }
};

// ── fetchDataAll — THE FIXED VERSION ─────────────────────────
export const fetchDataAll = async (
  spreadsheetId: string,
  token: string,
  profiles?: CompanyProfile[],
  branchFilter?: string
): Promise<DatabaseState & { profiles?: CompanyProfile[] }> => {
  // The backend resolves the spreadsheet from the session, so tabs this user's
  // modules do not cover come back empty rather than being filtered here.
  const json = { data: await gasGet({ action: 'fetchDataAll', spreadsheetId }) };

  // ── Customers ────────────────────────────────────────────
  const rawCustomers = json.data?.customers || [];
  let customers: Customer[] = rawCustomers.map((row: any) => ({
    Customer_Name: String(row.Customer_Name || ''),
    Contact: String(row.Contact || '-'),
    Customer_Type: (row.Customer_Type === 'New' ? 'New' : 'Regular') as 'Regular' | 'New',
    Address: String(row.Address || '-'),
    Branch_Location: String(row.Branch_Location || '')
  })).filter((c: any) => c.Customer_Name);

  // ── Invoices + inline items ──────────────────────────────
  const rawInvoices = json.data?.invoices || [];
  let invoice_items: InvoiceItem[] = [];
  // Track which Invoice_IDs got items from the inline JSON column
  const coveredByInlineJSON = new Set<string>();

  let invoices: Invoice[] = rawInvoices.map((row: any) => {
    const custName = String(row.Customer_Name || '');
    const matchedCustomer = customers.find(
      c => (c.Customer_Name || '').toLowerCase() === custName.toLowerCase()
    );
    const resolvedType = matchedCustomer ? matchedCustomer.Customer_Type : 'Regular';

    const invId = String(row.Invoice_ID || '');
    // Rows store the outlet's display NAME; map it back to an outlet id.
    const resolvedCompany = resolveOutletId(row.Company, invId, profiles || []);

    // ── Source A: Invoice_Items_JSON inline column ────────
    if (row.Invoice_Items_JSON) {
      try {
        const parsedItems = JSON.parse(row.Invoice_Items_JSON);
        if (Array.isArray(parsedItems) && parsedItems.length > 0) {
          parsedItems.forEach((item: any) => {
            invoice_items.push({
              Item_ID:    String(item.Item_ID || ''),
              Invoice_ID: String(row.Invoice_ID || invId),
              Item_Name:  String(item.Item_Name || ''),
              Quantity:   Number(item.Quantity) || 0,
              Price:      Number(item.Price) || 0,
              Subtotal:   Number(item.Subtotal) || 0,
            });
          });
          // Mark as covered so the separate tab doesn't double-add
          coveredByInlineJSON.add(invId);
        }
      } catch (e) {
        console.warn('Could not parse Invoice_Items_JSON for invoice', invId);
      }
    }

    return {
      Invoice_ID: invId,
      Date: (() => {
        const val = String(row.Date || '');
        if (val.includes('T')) return val.split('T')[0];
        if (val.length >= 10) return val.substring(0, 10);
        return val;
      })(),
      Company: resolvedCompany,
      Customer_Name: custName,
      Customer_Type: resolvedType as 'Regular' | 'New',
      Status: (row.Status === 'Pending' ? 'Pending' : 'Paid') as 'Paid' | 'Pending',
      Total_Amount: Number(row.Total_Amount) || 0,
      Discount_Type: 'none' as const,
      Discount_Value: Number(row.Discount_Value) || 0,
      Subtotal_Amount: Number(row.Subtotal_Amount) || Number(row.Total_Amount) || 0,
      Currency_Symbol: 'RM',
      Is_Past_Entry: false,
      Customer_Contact: String(row.Customer_Contact || '-'),
      Customer_Address: String(row.Customer_Address || '-'),
      Template: 'modern' as const,
      Notes: String(row.Notes || ''),
      Branch_Location: String(row.Branch_Location || '')
    };
  }).filter((inv: any) => inv.Invoice_ID);

  // ── Source B: Standalone Invoice_Items tab ────────────
  // This is the primary source for your sheet layout.
  // Only skips an invoice if Source A already covered it.
  const rawStandaloneItems: any[] = json.data?.invoice_items || [];
  console.log(`[sheetsService] Standalone invoice_items rows from sheet: ${rawStandaloneItems.length}`);

  rawStandaloneItems.forEach((row: any) => {
    const invId   = String(row.Invoice_ID || '').trim();
    const itemId  = String(row.Item_ID    || '').trim();
    const itemName = String(row.Item_Name || '').trim();

    // Skip completely blank rows
    if (!invId && !itemId) return;

    // Skip if already loaded from inline JSON for this invoice
    if (coveredByInlineJSON.has(invId)) return;

    invoice_items.push({
      Item_ID:    itemId  || `ITEM-AUTO-${Math.random().toString(36).slice(2, 7)}`,
      Invoice_ID: invId,
      Item_Name:  itemName,
      Quantity:   Number(row.Quantity) || 0,
      Price:      Number(row.Price)    || 0,
      Subtotal:   Number(row.Subtotal) || 0,
    });
  });

  console.log(`[sheetsService] Total invoice_items loaded: ${invoice_items.length}`);

  // ── Payments (partial payments) ──────────────────────────
  const rawPayments = json.data?.payments || [];
  let payments: Payment[] = rawPayments.map((row: any) => ({
    Payment_ID: String(row.Payment_ID || ''),
    Invoice_ID: String(row.Invoice_ID || ''),
    Amount:     Number(row.Amount) || 0,
    Date:       (() => {
      const v = String(row.Date || '');
      if (v.includes('T')) return v.split('T')[0];
      if (v.length >= 10) return v.substring(0, 10);
      return v;
    })(),
    Method:     String(row.Method || ''),
    Reference:  String(row.Reference || ''),
  })).filter((p: any) => p.Payment_ID && p.Invoice_ID);

  // ── Employees ────────────────────────────────────────────
  const rawEmployees = json.data?.employees || [];
  let employees: Employee[] = rawEmployees.map((row: any) => {
    // Strip any legacy ||bm: encoding from Bank_Details (old persistence hack)
    const rawBank = String(row.Bank_Details || '');
    const bmIdx = rawBank.indexOf('||bm:');
    const bankDetails = bmIdx >= 0 ? rawBank.substring(0, bmIdx) : rawBank;

    // Prefer dedicated columns (new Apps Script writes them directly).
    // Fall back to ||bm: decoded values for rows written by the old encoding.
    let citizenship: Employee['Citizenship'] = 'Malaysian/PR';
    let age: number | undefined;
    let joiningDate: string | undefined;

    if (bmIdx >= 0) {
      const meta = rawBank.substring(bmIdx + 5).split('|');
      if (meta[0]) citizenship = meta[0] === 'F' ? 'Foreigner' : 'Malaysian/PR';
      if (meta[1]) age = Number(meta[1]) || undefined;
      if (meta[2]) joiningDate = meta[2] || undefined;
    }
    // Dedicated columns win over the legacy encoding
    const rowCitizenship = String(row.Citizenship || '').trim();
    if (['Malaysian', 'PR', 'Foreigner', 'Malaysian/PR'].includes(rowCitizenship)) {
      citizenship = rowCitizenship as Employee['Citizenship'];
    }
    if (row.Age !== undefined && row.Age !== null && row.Age !== '') {
      age = Number(row.Age) || undefined;
    }
    if (row.Joining_Date) {
      joiningDate = String(row.Joining_Date);
    }

    return {
      Employee_ID:    String(row.Employee_ID || ''),
      Employee_Name:  String(row.Employee_Name || ''),
      IC_Passport:    String(row.IC_Passport || ''),
      Position:       String(row.Position || ''),
      Assigned_Outlet: resolveOutletId(row.Assigned_Outlet, '', profiles || []),
      Basic_Salary:   Number(row.Basic_Salary) || 0,
      Bank_Details:   bankDetails,
      Branch_Location:String(row.Branch_Location || ''),
      Citizenship:    citizenship,
      Age:            age,
      Joining_Date:   joiningDate,
      Employer_Bears_Statutory:
        row.Employer_Bears_Statutory === true ||
        String(row.Employer_Bears_Statutory || '').toLowerCase() === 'true',
      Pay_Basis:      row.Pay_Basis === 'anniversary' ? 'anniversary' : 'calendar',
      End_Date:       row.End_Date ? String(row.End_Date) : undefined,
      Registered_On:  row.Registered_On ? String(row.Registered_On) : undefined,
      Advances:       parseAdvances(row.Advances_JSON),
    } as Employee;
  }).filter((e: any) => e.Employee_ID);

  // ── Payslips ─────────────────────────────────────────────
  const rawPayslips = json.data?.payslips || [];
  let payslips: Payslip[] = rawPayslips.map((row: any) => {
    // Strip legacy _bm_paid entries from Deductions_JSON (old persistence hack)
    // and prefer dedicated Payment_Transferred / Transfer_Date columns.
    const rawDeductionsJSON = String(row.Deductions_JSON || '');
    let deductionsJSON = rawDeductionsJSON;
    let paymentTransferred = false;
    let transferDate: string | undefined;

    try {
      const deductions = JSON.parse(rawDeductionsJSON || '[]');
      if (Array.isArray(deductions)) {
        const payMeta = deductions.find((d: any) => '_bm_paid' in d);
        if (payMeta) {
          paymentTransferred = payMeta._bm_paid === true;
          transferDate = payMeta._bm_date || undefined;
          deductionsJSON = JSON.stringify(deductions.filter((d: any) => !('_bm_paid' in d)));
        }
      }
    } catch { /* malformed JSON — keep raw string as-is */ }

    // Dedicated columns win over the legacy encoding
    if (row.Payment_Transferred === true || String(row.Payment_Transferred || '').toLowerCase() === 'true') {
      paymentTransferred = true;
    }
    if (row.Transfer_Date) {
      transferDate = String(row.Transfer_Date);
    }
    return {
      Payslip_ID:               String(row.Payslip_ID || ''),
      Employee_ID:              String(row.Employee_ID || ''),
      Issue_Date:               String(row.Issue_Date || ''),
      Month_Year:               String(row.Month_Year || ''),
      Basic_Pay:                Number(row.Basic_Pay) || 0,
      Custom_Allowances:        Number(row.Custom_Allowances) || 0,
      Total_Allowances:         Number(row.Total_Allowances) || 0,
      Employee_EPF:             Number(row.Employee_EPF) || 0,
      Employer_EPF:             Number(row.Employer_EPF) || 0,
      Employee_SOCSO:           Number(row.Employee_SOCSO) || 0,
      Employer_SOCSO:           Number(row.Employer_SOCSO) || 0,
      Employee_EIS:             Number(row.Employee_EIS) || 0,
      Employer_EIS:             Number(row.Employer_EIS) || 0,
      Employee_SKBBK:           Number(row.Employee_SKBBK) || 0,
      Total_Statutory_Deductions: Number(row.Total_Statutory_Deductions) || 0,
      Custom_Deductions:        Number(row.Custom_Deductions) || 0,
      Final_Net_Pay:            Number(row.Final_Net_Pay) || 0,
      Branch_Location:          String(row.Branch_Location || ''),
      Is_Saved: row.Is_Saved === true || String(row.Is_Saved).toLowerCase() === 'true',
      Allowances_JSON:          String(row.Allowances_JSON || ''),
      Deductions_JSON:          deductionsJSON,
      Payment_Transferred:      paymentTransferred,
      Transfer_Date:            transferDate,
      Is_Payment_Due:      row.Is_Payment_Due === true || String(row.Is_Payment_Due || '').toLowerCase() === 'true',
      Employer_Statutory_Offset: Number(row.Employer_Statutory_Offset) || 0,
      Pay_Period:               String(row.Pay_Period || ''),
    };
  }).filter((p: any) => p.Payslip_ID);

  // ── Quotations + nested days/items ────────────────────────
  const rawQuotations = json.data?.quotations || [];
  let quotations: Quotation[] = rawQuotations.map((row: any) => ({
    Quotation_ID:       String(row.Quotation_ID || ''),
    Date:               String(row.Date || ''),
    Valid_Until:        row.Valid_Until ? String(row.Valid_Until) : undefined,
    Company:            resolveOutletId(row.Company, row.Quotation_ID, profiles || []),
    Customer_Name:      String(row.Customer_Name || ''),
    Customer_Contact:   String(row.Customer_Contact || '-'),
    Customer_Address:   String(row.Customer_Address || '-'),
    Pricing_Mode:       (row.Pricing_Mode === 'package' ? 'package' : 'itemized') as PricingMode,
    Package_Sub_Mode:   (row.Package_Sub_Mode === 'flat_total' ? 'flat_total' : row.Package_Sub_Mode === 'per_day' ? 'per_day' : undefined) as PackageSubMode | undefined,
    Flat_Package_Total: Number(row.Flat_Package_Total) || 0,
    Extra_Charges_JSON: String(row.Extra_Charges_JSON || ''),
    Discount_Type:      (row.Discount_Type as 'none' | 'percentage' | 'fixed') || 'none',
    Discount_Value:     Number(row.Discount_Value) || 0,
    Subtotal_Amount:    Number(row.Subtotal_Amount) || 0,
    Total_Amount:       Number(row.Total_Amount) || 0,
    Catering_Terms:     String(row.Catering_Terms || ''),
    Notes:              String(row.Notes || ''),
    Branch_Location:    String(row.Branch_Location || ''),
    Converted_Invoice_ID: row.Converted_Invoice_ID ? String(row.Converted_Invoice_ID) : undefined,
  })).filter((q: any) => q.Quotation_ID);

  const rawQuotationDays = json.data?.quotation_days || [];
  let quotation_days: QuotationDay[] = rawQuotationDays.map((row: any) => ({
    Day_ID:                String(row.Day_ID || ''),
    Quotation_ID:          String(row.Quotation_ID || ''),
    Event_Date:            String(row.Event_Date || ''),
    Pax:                   Number(row.Pax) || 0,
    Serving_Style:         (['Packed Bento Boxes', 'Buffet Setup', 'Dome Serving'].includes(row.Serving_Style) ? row.Serving_Style : 'Buffet Setup') as ServingStyle,
    Day_Package_Rate:      Number(row.Day_Package_Rate) || 0,
  })).filter((d: any) => d.Day_ID);

  const rawQuotationItems = json.data?.quotation_items || [];
  let quotation_items: QuotationItem[] = rawQuotationItems.map((row: any) => ({
    Item_ID:      String(row.Item_ID || ''),
    Quotation_ID: String(row.Quotation_ID || ''),
    Day_ID:       String(row.Day_ID || ''),
    Session_Label: String(row.Session_Label || ''),
    // Code.gs formats time serials (year 1899) correctly after v3.10 fix.
    // Guard here strips any lingering "1899-12-30" values from older cached data.
    Session_Time:  (() => { const t = String(row.Session_Time || ''); return t.startsWith('1899') ? '' : t; })(),
    Item_Name:    String(row.Item_Name || ''),
    Quantity:     Number(row.Quantity) || 0,
    Price:        Number(row.Price) || 0,
    Subtotal:     Number(row.Subtotal) || 0,
  })).filter((it: any) => it.Item_ID);

  // ── Branch filter (if provided) ──────────────────────────
  if (branchFilter) {
    invoices     = invoices.filter(i  => (i.Branch_Location  || '').toLowerCase() === branchFilter.toLowerCase());
    customers    = customers.filter(c  => (c.Branch_Location  || '').toLowerCase() === branchFilter.toLowerCase());
    employees    = employees.filter(e  => (e.Branch_Location  || '').toLowerCase() === branchFilter.toLowerCase());
    payslips     = payslips.filter(p   => (p.Branch_Location  || '').toLowerCase() === branchFilter.toLowerCase());
    quotations   = quotations.filter(q => (q.Branch_Location  || '').toLowerCase() === branchFilter.toLowerCase());
    // DO NOT filter invoice_items / quotation_days / quotation_items by branch —
    // they don't have Branch_Location of their own. They're linked to their
    // parent (Invoice_ID / Quotation_ID) which is already filtered above.
  }

  // ── Merge localStorage extras ──
  // The browser keeps a copy of a few fields (Citizenship, Age, Joining_Date,
  // Employer_Bears_Statutory; payslip save/payment state) until a sync lands
  // them in the sheet — syncStateToSheets then forgets them. They only fill a
  // cell the sheet has left BLANK: a filled cell was written by the server,
  // maybe from another device, and an older local copy must not overrule it.
  if (typeof window !== 'undefined') {
    try {
      ({ employees, payslips } = mergeLocalExtras(
        employees, rawEmployees, JSON.parse(localStorage.getItem(EMP_EXTRAS_KEY) || '{}'),
        payslips, rawPayslips, JSON.parse(localStorage.getItem(PS_EXTRAS_KEY) || '{}'),
      ));
    } catch {
      // localStorage unavailable or corrupt — continue without extras
    }
  }

  // ── De-duplicate on READ ─────────────────────────────────
  // Final safety net: even if the sheet still contains duplicate rows (e.g. from
  // an older build, or rows that haven't been re-synced yet), the app will never
  // DISPLAY duplicates. Keyed by the stable primary key of each record. Combined
  // with the dedupe on write in syncStateToSheets, duplicates can neither be
  // shown nor persisted.
  invoices        = dedupeByKey(invoices,        i  => String(i.Invoice_ID  || ''));
  invoice_items   = dedupeByKey(invoice_items,   invoiceItemKey);
  payments        = dedupeByKey(payments,        p  => String(p.Payment_ID  || ''));
  customers       = dedupeByKey(customers,       c  => `${String(c.Customer_Name || '').toLowerCase()}|${String(c.Branch_Location || '').toLowerCase()}`);
  employees       = dedupeByKey(employees,       e  => String(e.Employee_ID  || ''));
  payslips        = dedupeByKey(payslips,        p  => String(p.Payslip_ID   || ''));
  quotations      = dedupeByKey(quotations,      q  => String(q.Quotation_ID || ''));
  quotation_days  = dedupeByKey(quotation_days,  d  => String(d.Day_ID       || ''));
  quotation_items = dedupeByKey(quotation_items, it => String(it.Item_ID     || ''));

  const loaded = { invoices, invoice_items, payments, customers, employees, payslips, quotations, quotation_days, quotation_items };
  // Only a full load is a baseline for the next save's merge; a filtered one
  // would make every other branch look deleted.
  if (!branchFilter) remember(spreadsheetId, loaded);
  return { ...loaded, profiles: [] };
};

/** Advances_JSON cell → advances. A malformed cell reads as none rather than breaking the roster. */
function parseAdvances(raw: unknown): SalaryAdvance[] {
  try {
    const list = JSON.parse(String(raw || '[]'));
    return Array.isArray(list)
      ? list.filter(a => a && a.id && a.date && Number(a.amount) > 0)
            .map(a => ({ id: String(a.id), date: String(a.date), amount: Number(a.amount), note: a.note ? String(a.note) : undefined }))
      : [];
  } catch {
    return [];
  }
}

// ── localStorage stand-ins until a sync lands them (see the merge above) ────────
const EMP_EXTRAS_KEY = 'bizeazy_employee_extras';
const PS_EXTRAS_KEY = 'bizeazy_payslip_extras';

const isBlank = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
const gapsOnly = (extra: Record<string, any>, raw: Record<string, any> = {}) =>
  Object.fromEntries(Object.entries(extra).filter(([k]) => isBlank(raw[k])));

/** Local copies fill only the cells the sheet left blank. Pure, for the self-check. */
export function mergeLocalExtras(
  employees: Employee[], rawEmployees: any[], empExtras: Record<string, any>,
  payslips: Payslip[], rawPayslips: any[], psExtras: Record<string, any>,
): { employees: Employee[]; payslips: Payslip[] } {
  const rawEmp = new Map<string, any>(rawEmployees.map(r => [String(r.Employee_ID || ''), r]));
  const rawPs = new Map<string, any>(rawPayslips.map(r => [String(r.Payslip_ID || ''), r]));
  return {
    employees: employees.map(emp => {
      const extra = empExtras[emp.Employee_ID];
      return extra ? { ...emp, ...gapsOnly(extra, rawEmp.get(emp.Employee_ID)) } : emp;
    }),
    payslips: payslips.map(ps => {
      const extra = psExtras[ps.Payslip_ID];
      if (!extra) return ps;
      const fill: Record<string, any> = gapsOnly(extra, rawPs.get(ps.Payslip_ID));
      // Saving and paying are never undone in the app, so a local "yes" still
      // stands over a FALSE cell when the sync that would have written it failed.
      if (extra.Is_Saved === true) fill.Is_Saved = true;
      if (extra.Payment_Transferred === true) fill.Payment_Transferred = true;
      return { ...ps, ...fill };
    }),
  };
}

/** Drop the local copies for rows the sheet now holds. */
function forgetExtras(key: string, ids: string[]) {
  try {
    const all: Record<string, any> = JSON.parse(localStorage.getItem(key) || '{}');
    ids.forEach(id => { delete all[id]; });
    if (Object.keys(all).length) localStorage.setItem(key, JSON.stringify(all));
    else localStorage.removeItem(key);
  } catch {}
}
export const saveEmployeeExtras = (
  employeeId: string,
  extras: { Citizenship?: string; Age?: number; Joining_Date?: string; Employer_Bears_Statutory?: boolean }
) => {
  if (typeof window === 'undefined') return;
  try {
    const all: Record<string, any> = JSON.parse(localStorage.getItem(EMP_EXTRAS_KEY) || '{}');
    all[employeeId] = { ...(all[employeeId] || {}), ...extras };
    localStorage.setItem(EMP_EXTRAS_KEY, JSON.stringify(all));
  } catch {}
};

export const savePayslipExtras = (
  payslipId: string,
  extras: { Is_Saved?: boolean; Payment_Transferred?: boolean; Transfer_Date?: string; Employer_Statutory_Offset?: number }
) => {
  if (typeof window === 'undefined') return;
  try {
    const all: Record<string, any> = JSON.parse(localStorage.getItem(PS_EXTRAS_KEY) || '{}');
    all[payslipId] = { ...(all[payslipId] || {}), ...extras };
    localStorage.setItem(PS_EXTRAS_KEY, JSON.stringify(all));
  } catch {}
};

// ── syncStateToSheets ─────────────────────────────────────────
// ── Saving: a three-way merge ─────────────────────────────────
// A save rewrites whole tabs, and two devices can each hold a copy loaded at a
// different time. Taking either side wholesale loses work: this device's copy
// would revert what others changed since it loaded, and the sheet's would drop
// what this device just did. So each row is decided against `lastSeen`, what
// this device last loaded or saved:
//   changed or added here             → this device's row
//   untouched here                    → the sheet's row (it may be newer), or
//                                       none if another device deleted it
//   deleted here                      → gone
//   on the sheet, never seen here     → kept (added elsewhere)
// ponytail: the read-merge-write still has a window of a second or two in which
// two simultaneous saves can cross. Closing it needs per-row writes on the
// server, which is the Supabase move.
let lastSeen: { spreadsheetId: string; db: DatabaseState } | null = null;
const remember = (spreadsheetId: string, db: DatabaseState) => {
  lastSeen = { spreadsheetId, db: JSON.parse(JSON.stringify(db)) };
};

type SyncTab = 'invoices' | 'customers' | 'employees' | 'payslips' | 'invoice_items'
  | 'payments' | 'quotations' | 'quotation_days' | 'quotation_items';

const SYNC_KEYS: Record<SyncTab, (r: any) => string> = {
  invoices:        r => String(r.Invoice_ID || ''),
  customers:       r => `${String(r.Customer_Name || '').toLowerCase()}|${String(r.Branch_Location || '').toLowerCase()}`,
  employees:       r => String(r.Employee_ID || ''),
  payslips:        r => String(r.Payslip_ID || ''),
  invoice_items:   invoiceItemKey,
  payments:        r => String(r.Payment_ID || ''),
  quotations:      r => String(r.Quotation_ID || ''),
  quotation_days:  r => String(r.Day_ID || ''),
  quotation_items: r => String(r.Item_ID || '') || `${r.Quotation_ID}|${r.Day_ID}|${r.Item_Name}|${r.Quantity}|${r.Price}`,
};

/** The rule above, for one tab. Pure, for the self-check. */
export function mergeForSync<T>(local: T[], server: T[], base: T[] | null, key: (r: T) => string): T[] {
  // A tab this device holds nothing of was never loaded (or was cleared by a
  // sign-out), not emptied row by row: never read that as "delete them all".
  const seen = base && local.length ? new Map(base.map(r => [key(r), JSON.stringify(r)])) : null;
  const onSheet = new Map(server.map(r => [key(r), r]));
  const here = new Set(local.map(key));
  const out: T[] = [];
  local.forEach(row => {
    const k = key(row);
    if (k && seen?.get(k) === JSON.stringify(row)) {
      const current = onSheet.get(k);
      if (current) out.push(current);
      return;
    }
    out.push(row);
  });
  server.forEach(row => {
    const k = key(row);
    if (!k || here.has(k) || seen?.has(k)) return;
    out.push(row);
  });
  return out;
}

/** In-memory records → the rows syncData writes. */
function formatForSheet(db: DatabaseState, profiles: CompanyProfile[] | undefined, targetBranch: string): Record<SyncTab, any[]> {
  const currentInvoicesFormatted = db.invoices.map(inv => {
    let companyName: string = inv.Company;
    if (profiles) {
      const match = profiles.find(p => p.id === inv.Company);
      if (match) companyName = outletLabel(match);
    }
    const matchingItems = db.invoice_items?.filter(item => item.Invoice_ID === inv.Invoice_ID) || [];
    return {
      Invoice_ID: inv.Invoice_ID, Date: inv.Date, Company: companyName,
      Customer_Name: inv.Customer_Name, Status: inv.Status,
      Total_Amount: inv.Total_Amount, Discount_Value: inv.Discount_Value || 0,
      Subtotal_Amount: inv.Subtotal_Amount || inv.Total_Amount,
      Notes: inv.Notes || '', Customer_Contact: inv.Customer_Contact || '-',
      Customer_Address: inv.Customer_Address || '-',
      // Preserve each row's own branch (db holds ALL branches). Only fall back
      // to the active branch for brand-new rows that have no branch yet.
      Branch_Location: inv.Branch_Location || targetBranch,
      Invoice_Items_JSON: JSON.stringify(matchingItems)
    };
  });

  const currentCustomersFormatted = db.customers.map(cust => ({
    Customer_Name: cust.Customer_Name, Contact: cust.Contact || '-',
    Customer_Type: cust.Customer_Type || 'Regular', Address: cust.Address || '-',
    Branch_Location: cust.Branch_Location || targetBranch
  }));

  const currentEmployeesFormatted = db.employees?.map(emp => ({
    Employee_ID: emp.Employee_ID, Employee_Name: emp.Employee_Name,
    IC_Passport: emp.IC_Passport, Position: emp.Position,
    Assigned_Outlet: emp.Assigned_Outlet, Basic_Salary: emp.Basic_Salary,
    Bank_Details: emp.Bank_Details || '',
    Branch_Location: emp.Branch_Location || targetBranch,
    Citizenship: emp.Citizenship || 'Malaysian/PR',
    Age: emp.Age !== undefined ? emp.Age : '',
    Joining_Date: emp.Joining_Date || '',
    Employer_Bears_Statutory: emp.Employer_Bears_Statutory || false,
    Pay_Basis: emp.Pay_Basis || 'calendar',
    End_Date: emp.End_Date || '',
    Registered_On: emp.Registered_On || '',
    Advances_JSON: emp.Advances?.length ? JSON.stringify(emp.Advances) : '',
  })) || [];

  const currentPayslipsFormatted = db.payslips?.map(ps => {
    // Strip any legacy _bm_paid entries from Deductions_JSON before saving
    let deductionsArr: any[] = [];
    try { deductionsArr = JSON.parse(ps.Deductions_JSON || '[]').filter((d: any) => !('_bm_paid' in d)); } catch { /* keep empty */ }
    return {
      Payslip_ID: ps.Payslip_ID, Employee_ID: ps.Employee_ID,
      Issue_Date: ps.Issue_Date, Month_Year: ps.Month_Year,
      Basic_Pay: ps.Basic_Pay, Custom_Allowances: ps.Custom_Allowances,
      Total_Allowances: ps.Total_Allowances, Employee_EPF: ps.Employee_EPF,
      Employer_EPF: ps.Employer_EPF, Employee_SOCSO: ps.Employee_SOCSO,
      Employer_SOCSO: ps.Employer_SOCSO, Employee_EIS: ps.Employee_EIS,
      Employer_EIS: ps.Employer_EIS, Employee_SKBBK: ps.Employee_SKBBK || 0,
      Total_Statutory_Deductions: ps.Total_Statutory_Deductions,
      Custom_Deductions: ps.Custom_Deductions, Final_Net_Pay: ps.Final_Net_Pay,
      Branch_Location: ps.Branch_Location || targetBranch, Is_Saved: ps.Is_Saved,
      Allowances_JSON: ps.Allowances_JSON || '',
      Deductions_JSON: JSON.stringify(deductionsArr),
      Payment_Transferred: ps.Payment_Transferred || false,
      Transfer_Date: ps.Transfer_Date || '',
      Is_Payment_Due: ps.Is_Payment_Due || false,
      Employer_Statutory_Offset: ps.Employer_Statutory_Offset || 0,
      Pay_Period: ps.Pay_Period || '',
    };
  }) || [];

  // Also send the invoice_items as a flat array for the separate sheet tab
  const currentItemsFormatted = db.invoice_items?.map(item => ({
    Item_ID: item.Item_ID, Invoice_ID: item.Invoice_ID, Item_Name: item.Item_Name,
    Quantity: item.Quantity, Price: item.Price, Subtotal: item.Subtotal
  })) || [];

  // Payments ride along via Invoice_ID (no Branch_Location of their own), same
  // as invoice_items — the in-memory array already spans every branch.
  const currentPaymentsFormatted = db.payments?.map(p => ({
    Payment_ID: p.Payment_ID, Invoice_ID: p.Invoice_ID, Amount: p.Amount,
    Date: p.Date || '', Method: p.Method || '', Reference: p.Reference || '',
  })) || [];

  const currentQuotationsFormatted = db.quotations?.map(q => ({
    Quotation_ID: q.Quotation_ID, Date: q.Date, Valid_Until: q.Valid_Until || '',
    Company: q.Company, Customer_Name: q.Customer_Name,
    Customer_Contact: q.Customer_Contact || '-', Customer_Address: q.Customer_Address || '-',
    Pricing_Mode: q.Pricing_Mode, Package_Sub_Mode: q.Package_Sub_Mode || '',
    Flat_Package_Total: q.Flat_Package_Total || 0,
    Extra_Charges_JSON: q.Extra_Charges_JSON || '',
    Discount_Type: q.Discount_Type || 'none', Discount_Value: q.Discount_Value || 0,
    Subtotal_Amount: q.Subtotal_Amount || q.Total_Amount,
    Total_Amount: q.Total_Amount,
    Catering_Terms: q.Catering_Terms || '', Notes: q.Notes || '',
    Branch_Location: q.Branch_Location || targetBranch,
    Converted_Invoice_ID: q.Converted_Invoice_ID || '',
  })) || [];

  // quotation_days / quotation_items have no Branch_Location of their own — they ride
  // along via their parent Quotation_ID, so the in-memory arrays already span every
  // branch and are sent as-is (same approach already used for invoice_items above).
  const currentQuotationDaysFormatted = db.quotation_days?.map(d => ({
    Day_ID: d.Day_ID, Quotation_ID: d.Quotation_ID, Event_Date: d.Event_Date,
    Pax: d.Pax, Serving_Style: d.Serving_Style, Day_Package_Rate: d.Day_Package_Rate || 0,
  })) || [];

  const currentQuotationItemsFormatted = db.quotation_items?.map(it => ({
    Item_ID: it.Item_ID, Quotation_ID: it.Quotation_ID, Day_ID: it.Day_ID,
    Session_Label: it.Session_Label || '', Session_Time: it.Session_Time || '',
    Item_Name: it.Item_Name, Quantity: it.Quantity, Price: it.Price, Subtotal: it.Subtotal,
  })) || [];

  return {
    invoices: currentInvoicesFormatted, customers: currentCustomersFormatted,
    employees: currentEmployeesFormatted, payslips: currentPayslipsFormatted,
    invoice_items: currentItemsFormatted, payments: currentPaymentsFormatted,
    quotations: currentQuotationsFormatted, quotation_days: currentQuotationDaysFormatted,
    quotation_items: currentQuotationItemsFormatted,
  };
}

/** Sheet rows → the same shape, decoding the legacy encodings old builds wrote. */
function normalizeSheetRows(data: any): Record<SyncTab, any[]> {
  const employees = (data.employees || []).map((e: any) => {
    // Prefer dedicated columns, fall back to ||bm: for old data
    const rawBank = String(e.Bank_Details || '');
    const bmIdx = rawBank.indexOf('||bm:');
    const cleanBank = bmIdx >= 0 ? rawBank.substring(0, bmIdx) : rawBank;

    let citizenship = 'Malaysian/PR';
    let age: number | string = '';
    let joiningDate = '';

    if (bmIdx >= 0) {
      const meta = rawBank.substring(bmIdx + 5).split('|');
      if (meta[0]) citizenship = meta[0] === 'F' ? 'Foreigner' : 'Malaysian/PR';
      if (meta[1]) age = Number(meta[1]) || '';
      if (meta[2]) joiningDate = meta[2];
    }
    if (String(e.Citizenship || '').trim()) citizenship = String(e.Citizenship).trim();
    if (e.Age !== undefined && e.Age !== null && e.Age !== '') age = Number(e.Age) || '';
    if (e.Joining_Date) joiningDate = String(e.Joining_Date);

    return {
      Employee_ID: e.Employee_ID || '', Employee_Name: e.Employee_Name || '',
      IC_Passport: e.IC_Passport || '', Position: e.Position || '',
      Assigned_Outlet: e.Assigned_Outlet || '', Basic_Salary: e.Basic_Salary || 0,
      Bank_Details: cleanBank,
      Branch_Location: e.Branch_Location || '',
      Citizenship: citizenship,
      Age: age,
      Joining_Date: joiningDate,
      Employer_Bears_Statutory: e.Employer_Bears_Statutory === true || String(e.Employer_Bears_Statutory || '').toLowerCase() === 'true',
      // Passed through untouched: the sync rewrites the whole tab, so a column
      // missing here is a column erased from every row this device did not edit.
      Pay_Basis: e.Pay_Basis || '', End_Date: e.End_Date || '',
      Registered_On: e.Registered_On || '', Advances_JSON: e.Advances_JSON || '',
    };
  });

  const payslips = (data.payslips || []).map((p: any) => {
    // Strip legacy _bm_paid, prefer dedicated columns
    let deductionsArr: any[] = [];
    let isPaid = p.Payment_Transferred === true || String(p.Payment_Transferred || '').toLowerCase() === 'true';
    let transferDate = p.Transfer_Date || '';
    try {
      const parsed = JSON.parse(p.Deductions_JSON || '[]');
      if (Array.isArray(parsed)) {
        const payMeta = parsed.find((d: any) => '_bm_paid' in d);
        if (payMeta && !isPaid) {
          isPaid = payMeta._bm_paid === true;
          if (!transferDate) transferDate = payMeta._bm_date || '';
        }
        deductionsArr = parsed.filter((d: any) => !('_bm_paid' in d));
      }
    } catch { /* keep empty */ }
    return {
      Payslip_ID: p.Payslip_ID || '', Employee_ID: p.Employee_ID || '',
      Issue_Date: p.Issue_Date || '', Month_Year: p.Month_Year || '',
      Basic_Pay: p.Basic_Pay || 0, Custom_Allowances: p.Custom_Allowances || 0,
      Total_Allowances: p.Total_Allowances || 0, Employee_EPF: p.Employee_EPF || 0,
      Employer_EPF: p.Employer_EPF || 0, Employee_SOCSO: p.Employee_SOCSO || 0,
      Employer_SOCSO: p.Employer_SOCSO || 0, Employee_EIS: p.Employee_EIS || 0,
      Employer_EIS: p.Employer_EIS || 0, Employee_SKBBK: p.Employee_SKBBK || 0,
      Total_Statutory_Deductions: p.Total_Statutory_Deductions || 0,
      Custom_Deductions: p.Custom_Deductions || 0, Final_Net_Pay: p.Final_Net_Pay || 0,
      Branch_Location: p.Branch_Location || '', Is_Saved: p.Is_Saved || false,
      Allowances_JSON: p.Allowances_JSON || '',
      Deductions_JSON: JSON.stringify(deductionsArr),
      Payment_Transferred: isPaid,
      Transfer_Date: transferDate, Is_Payment_Due: false,
      Employer_Statutory_Offset: Number(p.Employer_Statutory_Offset) || 0,
      Pay_Period: p.Pay_Period || '',
    };
  });

  const quotations = (data.quotations || []).map((q: any) => ({
    Quotation_ID: q.Quotation_ID || '', Date: q.Date || '', Valid_Until: q.Valid_Until || '',
    Company: q.Company || '', Customer_Name: q.Customer_Name || '',
    Customer_Contact: q.Customer_Contact || '-', Customer_Address: q.Customer_Address || '-',
    Pricing_Mode: q.Pricing_Mode || 'itemized', Package_Sub_Mode: q.Package_Sub_Mode || '',
    Flat_Package_Total: q.Flat_Package_Total || 0,
    Extra_Charges_JSON: q.Extra_Charges_JSON || '',
    Discount_Type: q.Discount_Type || 'none', Discount_Value: q.Discount_Value || 0,
    Subtotal_Amount: q.Subtotal_Amount || q.Total_Amount || 0,
    Total_Amount: q.Total_Amount || 0,
    Catering_Terms: q.Catering_Terms || '', Notes: q.Notes || '',
    Branch_Location: q.Branch_Location || '',
    Converted_Invoice_ID: q.Converted_Invoice_ID || '',
  }));

  return {
    invoices: data.invoices || [], customers: data.customers || [],
    employees, payslips,
    invoice_items: data.invoice_items || [], payments: data.payments || [],
    quotations,
    quotation_days: data.quotation_days || [], quotation_items: data.quotation_items || [],
  };
}

export const syncStateToSheets = async (
  spreadsheetId: string,
  token: string,
  db: DatabaseState,
  profiles?: CompanyProfile[],
  activeBranchLocation?: string
): Promise<void> => {
  // Only fills Branch_Location on a brand-new row that has none yet.
  const targetBranch = activeBranchLocation || 'A1 Bistro';

  // The sheet as it is right now. Without it the merge cannot tell a row
  // deleted elsewhere from one never seen, so a failed read stops the save.
  let data: any;
  try {
    data = await gasGet({ action: 'fetchDataAll', spreadsheetId });
  } catch (err: any) {
    throw new Error(`Could not read the sheet before saving, so nothing was written: ${err?.message || err}`);
  }

  const onSheet = normalizeSheetRows(data || {});
  const here = formatForSheet(db, profiles, targetBranch);
  const base = lastSeen && lastSeen.spreadsheetId === spreadsheetId
    ? formatForSheet(lastSeen.db, profiles, targetBranch) : null;

  const merged = {} as Record<SyncTab, any[]>;
  (Object.keys(SYNC_KEYS) as SyncTab[]).forEach(tab => {
    merged[tab] = dedupeByKey(mergeForSync(here[tab], onSheet[tab], base ? base[tab] : null, SYNC_KEYS[tab]), SYNC_KEYS[tab]);
  });

  await gasPost({ action: 'syncData', spreadsheetId, db: merged });
  remember(spreadsheetId, db);

  // The sheet now holds every employee and payslip just sent, so their local
  // stand-ins are spent and could only go stale. Kept if this user cannot write
  // payroll: the server dropped those rows, and the copies are all there is.
  if (typeof window !== 'undefined' && can(loadSession(), 'payroll')) {
    forgetExtras(EMP_EXTRAS_KEY, merged.employees.map((r: any) => String(r.Employee_ID || '')));
    forgetExtras(PS_EXTRAS_KEY, merged.payslips.map((r: any) => String(r.Payslip_ID || '')));
  }
};

// ── App config helpers ────────────────────────────────────────
export const fetchAppConfigFromAppsScript = async (): Promise<any> =>
  gasGet({ action: 'getConfig' });

export const saveAppConfigToAppsScript = async (config: any): Promise<void> => {
  await gasPost({ action: 'saveConfig', config });
};
