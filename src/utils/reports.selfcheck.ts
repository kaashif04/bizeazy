/**
 * Runnable check for the report figures: `npx tsx src/utils/reports.selfcheck.ts`.
 * These numbers go in front of the owner as money, so each rule is pinned.
 */
import { DatabaseState, CompanyProfile, Invoice, Payment, Payslip } from '../types';
import { lastMonths, salesByBranch, receivablesAging, payrollCost, monthTitle } from './reports';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

const profiles = [
  { id: 'Bistro', name: 'A1 Bistro', store_name: 'A1 Bistro' },
  { id: 'NK', name: "Kiya's", store_name: "Kiya's" },
] as CompanyProfile[];
const inv = (id: string, Company: string, Date: string, Total_Amount: number, Status = 'Pending') =>
  ({ Invoice_ID: id, Company, Date, Total_Amount, Status, Customer_Name: `Cust ${id}` }) as Invoice;
const pay = (Invoice_ID: string, Amount: number, Date: string) => ({ Payment_ID: `${Invoice_ID}-${Date}`, Invoice_ID, Amount, Date }) as Payment;
const empty = (): DatabaseState => ({
  invoices: [], invoice_items: [], payments: [], customers: [],
  employees: [], payslips: [], quotations: [], quotation_days: [], quotation_items: [],
});

const today = new Date(2026, 9, 7);   // 7 Oct 2026
const months = lastMonths(today, 12);
ok(months.length === 12 && months[0] === '2025-11' && months[11] === '2026-10', `twelve months ending this one, got ${months[0]}…${months[11]}`);
ok(monthTitle('2026-09') === 'Sep 2026', 'month title');

// ── Sales ──
const db = empty();
db.invoices = [
  inv('A', 'Bistro', '2026-09-20', 770),
  inv('B', 'Bistro', '2026-08-10', 300, 'Paid'),     // legacy: paid before payments were recorded
  inv('C', 'NK', '2026-09-05', 1000),
  inv('D', 'Gone', '2026-09-05', 50),                // a branch since removed
  inv('E', 'Bistro', '2024-01-01', 999),             // outside the window
];
db.payments = [pay('A', 500, '2026-10-02'), pay('C', 1000, '2026-09-06')];
const sales = salesByBranch(db, profiles, months);
const sep = months.indexOf('2026-09'), oct = months.indexOf('2026-10'), aug = months.indexOf('2026-08');
const bistro = sales.rows.find(r => r.branch === 'A1 Bistro')!;
ok(bistro.invoiced[sep] === 770 && bistro.collected[sep] === 0, 'invoiced counts in the invoice month, not when paid');
ok(bistro.collected[oct] === 500, 'collected counts in the month the money arrived');
ok(bistro.invoiced[aug] === 300 && bistro.collected[aug] === 300, 'a legacy Paid invoice is collected in its own month');
ok(bistro.totalInvoiced === 1070, `out-of-window invoices are left out, got ${bistro.totalInvoiced}`);
ok(sales.rows.some(r => r.branch === 'Gone (removed branch)' && r.totalInvoiced === 50), 'a removed branch is grouped, not dropped');
ok(sales.total.totalInvoiced === 2120 && sales.total.totalCollected === 1800, `totals add up, got ${sales.total.totalInvoiced}/${sales.total.totalCollected}`);
ok(salesByBranch(empty(), profiles, months).rows.length === 2, 'every branch shows even with no sales');

// ── Receivables ──
const aging = receivablesAging(db, profiles, today);
ok(aging.invoices.map(i => i.id).join() === 'E,D,A',
   `every invoice with a balance, however old (no 12-month window), oldest first; got ${aging.invoices.map(i => i.id)}`);
ok(aging.invoices.find(i => i.id === 'A')!.balance === 270 && aging.invoices.find(i => i.id === 'A')!.days === 17, 'balance and age of a part-paid invoice');
const agedBistro = aging.rows.find(r => r.branch === 'A1 Bistro')!;
ok(agedBistro.buckets[0] === 270 && agedBistro.buckets[3] === 999 && agedBistro.count === 2, '17 days in 0–30, two years in over 90');
ok(aging.rows.find(r => r.branch === 'Gone (removed branch)')!.buckets[1] === 50, '32 days old sits in 31–60');
ok(aging.total.total === 1319 && aging.total.count === 3, 'aging totals');
const old = empty();
old.invoices = [inv('X', 'Bistro', '2026-06-01', 100)];
ok(receivablesAging(old, profiles, today).total.buckets[3] === 100, '128 days old sits in over 90');

// ── Payroll cost ──
const slip = (over: Partial<Payslip>) => ({
  Payslip_ID: Math.random().toString(), Employee_ID: 'E', Month_Year: 'September 2026', Basic_Pay: 2000,
  Custom_Allowances: 200, Total_Allowances: 200, Employer_EPF: 286, Employer_SOCSO: 38.65, Employer_EIS: 4.30,
  Employer_Statutory_Offset: 0, Final_Net_Pay: 1950, Is_Saved: true, Branch_Location: 'A1 Bistro', ...over,
}) as Payslip;
const pdb = empty();
pdb.payslips = [
  slip({}),
  slip({ Month_Year: '2026-09-01', Employer_Statutory_Offset: 250, Final_Net_Pay: 2200 }),   // month stored as a date; employer bears statutory
  slip({ Is_Saved: false }),                                                                   // a draft
  slip({ Branch_Location: "Kiya's", Month_Year: 'August 2026' }),
];
const cost = payrollCost(pdb, months);
const sepCost = cost.find(m => m.month === '2026-09')!;
ok(sepCost.staff === 2, `drafts are not a cost; a date-stored month still counts; got ${sepCost.staff}`);
ok(sepCost.gross === 4400 && sepCost.employerStatutory === 657.9, `gross and employer contributions, got ${sepCost.gross}/${sepCost.employerStatutory}`);
ok(sepCost.cost === 5307.9, `cost = gross + employer contributions + borne share, got ${sepCost.cost}`);
ok(sepCost.netPaid === 4150, 'net paid');
ok(payrollCost(pdb, months, "Kiya's").find(m => m.month === '2026-08')!.staff === 1, 'branch filter');
ok(payrollCost(pdb, months, "Kiya's").find(m => m.month === '2026-09')!.staff === 0, 'other branches are filtered out');

console.log('All report self-checks passed.');
