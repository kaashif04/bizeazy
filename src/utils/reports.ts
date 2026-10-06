/**
 * reports.ts — sales, receivables and payroll cost, from the loaded records.
 * Pure functions over DatabaseState; the Reports view only lays them out.
 */
import { DatabaseState, CompanyProfile } from '../types';
import { getPaymentSummary } from './payments';
import { outletLabel } from './outlets';
import { normaliseMonthLabel } from './notifications';
import { parseLocalDate, parseMonthLabel, MONTH_NAMES } from './payroll';

/** "2026-09" */
export type MonthKey = string;
const key = (y: number, m: number): MonthKey => `${y}-${String(m + 1).padStart(2, '0')}`;
export const monthTitle = (k: MonthKey) => `${MONTH_NAMES[Number(k.slice(5)) - 1].slice(0, 3)} ${k.slice(0, 4)}`;

/** The `count` months ending with today's, oldest first. */
export function lastMonths(today: Date, count = 12): MonthKey[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth() - (count - 1 - i), 1);
    return key(d.getFullYear(), d.getMonth());
  });
}

const monthOfDate = (value?: string): MonthKey | null => {
  const d = parseLocalDate(value);
  return d ? key(d.getFullYear(), d.getMonth()) : null;
};

const money = (n: number) => Math.round(n * 100) / 100;

/** Records name their branch by outlet id; anything unmatched is grouped, not dropped. */
function branchName(id: string | undefined, profiles: CompanyProfile[]): string {
  const p = profiles.find(x => x.id === id);
  return p ? outletLabel(p) : (id ? `${id} (removed branch)` : 'No branch');
}

// ── Sales ─────────────────────────────────────────────────────
export interface SalesRow { branch: string; invoiced: number[]; collected: number[]; totalInvoiced: number; totalCollected: number }
export interface SalesReport { months: MonthKey[]; rows: SalesRow[]; total: SalesRow }

/**
 * Invoiced counts in the invoice's month; collected counts in the month the
 * money arrived. An old invoice marked Paid with no payment recorded is
 * counted as collected in its own month, as the rest of the app treats it.
 */
export function salesByBranch(db: DatabaseState, profiles: CompanyProfile[], months: MonthKey[]): SalesReport {
  const index = new Map(months.map((m, i) => [m, i]));
  const rows = new Map<string, SalesRow>();
  const row = (branch: string) => {
    if (!rows.has(branch)) rows.set(branch, { branch, invoiced: months.map(() => 0), collected: months.map(() => 0), totalInvoiced: 0, totalCollected: 0 });
    return rows.get(branch)!;
  };
  // Every branch shows, even in a month it sold nothing.
  profiles.forEach(p => row(outletLabel(p)));

  db.invoices.forEach(inv => {
    const r = row(branchName(inv.Company, profiles));
    const i = index.get(monthOfDate(inv.Date) || '');
    if (i !== undefined) r.invoiced[i] += Number(inv.Total_Amount) || 0;

    const own = db.payments.filter(p => p.Invoice_ID === inv.Invoice_ID);
    own.forEach(p => {
      const j = index.get(monthOfDate(p.Date) || monthOfDate(inv.Date) || '');
      if (j !== undefined) r.collected[j] += Number(p.Amount) || 0;
    });
    if (!own.length && i !== undefined) r.collected[i] += getPaymentSummary(inv, db.payments).paid;
  });

  const list = [...rows.values()].map(r => ({
    ...r,
    invoiced: r.invoiced.map(money), collected: r.collected.map(money),
    totalInvoiced: money(r.invoiced.reduce((a, b) => a + b, 0)),
    totalCollected: money(r.collected.reduce((a, b) => a + b, 0)),
  }));
  const total: SalesRow = {
    branch: 'All branches',
    invoiced: months.map((_, i) => money(list.reduce((s, r) => s + r.invoiced[i], 0))),
    collected: months.map((_, i) => money(list.reduce((s, r) => s + r.collected[i], 0))),
    totalInvoiced: money(list.reduce((s, r) => s + r.totalInvoiced, 0)),
    totalCollected: money(list.reduce((s, r) => s + r.totalCollected, 0)),
  };
  return { months, rows: list, total };
}

// ── Unpaid invoices by age ────────────────────────────────────
export const AGE_BUCKETS = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const;
const bucketOf = (days: number) => (days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3);

export interface AgingRow { branch: string; buckets: number[]; total: number; count: number }
export interface AgingInvoice { id: string; customer: string; branch: string; date: string; days: number; balance: number }
export interface AgingReport { rows: AgingRow[]; total: AgingRow; invoices: AgingInvoice[] }

/** Outstanding balances by how long since the invoice date. Oldest invoices first in the list. */
export function receivablesAging(db: DatabaseState, profiles: CompanyProfile[], today: Date): AgingReport {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const invoices: AgingInvoice[] = [];
  db.invoices.forEach(inv => {
    const balance = getPaymentSummary(inv, db.payments).balance;
    if (balance <= 0.005) return;
    const issued = parseLocalDate(inv.Date);
    const days = issued ? Math.max(0, Math.round((start.getTime() - issued.getTime()) / 86400000)) : 0;
    invoices.push({
      id: inv.Invoice_ID, customer: inv.Customer_Name, branch: branchName(inv.Company, profiles),
      date: inv.Date, days, balance: money(balance),
    });
  });
  invoices.sort((a, b) => b.days - a.days);

  const rows = new Map<string, AgingRow>();
  invoices.forEach(inv => {
    const r = rows.get(inv.branch) || { branch: inv.branch, buckets: [0, 0, 0, 0], total: 0, count: 0 };
    rows.set(inv.branch, r);
    r.buckets[bucketOf(inv.days)] += inv.balance;
    r.total += inv.balance;
    r.count += 1;
  });
  const list = [...rows.values()].map(r => ({ ...r, buckets: r.buckets.map(money), total: money(r.total) }));
  const total: AgingRow = {
    branch: 'All branches',
    buckets: [0, 1, 2, 3].map(i => money(list.reduce((s, r) => s + r.buckets[i], 0))),
    total: money(list.reduce((s, r) => s + r.total, 0)),
    count: invoices.length,
  };
  return { rows: list, total, invoices };
}

// ── Payroll cost ──────────────────────────────────────────────
export interface PayrollMonth {
  month: MonthKey; staff: number;
  gross: number;          // basic + allowances paid
  employerStatutory: number; // employer EPF + SOCSO + EIS
  borne: number;          // employee statutory the employer chose to cover
  cost: number;           // what the month cost the company
  netPaid: number;        // what reached employees' accounts
}

/**
 * From SAVED payslips only — a draft is not a cost yet. Cost to the company is
 * gross pay plus the employer's own contributions plus any employee share it
 * agreed to bear. Advances already paid out are part of net pay, not extra cost.
 */
export function payrollCost(db: DatabaseState, months: MonthKey[], branch?: string): PayrollMonth[] {
  const byMonth = new Map(months.map(m => [m, { month: m, staff: 0, gross: 0, employerStatutory: 0, borne: 0, cost: 0, netPaid: 0 }]));
  db.payslips.forEach(p => {
    if (!p.Is_Saved) return;
    if (branch && (p.Branch_Location || '').toLowerCase() !== branch.toLowerCase()) return;
    const parsed = parseMonthLabel(normaliseMonthLabel(p.Month_Year));
    const m = parsed && byMonth.get(key(parsed.year, parsed.month));
    if (!m) return;
    const gross = (Number(p.Basic_Pay) || 0) + (Number(p.Total_Allowances) || Number(p.Custom_Allowances) || 0);
    const employer = (Number(p.Employer_EPF) || 0) + (Number(p.Employer_SOCSO) || 0) + (Number(p.Employer_EIS) || 0);
    const borne = Number(p.Employer_Statutory_Offset) || 0;
    m.staff += 1;
    m.gross += gross;
    m.employerStatutory += employer;
    m.borne += borne;
    m.cost += gross + employer + borne;
    m.netPaid += Number(p.Final_Net_Pay) || 0;
  });
  return [...byMonth.values()].map(m => ({
    ...m, gross: money(m.gross), employerStatutory: money(m.employerStatutory),
    borne: money(m.borne), cost: money(m.cost), netPaid: money(m.netPaid),
  }));
}
