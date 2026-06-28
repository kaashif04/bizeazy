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

import { initializeApp } from 'firebase/app';
import {
  getAuth, signInWithPopup, GoogleAuthProvider,
  onAuthStateChanged, User, signOut
} from 'firebase/auth';
import {
  DatabaseState, Invoice, InvoiceItem,
  Customer, CompanyProfile, Employee, Payslip,
  Quotation, QuotationDay, QuotationItem, PricingMode, PackageSubMode, ServingStyle
} from './types';
import firebaseConfig from '../firebase-applet-config.json';

// ── Firebase init ─────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/spreadsheets');

let isSigningIn = false;
let cachedAccessToken: string | null =
  typeof window !== 'undefined'
    ? localStorage.getItem('connected_google_access_token')
    : null;

// ── Auth ──────────────────────────────────────────────────────
export const initAuth = (
  onAuthSuccess: (user: User, token: string) => void,
  onAuthFailure: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      const storedToken =
        typeof window !== 'undefined'
          ? localStorage.getItem('connected_google_access_token')
          : null;
      if (storedToken) {
        cachedAccessToken = storedToken;
        onAuthSuccess(user, storedToken);
      } else if (cachedAccessToken) {
        onAuthSuccess(user, cachedAccessToken);
      } else {
        onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (typeof window !== 'undefined') {
        localStorage.removeItem('connected_google_access_token');
      }
      onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to retrieve Google Sheets access token back from auth provider.');
    }
    cachedAccessToken = credential.accessToken;
    if (typeof window !== 'undefined') {
      localStorage.setItem('connected_google_access_token', cachedAccessToken);
    }
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Sign-in error details: ', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => cachedAccessToken;

export const logout = async () => {
  await signOut(auth);
  cachedAccessToken = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem('connected_google_access_token');
  }
};

// ── Row mappers ───────────────────────────────────────────────
const mapInvoicesToRows = (invoices: Invoice[], profiles?: CompanyProfile[]): any[][] => {
  return invoices.map(i => {
    let companyName: string = i.Company;
    if (profiles) {
      const match = profiles.find(p => p.id === i.Company);
      if (match?.store_name) companyName = match.store_name;
      else if (match?.name) companyName = match.name;
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

const isMissingSheetError = (errorMsg: string): boolean => {
  const l = errorMsg.toLowerCase();
  return l.includes('unable to parse') || l.includes('not found') || l.includes('range');
};

// ── initializeSheetsDatabase ──────────────────────────────────
export const initializeSheetsDatabase = async (
  spreadsheetId: string, token: string
): Promise<boolean> => {
  try {
    const payload = { action: 'initializeDatabase', spreadsheetId };
    const savedApiUrl = getApiUrl();
    const response = await fetch(
      `${savedApiUrl}?action=initializeDatabase&spreadsheetId=${encodeURIComponent(spreadsheetId)}`,
      {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) throw new Error('Sync failed: ' + response.statusText);
    const json = await response.json();
    return !!json.success;
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
  const url = `${getApiUrl()}?action=fetchDataAll&spreadsheetId=${spreadsheetId}&t=${new Date().getTime()}`;

  const res = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error(`Google Sheets Fetch Error: ${res.statusText}`);

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err: any) {
    console.error('Raw response from fetchDataAll:', text);
    throw new Error(`Google Sheets Fetch Error: Invalid JSON. ${err.message}`);
  }

  if (!json?.success) {
    throw new Error(json?.error || 'Google Sheets Fetch Error: Web app reported failure.');
  }

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
  const invoice_items: InvoiceItem[] = [];
  // Track which Invoice_IDs got items from the inline JSON column
  const coveredByInlineJSON = new Set<string>();

  let invoices: Invoice[] = rawInvoices.map((row: any) => {
    const custName = String(row.Customer_Name || '');
    const matchedCustomer = customers.find(
      c => (c.Customer_Name || '').toLowerCase() === custName.toLowerCase()
    );
    const resolvedType = matchedCustomer ? matchedCustomer.Customer_Type : 'Regular';

    let resolvedCompany: 'Bistro' | 'Nasi Kandar' = 'Bistro';
    const rowComp = String(row.Company || '').trim().toLowerCase();
    const invId = String(row.Invoice_ID || '');

    if (profiles && profiles.length > 0) {
      const bProfile = profiles.find(p => p.id === 'Bistro');
      const nkProfile = profiles.find(p => p.id === 'Nasi Kandar');
      const bPrefix = bProfile?.series_format || 'BIS';
      const nkPrefix = nkProfile?.series_format || 'NK';

      if (
        invId.startsWith(bPrefix) || invId.startsWith('LEG-BIS') ||
        rowComp === (bProfile?.store_name || '').trim().toLowerCase() ||
        rowComp === (bProfile?.name || '').trim().toLowerCase()
      ) {
        resolvedCompany = 'Bistro';
      } else if (
        invId.startsWith(nkPrefix) || invId.startsWith('LEG-NK') ||
        rowComp === (nkProfile?.store_name || '').trim().toLowerCase() ||
        rowComp === (nkProfile?.name || '').trim().toLowerCase()
      ) {
        resolvedCompany = 'Nasi Kandar';
      } else {
        resolvedCompany = (
          invId.includes('NK') || rowComp === 'nasi kandar' ||
          rowComp.indexOf('nasi') !== -1
        ) ? 'Nasi Kandar' : 'Bistro';
      }
    } else {
      if (
        invId.includes('NK') || invId.startsWith('LEG-NK') ||
        rowComp === 'nasi kandar' || rowComp.indexOf('nasi') !== -1
      ) {
        resolvedCompany = 'Nasi Kandar';
      }
    }

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

  // ── Employees ────────────────────────────────────────────
  const rawEmployees = json.data?.employees || [];
  let employees: Employee[] = rawEmployees.map((row: any) => {
    // Strip any legacy ||bm: encoding from Bank_Details (old persistence hack)
    const rawBank = String(row.Bank_Details || '');
    const bmIdx = rawBank.indexOf('||bm:');
    const bankDetails = bmIdx >= 0 ? rawBank.substring(0, bmIdx) : rawBank;

    // Prefer dedicated columns (new Apps Script writes them directly).
    // Fall back to ||bm: decoded values for rows written by the old encoding.
    let citizenship: 'Malaysian/PR' | 'Foreigner' = 'Malaysian/PR';
    let age: number | undefined;
    let joiningDate: string | undefined;

    if (bmIdx >= 0) {
      const meta = rawBank.substring(bmIdx + 5).split('|');
      if (meta[0]) citizenship = (meta[0] === 'F' ? 'Foreigner' : 'Malaysian/PR') as 'Malaysian/PR' | 'Foreigner';
      if (meta[1]) age = Number(meta[1]) || undefined;
      if (meta[2]) joiningDate = meta[2] || undefined;
    }
    // Dedicated columns win over the legacy encoding
    const rowCitizenship = String(row.Citizenship || '').trim();
    if (rowCitizenship === 'Foreigner' || rowCitizenship === 'Malaysian/PR') {
      citizenship = rowCitizenship as 'Malaysian/PR' | 'Foreigner';
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
      Assigned_Outlet:(row.Assigned_Outlet === 'Nasi Kandar' ? 'Nasi Kandar' : 'Bistro') as 'Bistro' | 'Nasi Kandar',
      Basic_Salary:   Number(row.Basic_Salary) || 0,
      Bank_Details:   bankDetails,
      Branch_Location:String(row.Branch_Location || ''),
      Citizenship:    citizenship,
      Age:            age,
      Joining_Date:   joiningDate,
    };
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
    };
  }).filter((p: any) => p.Payslip_ID);

  // ── Quotations + nested days/items ────────────────────────
  const rawQuotations = json.data?.quotations || [];
  let quotations: Quotation[] = rawQuotations.map((row: any) => ({
    Quotation_ID:       String(row.Quotation_ID || ''),
    Date:               String(row.Date || ''),
    Valid_Until:        row.Valid_Until ? String(row.Valid_Until) : undefined,
    Company:            (row.Company === 'Nasi Kandar' ? 'Nasi Kandar' : 'Bistro') as 'Bistro' | 'Nasi Kandar',
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
    Session_Time:  String(row.Session_Time || ''),
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

  // ── Merge localStorage extras (fields not persisted by the Apps Script) ──
  // Citizenship, Age, Joining_Date, Payment_Transferred, Transfer_Date are not
  // columns in the current Google Sheet schema.  We save them locally so they
  // survive a "Refresh Data" without requiring any Apps Script changes.
  if (typeof window !== 'undefined') {
    try {
      const empExtras: Record<string, any> = JSON.parse(localStorage.getItem('bizeazy_employee_extras') || '{}');
      employees = employees.map(emp => {
        const extra = empExtras[emp.Employee_ID];
        return extra ? { ...emp, ...extra } : emp;
      });

      const psExtras: Record<string, any> = JSON.parse(localStorage.getItem('bizeazy_payslip_extras') || '{}');
      payslips = payslips.map(ps => {
        const extra = psExtras[ps.Payslip_ID];
        return extra ? { ...ps, ...extra } : ps;
      });
    } catch {
      // localStorage unavailable or corrupt — continue without extras
    }
  }

  return { invoices, invoice_items, customers, employees, payslips, quotations, quotation_days, quotation_items, profiles: [] };
};

// ── localStorage helpers for fields not yet in the Apps Script schema ────────
export const saveEmployeeExtras = (
  employeeId: string,
  extras: { Citizenship?: string; Age?: number; Joining_Date?: string }
) => {
  if (typeof window === 'undefined') return;
  try {
    const all: Record<string, any> = JSON.parse(localStorage.getItem('bizeazy_employee_extras') || '{}');
    all[employeeId] = { ...(all[employeeId] || {}), ...extras };
    localStorage.setItem('bizeazy_employee_extras', JSON.stringify(all));
  } catch {}
};

export const savePayslipExtras = (
  payslipId: string,
  extras: { Payment_Transferred?: boolean; Transfer_Date?: string }
) => {
  if (typeof window === 'undefined') return;
  try {
    const all: Record<string, any> = JSON.parse(localStorage.getItem('bizeazy_payslip_extras') || '{}');
    all[payslipId] = { ...(all[payslipId] || {}), ...extras };
    localStorage.setItem('bizeazy_payslip_extras', JSON.stringify(all));
  } catch {}
};

// ── syncStateToSheets ─────────────────────────────────────────
export const syncStateToSheets = async (
  spreadsheetId: string,
  token: string,
  db: DatabaseState,
  profiles?: CompanyProfile[],
  activeBranchLocation?: string
): Promise<void> => {
  let allInvoices: any[]   = [];
  let allCustomers: any[]  = [];
  let allEmployees: any[]  = [];
  let allPayslips: any[]   = [];
  let allQuotations: any[] = [];

  const targetBranch = activeBranchLocation || 'A1 Bistro';

  // Fetch current sheet state for non-destructive merge
  try {
    const url = `${getApiUrl()}?action=fetchDataAll&spreadsheetId=${spreadsheetId}&t=${new Date().getTime()}`;
    const res = await fetch(url);
    if (res.ok) {
      const json = await res.json();
      if (json?.success) {
        allInvoices   = json.data?.invoices    || [];
        allCustomers  = json.data?.customers   || [];
        allEmployees  = json.data?.employees   || [];
        allPayslips   = json.data?.payslips    || [];
        allQuotations = json.data?.quotations  || [];
      }
    }
  } catch (err) {
    console.warn('Could not fetch old sheet records for merge:', err);
  }

  const otherInvoices   = allInvoices.filter(i  => (i.Branch_Location  || '').toLowerCase() !== targetBranch.toLowerCase());
  const otherCustomers  = allCustomers.filter(c  => (c.Branch_Location  || '').toLowerCase() !== targetBranch.toLowerCase());
  const otherEmployees  = allEmployees.filter(e  => (e.Branch_Location  || '').toLowerCase() !== targetBranch.toLowerCase());
  const otherPayslips   = allPayslips.filter(p   => (p.Branch_Location  || '').toLowerCase() !== targetBranch.toLowerCase());
  const otherQuotations = allQuotations.filter(q => (q.Branch_Location || '').toLowerCase() !== targetBranch.toLowerCase());

  const currentInvoicesFormatted = db.invoices.map(inv => {
    let companyName: string = inv.Company;
    if (profiles) {
      const match = profiles.find(p => p.id === inv.Company);
      if (match?.store_name) companyName = match.store_name;
      else if (match?.name) companyName = match.name;
    }
    const matchingItems = db.invoice_items?.filter(item => item.Invoice_ID === inv.Invoice_ID) || [];
    return {
      Invoice_ID: inv.Invoice_ID, Date: inv.Date, Company: companyName,
      Customer_Name: inv.Customer_Name, Status: inv.Status,
      Total_Amount: inv.Total_Amount, Discount_Value: inv.Discount_Value || 0,
      Subtotal_Amount: inv.Subtotal_Amount || inv.Total_Amount,
      Notes: inv.Notes || '', Customer_Contact: inv.Customer_Contact || '-',
      Customer_Address: inv.Customer_Address || '-', Branch_Location: targetBranch,
      Invoice_Items_JSON: JSON.stringify(matchingItems)
    };
  });

  const currentCustomersFormatted = db.customers.map(cust => ({
    Customer_Name: cust.Customer_Name, Contact: cust.Contact || '-',
    Customer_Type: cust.Customer_Type || 'Regular', Address: cust.Address || '-',
    Branch_Location: targetBranch
  }));

  const currentEmployeesFormatted = db.employees?.map(emp => ({
    Employee_ID: emp.Employee_ID, Employee_Name: emp.Employee_Name,
    IC_Passport: emp.IC_Passport, Position: emp.Position,
    Assigned_Outlet: emp.Assigned_Outlet, Basic_Salary: emp.Basic_Salary,
    Bank_Details: emp.Bank_Details || '',
    Branch_Location: targetBranch,
    Citizenship: emp.Citizenship || 'Malaysian/PR',
    Age: emp.Age !== undefined ? emp.Age : '',
    Joining_Date: emp.Joining_Date || '',
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
      Employer_EIS: ps.Employer_EIS, Total_Statutory_Deductions: ps.Total_Statutory_Deductions,
      Custom_Deductions: ps.Custom_Deductions, Final_Net_Pay: ps.Final_Net_Pay,
      Branch_Location: targetBranch, Is_Saved: ps.Is_Saved,
      Allowances_JSON: ps.Allowances_JSON || '',
      Deductions_JSON: JSON.stringify(deductionsArr),
      Payment_Transferred: ps.Payment_Transferred || false,
      Transfer_Date: ps.Transfer_Date || '',
      Is_Payment_Due: ps.Is_Payment_Due || false,
    };
  }) || [];

  // Also send the invoice_items as a flat array for the separate sheet tab
  const currentItemsFormatted = db.invoice_items?.map(item => ({
    Item_ID: item.Item_ID, Invoice_ID: item.Invoice_ID, Item_Name: item.Item_Name,
    Quantity: item.Quantity, Price: item.Price, Subtotal: item.Subtotal
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
    Branch_Location: targetBranch,
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

  // Normalise other-branch rows so they have the same keys as the current-branch rows.
  // This matters because some Apps Scripts derive sheet column headers from the first row
  // in the array.  By putting currentBranch first and filling missing keys on otherBranch
  // rows, every row has an identical schema and no column gets silently dropped.
  const normalizedOtherEmployees = otherEmployees.map((e: any) => {
    // Decode other-branch rows: prefer dedicated columns, fall back to ||bm: for old data
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
      Assigned_Outlet: e.Assigned_Outlet || 'Bistro', Basic_Salary: e.Basic_Salary || 0,
      Bank_Details: cleanBank,
      Branch_Location: e.Branch_Location || '',
      Citizenship: citizenship,
      Age: age,
      Joining_Date: joiningDate,
    };
  });

  const normalizedOtherPayslips = otherPayslips.map((p: any) => {
    // Decode other-branch rows: strip legacy _bm_paid, prefer dedicated columns
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
      Employer_EIS: p.Employer_EIS || 0,
      Total_Statutory_Deductions: p.Total_Statutory_Deductions || 0,
      Custom_Deductions: p.Custom_Deductions || 0, Final_Net_Pay: p.Final_Net_Pay || 0,
      Branch_Location: p.Branch_Location || '', Is_Saved: p.Is_Saved || false,
      Allowances_JSON: p.Allowances_JSON || '',
      Deductions_JSON: JSON.stringify(deductionsArr),
      Payment_Transferred: isPaid,
      Transfer_Date: transferDate, Is_Payment_Due: false,
    };
  });

  const normalizedOtherQuotations = otherQuotations.map((q: any) => ({
    Quotation_ID: q.Quotation_ID || '', Date: q.Date || '', Valid_Until: q.Valid_Until || '',
    Company: q.Company || 'Bistro', Customer_Name: q.Customer_Name || '',
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

  const payload = {
    action: 'syncData',
    spreadsheetId,
    db: {
      // Current-branch rows go FIRST so Apps Scripts that derive column headers from
      // the first row will always see the full schema including new fields.
      invoices:        [...currentInvoicesFormatted,   ...otherInvoices],
      customers:       [...currentCustomersFormatted,  ...otherCustomers],
      employees:       [...currentEmployeesFormatted,  ...normalizedOtherEmployees],
      payslips:        [...currentPayslipsFormatted,   ...normalizedOtherPayslips],
      invoice_items:   currentItemsFormatted,
      quotations:      [...currentQuotationsFormatted, ...normalizedOtherQuotations],
      quotation_days:  currentQuotationDaysFormatted,
      quotation_items: currentQuotationItemsFormatted,
    }
  };

  const savedApiUrl = getApiUrl();
  const response = await fetch(
    `${savedApiUrl}?action=syncData&spreadsheetId=${encodeURIComponent(spreadsheetId)}`,
    {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Apps Script Sync Error:', errorText);
    throw new Error('Sync failed: ' + response.statusText);
  }

  const json = await response.json();
  if (!json?.success) {
    throw new Error((json?.error) || 'Failed to save via Apps Script.');
  }
};

// ── API URL helpers ───────────────────────────────────────────
export const DEFAULT_API_URL =
  'https://script.google.com/macros/s/AKfycbwvv6xIpTxH8U3QvPfIZGuRzXfBm-k4bLCVIx_TF5c6qdtVlnhGobUivjwh4gQ9Dnuxyw/exec';

export const getApiUrl = (): string => {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('gas_api_url');
    if (stored?.trim()) return stored.trim();
  }
  return DEFAULT_API_URL;
};

export const setApiUrl = (url: string) => {
  if (typeof window !== 'undefined') {
    if (url?.trim()) localStorage.setItem('gas_api_url', url.trim());
    else localStorage.removeItem('gas_api_url');
  }
};

export const API_URL = DEFAULT_API_URL;

// ── App config helpers ────────────────────────────────────────
export const fetchAppConfigFromAppsScript = async (): Promise<any> => {
  const url = `${getApiUrl()}?action=getConfig&t=${new Date().getTime()}`;
  const res = await fetch(url, { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error(`Apps Script Config Fetch Error: ${res.statusText}`);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch (err: any) {
    throw new Error(`Apps Script Config Parse Error: ${err.message}`);
  }
  if (json?.success) return json.data;
  throw new Error((json?.error) || 'Failed to retrieve configuration from Apps Script.');
};

export const saveAppConfigToAppsScript = async (config: any): Promise<void> => {
  const payload = { action: 'saveConfig', config };
  const response = await fetch(`${getApiUrl()}?action=saveConfig`, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Apps Script Error:', errorText);
    throw new Error('Sync failed: ' + response.statusText);
  }
  const json = await response.json();
  if (!json?.success) throw new Error((json?.error) || 'Failed to save configuration via Apps Script.');
};