/**
 * Runnable check for what a save writes and what the import reads:
 * `npx tsx src/db.selfcheck.ts`.
 *
 * A save sends only the difference between what this device last saw and what
 * is on screen; get that wrong and edits are lost or records wiped. The import
 * reads years of sheet rows written by several older builds; get that wrong and
 * the move to Supabase silently drops data.
 */
(globalThis as any).window = undefined;
const { diffRecords, recordKey, EMPTY_DB, KINDS } = await import('./db');
const { parseSheetExport } = await import('./sheetsImport');
import type { DatabaseState, CompanyProfile } from './types';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };
const db = (over: Partial<DatabaseState>): DatabaseState => ({ ...JSON.parse(JSON.stringify(EMPTY_DB)), ...over });

// ── What a save sends ──
const inv = (id: string, total = 100) => ({ Invoice_ID: id, Total_Amount: total } as any);
const base = db({ invoices: [inv('A'), inv('B')], employees: [{ Employee_ID: 'E1', Basic_Salary: 1800 } as any] });

let c = diffRecords(base, JSON.parse(JSON.stringify(base)));
ok(!c.upserts.length && !c.deletes.length, 'nothing changed means nothing is sent');

c = diffRecords(base, { ...base, invoices: [inv('A', 250), inv('B')] });
ok(c.upserts.length === 1 && c.upserts[0].id === 'A' && !c.deletes.length, 'one edit sends exactly that row');

c = diffRecords(base, { ...base, invoices: [inv('A'), inv('B'), inv('C')] });
ok(c.upserts.length === 1 && c.upserts[0].id === 'C', 'an addition sends only the new row');

c = diffRecords(base, { ...base, invoices: [inv('B')] });
ok(c.deletes.length === 1 && c.deletes[0].id === 'A' && c.deletes[0].kind === 'invoices', 'a deletion sends exactly that delete');

c = diffRecords(base, { ...base, employees: [] });
ok(c.deletes.length === 1 && c.deletes[0].kind === 'employees', 'removing the last employee is a real delete');

c = diffRecords(null, base);
ok(c.upserts.length === 3 && !c.deletes.length, 'with no base, everything is written and nothing deleted');

c = diffRecords(base, { ...base, invoices: [inv('A'), inv('A', 999), inv('B')] });
ok(!c.upserts.length, 'a repeated id is written once (the first), never twice');

c = diffRecords(base, { ...base, invoices: [inv('A'), inv('B'), { Total_Amount: 5 } as any] });
ok(!c.upserts.length, 'a row with no id is never written under a blank key');

// Child rows are keyed under their parent: two invoices may both have line "1".
const lines = db({ invoice_items: [
  { Item_ID: '1', Invoice_ID: 'A', Item_Name: 'Rice', Quantity: 1, Price: 5, Subtotal: 5 },
  { Item_ID: '1', Invoice_ID: 'B', Item_Name: 'Tea', Quantity: 2, Price: 3, Subtotal: 6 },
] as any });
ok(diffRecords(null, lines).upserts.length === 2, 'same line number on two invoices are two records');
ok(recordKey.customers({ Customer_Name: 'Acme', Branch_Location: 'A1 Bistro' }) ===
   recordKey.customers({ Customer_Name: 'ACME', Branch_Location: 'a1 bistro' }), 'a customer is one record whatever the case');

// ── The import ──
const profiles: CompanyProfile[] = [
  { id: 'Bistro', name: 'A1 Bistro', store_name: 'A1 Bistro', series_format: 'BIS-26-' } as CompanyProfile,
  { id: 'Nasi Kandar', name: "Kiya's Restaurant", store_name: "Kiya's Restaurant", series_format: 'NK-26-' } as CompanyProfile,
];
// Rows exactly as Apps Script's fetchDataAll returned them, old encodings included.
const sheet = {
  invoices: [
    { Invoice_ID: 'BIS-26-0001', Date: '2026-05-02', Company: 'A1 Bistro', Customer_Name: 'Acme', Status: 'Paid',
      Total_Amount: 770, Branch_Location: 'A1 Bistro',
      Invoice_Items_JSON: JSON.stringify([{ Item_ID: 'L1', Invoice_ID: 'BIS-26-0001', Item_Name: 'Nasi', Quantity: 10, Price: 77, Subtotal: 770 }]) },
    { Invoice_ID: 'BIS-26-0001', Date: '2026-05-02', Company: 'A1 Bistro', Customer_Name: 'Acme', Total_Amount: 770 },  // duplicate row
  ],
  invoice_items: [
    { Item_ID: 'L1', Invoice_ID: 'BIS-26-0001', Item_Name: 'Nasi', Quantity: 10, Price: 77, Subtotal: 770 },          // same line, tab copy
  ],
  payments: [{ Payment_ID: 'P1', Invoice_ID: 'BIS-26-0001', Amount: 770, Date: '2026-05-03', Method: 'Cash', Reference: '00921' }],
  customers: [{ Customer_Name: 'Acme', Contact: '0123456789', Customer_Type: 'Regular', Address: 'KL', Branch_Location: 'A1 Bistro' }],
  employees: [
    { Employee_ID: 'EMP-1', Employee_Name: 'Siti', IC_Passport: 10203141234, Position: 'Cook', Assigned_Outlet: 'Bistro',
      Basic_Salary: 1800, Bank_Details: 'Maybank 123||bm:F|41|2024-02-01', Branch_Location: 'A1 Bistro',
      Citizenship: '', Age: '', Joining_Date: '', Employer_Bears_Statutory: 'TRUE',
      Pay_Basis: 'anniversary', End_Date: '2026-10-20', Registered_On: '2026-10-05',
      Advances_JSON: JSON.stringify([{ id: 'ADV-1', date: '2026-10-03', amount: 250 }]) },
  ],
  payslips: [
    { Payslip_ID: 'PAY-EMP-1-September-2026', Employee_ID: 'EMP-1', Month_Year: '2026-09-01', Basic_Pay: 1800,
      Final_Net_Pay: 1700, Branch_Location: 'A1 Bistro', Is_Saved: 'TRUE',
      Deductions_JSON: JSON.stringify([{ description: 'Advance', amount: 100 }, { _bm_paid: true, _bm_date: '6 October 2026' }]),
      Payment_Transferred: '', Transfer_Date: '', Pay_Period: '15 Sep – 14 Oct 2026' },
  ],
  quotations: [{ Quotation_ID: 'Q-1', Date: '2026-09-01', Company: 'Nasi Kandar', Customer_Name: 'Party Co', Pricing_Mode: 'package', Total_Amount: 5000 }],
  quotation_days: [{ Day_ID: 'D1', Quotation_ID: 'Q-1', Event_Date: '2026-10-10', Pax: 100, Serving_Style: 'Buffet Setup' }],
  quotation_items: [{ Item_ID: 'QI1', Quotation_ID: 'Q-1', Day_ID: 'D1', Session_Label: 'Lunch', Session_Time: '1899-12-30', Item_Name: 'Biryani', Quantity: 100, Price: 15, Subtotal: 1500 }],
};
const got = parseSheetExport(sheet, profiles);

ok(got.invoices.length === 1, `a duplicated invoice row imports once, got ${got.invoices.length}`);
ok(got.invoice_items.length === 1, `a line in both the inline column and the tab imports once, got ${got.invoice_items.length}`);
ok(got.invoices[0].Company === 'Bistro', `a branch name resolves to its outlet id, got ${got.invoices[0].Company}`);
ok(got.payments[0].Reference === '00921', 'a reference keeps its leading zeros');
ok(got.customers[0].Contact === '0123456789', 'a phone keeps its leading zero');

const e = got.employees[0];
ok(e.Bank_Details === 'Maybank 123', `the legacy ||bm: suffix is stripped from bank details, got "${e.Bank_Details}"`);
ok(e.Citizenship === 'Foreigner' && e.Age === 41 && e.Joining_Date === '2024-02-01', 'and its citizenship, age and joining date are recovered');
ok(e.Employer_Bears_Statutory === true, 'a TRUE cell reads as true');
ok(e.Pay_Basis === 'anniversary' && e.End_Date === '2026-10-20' && e.Registered_On === '2026-10-05', 'the payroll fields of 3.16 come across');
ok(e.Advances?.length === 1 && e.Advances[0].amount === 250, 'salary advances come across');
ok(String(e.IC_Passport) === '10203141234', 'an IC Sheets already turned into a number is kept as its digits');

const ps = got.payslips[0];
ok(ps.Month_Year === 'September 2026', `a month Sheets turned into a date comes back as its label, got "${ps.Month_Year}"`);
ok(ps.Payment_Transferred === true && ps.Transfer_Date === '6 October 2026', 'a payment recorded the old _bm_paid way is recovered');
ok(!ps.Deductions_JSON!.includes('_bm_paid') && ps.Deductions_JSON!.includes('Advance'), 'the marker is removed, the real deduction kept');
ok(ps.Is_Saved === true && ps.Pay_Period === '15 Sep – 14 Oct 2026', 'saved state and pay period come across');

ok(got.quotations[0].Company === 'Nasi Kandar' && got.quotation_days.length === 1, 'quotations and their days come across');
ok(got.quotation_items[0].Session_Time === '', 'a garbage 1899 time serial is dropped, not imported');

// Everything parsed is writable: each record has a key the database accepts.
const write = diffRecords(null, got);
const expected = KINDS.reduce((n, k) => n + (got[k] as any[]).length, 0);
ok(write.upserts.length === expected, `every imported record is written, ${write.upserts.length} of ${expected}`);
ok(write.upserts.every(u => u.id.length > 0), 'no record is written under a blank key');

ok(parseSheetExport({}, profiles).invoices.length === 0, 'an empty export imports nothing without failing');

console.log('All db and import self-checks passed.');
