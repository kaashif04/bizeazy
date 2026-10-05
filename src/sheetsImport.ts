/**
 * sheetsImport.ts — reads a Google Sheets export into the app's records.
 *
 * Used once per company, when moving from the Apps Script backend to Supabase:
 * exportForBizEazy() in Code.gs writes every tab as JSON, and this turns those
 * rows into the same shapes the app saves — decoding every legacy encoding the
 * old builds left in the sheet (||bm: bank suffixes, _bm_paid deduction rows,
 * inline Invoice_Items_JSON, 1899 time serials, branch names instead of ids).
 */
import {
  DatabaseState, Invoice, InvoiceItem, Payment,
  Customer, CompanyProfile, Employee, Payslip, SalaryAdvance,
  Quotation, QuotationDay, QuotationItem, PricingMode, PackageSubMode, ServingStyle
} from './types';
import { resolveOutletId } from './utils/outlets';
import { normaliseMonthLabel } from './utils/notifications';

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

/** The export's tabs (Apps Script fetchDataAll output) → records. */
export function parseSheetExport(data: any, profiles: CompanyProfile[]): DatabaseState {
  const json = { data: data || {} };

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

  // ── Merge this browser's leftover local copies ──
  // The Sheets build kept a few fields (Citizenship, Age, Joining_Date,
  // Employer_Bears_Statutory; payslip save/payment state) in localStorage until
  // a sync landed them. Any that never landed are carried over here, so the
  // import misses nothing; they only fill cells the sheet left BLANK.
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

  // Sheets turned some "September 2026" cells into dates; the app matches payslips
  // by the label, so bring every one back to it.
  payslips = payslips.map(p => ({ ...p, Month_Year: normaliseMonthLabel(p.Month_Year) }));

  // ── De-duplicate ─────────────────────────────────────────
  // Older builds left duplicate rows in some sheets; each record is imported once.
  invoices        = dedupeByKey(invoices,        i  => String(i.Invoice_ID  || ''));
  invoice_items   = dedupeByKey(invoice_items,   invoiceItemKey);
  payments        = dedupeByKey(payments,        p  => String(p.Payment_ID  || ''));
  customers       = dedupeByKey(customers,       c  => `${String(c.Customer_Name || '').toLowerCase()}|${String(c.Branch_Location || '').toLowerCase()}`);
  employees       = dedupeByKey(employees,       e  => String(e.Employee_ID  || ''));
  payslips        = dedupeByKey(payslips,        p  => String(p.Payslip_ID   || ''));
  quotations      = dedupeByKey(quotations,      q  => String(q.Quotation_ID || ''));
  quotation_days  = dedupeByKey(quotation_days,  d  => String(d.Day_ID       || ''));
  quotation_items = dedupeByKey(quotation_items, it => String(it.Item_ID     || ''));

  return { invoices, invoice_items, payments, customers, employees, payslips, quotations, quotation_days, quotation_items };
}

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

// ── This browser's leftover local copies ──
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

