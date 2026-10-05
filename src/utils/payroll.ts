/**
 * payroll.ts — wage periods and residency, shared by the payslip generator and
 * the reminders so the two cannot disagree about what anyone is owed.
 *
 * Code.gs re-derives payPeriod/periodBounds for its email reminder (Apps Script
 * cannot import this). notifications.selfcheck.ts runs both and fails on drift.
 */
import { Employee } from '../types';

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Parse "2026-05-15" as a LOCAL date; `new Date(str)` would read it as UTC. */
export function parseLocalDate(value?: string): Date | null {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

/** A local date as "2026-05-15" — toISOString() would shift it into UTC. */
export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const monthLabel = (d: Date): string => `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;

/** "September 2026" → { year: 2026, month: 8 }. */
export function parseMonthLabel(label: string): { year: number; month: number } | null {
  const [name, year] = String(label || '').split(' ');
  const month = MONTH_NAMES.indexOf(name);
  return month >= 0 && Number(year) ? { year: Number(year), month } : null;
}

const daysIn = (y: number, m: number): number => new Date(y, m + 1, 0).getDate();
/** Inclusive day count. Rounded, so a daylight-saving hour cannot lose a day. */
const dayCount = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / 86400000) + 1;

export type PayBasis = 'calendar' | 'anniversary';

/**
 * The wage period paid under a month's label, whoever works it.
 *  - calendar:    1st to the last day of the month.
 *  - anniversary: from the joining day to the day before it next month, so
 *                 someone who joined on 15 Sep is paid "September" for 15 Sep–14 Oct.
 * A joining day past a short month's end clamps to that month's last day.
 */
export function periodBounds(emp: Employee, year: number, month: number): { start: Date; end: Date } {
  const joined = parseLocalDate(emp.Joining_Date);
  const day = emp.Pay_Basis === 'anniversary' && joined ? joined.getDate() : 1;
  const startOf = (y: number, m: number) => {
    const first = new Date(y, m, 1);
    return new Date(first.getFullYear(), first.getMonth(), Math.min(day, daysIn(first.getFullYear(), first.getMonth())));
  };
  const start = startOf(year, month);
  const next = startOf(year, month + 1);
  return { start, end: new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1) };
}

export interface PayPeriod {
  label: string;
  start: Date; end: Date;   // the whole wage period
  from: Date; to: Date;     // the part of it this employee was employed for
  daysWorked: number;
  daysInPeriod: number;
  fraction: number;         // of Basic_Salary payable — 1 for a full period
}

/**
 * What this employee worked of the period paid under `month`, or null if they
 * worked none of it (not joined yet, or already left).
 *
 * A part period is paid pro rata by calendar days — Employment Act s.18A
 * (incomplete month: monthly rate ÷ days in the month × days worked). On the
 * anniversary basis the first period starts on the joining day, so only a
 * leaver's final period is ever part of one.
 */
export function payPeriod(emp: Employee, year: number, month: number): PayPeriod | null {
  const { start, end } = periodBounds(emp, year, month);
  const joined = parseLocalDate(emp.Joining_Date);
  const left = parseLocalDate(emp.End_Date);
  const from = joined && joined > start ? joined : start;
  const to = left && left < end ? left : end;
  if (from > to) return null;
  const daysInPeriod = dayCount(start, end);
  const daysWorked = dayCount(from, to);
  return { label: monthLabel(start), start, end, from, to, daysWorked, daysInPeriod, fraction: daysWorked / daysInPeriod };
}

export const payPeriodForLabel = (emp: Employee, label: string): PayPeriod | null => {
  const parsed = parseMonthLabel(label);
  return parsed ? payPeriod(emp, parsed.year, parsed.month) : null;
};

/** The payslip a given day's wages fall on — where an advance taken that day is recovered. */
export function periodLabelFor(emp: Employee, date: Date): string {
  const { start } = periodBounds(emp, date.getFullYear(), date.getMonth());
  return monthLabel(date >= start ? start : new Date(date.getFullYear(), date.getMonth() - 1, 1));
}

/**
 * Should a reminder chase this period? Only from the period running when the
 * employee was added to the app: entering someone with a joining date years
 * back must not nag about years of back pay. Those payslips can still be
 * generated. Rows from before Registered_On existed have no limit.
 */
export function isRemindable(emp: Employee, period: PayPeriod): boolean {
  const registered = parseLocalDate(emp.Registered_On);
  return !registered || period.end >= registered;
}

const shortDate = (d: Date): string => `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;

/** "15 Sep – 30 Sep 2026 · 16 of 30 days" — printed on the payslip so a part salary explains itself. */
export const describePeriod = (p: PayPeriod): string =>
  `${shortDate(p.from)} – ${shortDate(p.to)} ${p.to.getFullYear()}` +
  (p.fraction < 1 ? ` · ${p.daysWorked} of ${p.daysInPeriod} days` : '');

/** Same rounding the statutory calculators always used, so existing amounts do not move. */
export const round2 = (n: number): number => Number(n.toFixed(2));

// ── Residency ────────────────────────────────────────────────────────────────
// A permanent resident is a local for SOCSO, EIS and EPF below 60. The two only
// part ways at 60+, under EPF (Third Schedule): a citizen contributes 0% and the
// employer 4%, while a PR keeps contributing 5.5% and the employer 6.5% (6% above
// RM5,000). "Malaysian/PR" is the old combined value; it is read as Malaysian,
// which is what this app always charged it at.
export type Residency = 'Malaysian' | 'PR' | 'Foreigner';

export const residencyOf = (c?: string): Residency =>
  c === 'Foreigner' ? 'Foreigner' : c === 'PR' ? 'PR' : 'Malaysian';

export const residencyLabel = (c?: string): string =>
  c === 'Malaysian/PR' || !c ? 'Malaysian/PR' : c === 'PR' ? 'Permanent Resident' : c;

/** Employee EPF. Foreign workers 2% (mandatory since Oct 2025) until 75. */
export function epfEmployee(gross: number, citizenship: string | undefined, age = 30): number {
  const r = residencyOf(citizenship);
  if (r === 'Foreigner') return age >= 75 ? 0 : round2(gross * 0.02);
  if (age >= 60) return r === 'PR' ? round2(gross * 0.055) : 0;
  return round2(gross * 0.11);
}

/** Employer EPF. Below 60: 13% up to RM5,000, 12% above. */
export function epfEmployer(gross: number, citizenship: string | undefined, age = 30): number {
  const r = residencyOf(citizenship);
  if (r === 'Foreigner') return age >= 75 ? 0 : round2(gross * 0.02);
  if (age >= 60) return round2(gross * (r === 'PR' ? (gross <= 5000 ? 0.065 : 0.06) : 0.04));
  return round2(gross * (gross <= 5000 ? 0.13 : 0.12));
}
