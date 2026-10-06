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

// ── Statutory contributions, from the official schedules ─────────────────────
// Every amount here comes from a published wage-band table, not a straight
// percentage: the schedules round, and a straight percentage drifts from what
// KWSP and PERKESO actually bill by up to a few ringgit a month. The table
// rules below are reproduced exactly, and checked row by row in
// notifications.selfcheck.ts against figures taken from the schedules.

/** Kill float noise (0.13 × 3000 = 390.00000000000006) before rounding up. */
const clean = (n: number) => Math.round(n * 10000) / 10000;

/**
 * EPF Third Schedule (Akta KWSP 1991, s.43). Up to RM10: nothing. To RM5,000:
 * RM20 bands; RM5,000.01–20,000: RM100 bands; the rate applies to the band's
 * top value and the result is rounded UP to the next ringgit. Above RM20,000
 * the wage itself is used, still rounded up to the ringgit.
 */
export function epfAmount(wage: number, rate: number): number {
  if (!(wage > 10) || rate <= 0) return 0;
  const base = wage <= 5000 ? Math.ceil(clean(wage / 20)) * 20
             : wage <= 20000 ? Math.ceil(clean(wage / 100)) * 100
             : wage;
  return Math.ceil(clean(base * rate));
}

/** Employee EPF: 11% below 60; at 60+ citizens 0%, PRs 5.5%; foreign workers 2% (since Oct 2025) until 75. */
export function epfEmployee(gross: number, citizenship: string | undefined, age = 30): number {
  const r = residencyOf(citizenship);
  if (r === 'Foreigner') return age >= 75 ? 0 : epfAmount(gross, 0.02);
  if (age >= 60) return r === 'PR' ? epfAmount(gross, 0.055) : 0;
  return epfAmount(gross, 0.11);
}

/** Employer EPF: 13% to RM5,000 and 12% above, below 60; at 60+ citizens 4%, PRs 6.5%/6%; foreign workers 2%. */
export function epfEmployer(gross: number, citizenship: string | undefined, age = 30): number {
  const r = residencyOf(citizenship);
  if (r === 'Foreigner') return age >= 75 ? 0 : epfAmount(gross, 0.02);
  if (age >= 60) return epfAmount(gross, r === 'PR' ? (gross <= 5000 ? 0.065 : 0.06) : 0.04);
  return epfAmount(gross, gross <= 5000 ? 0.13 : 0.12);
}

/**
 * PERKESO schedules (SOCSO, Act 4; EIS, Act 800; SKBBK). Wages above RM6,000
 * are charged as RM6,000. Below RM300 the bands are irregular and the amounts
 * are fixed in the schedule, so they are listed; from RM300 every RM100 band
 * is charged on its midpoint and rounded up to the next 5 sen.
 */
const PERKESO_LOW_BANDS = [30, 50, 70, 100, 140, 200, 300];
const PERKESO_LOW: Record<'socsoEmployer' | 'socsoEmployee' | 'socsoInjuryOnly' | 'skbbk' | 'eis', number[]> = {
  socsoEmployer:   [0.40, 0.70, 1.10, 1.50, 2.10, 2.95, 4.35],
  socsoEmployee:   [0.10, 0.20, 0.30, 0.40, 0.60, 0.85, 1.25],
  socsoInjuryOnly: [0.30, 0.50, 0.80, 1.10, 1.50, 2.10, 3.10],
  skbbk:           [0.20, 0.30, 0.50, 0.65, 0.90, 1.25, 1.85],
  eis:             [0.05, 0.10, 0.15, 0.20, 0.25, 0.35, 0.50],
};
export const PERKESO_CEILING = 6000;

function perkesoAmount(wage: number, rate: number, low: number[]): number {
  if (!(wage > 0)) return 0;
  const band = PERKESO_LOW_BANDS.findIndex(top => wage <= top);
  if (band >= 0) return low[band];
  const midpoint = Math.ceil(clean(Math.min(wage, PERKESO_CEILING) / 100)) * 100 - 50;
  return Math.ceil(clean(midpoint * rate * 20)) / 20;
}

export interface Statutory {
  epfEmployee: number; epfEmployer: number;
  socsoEmployee: number; socsoEmployer: number;
  eisEmployee: number; eisEmployer: number;
  skbbk: number;
}

/**
 * Everything statutory on one month's wages.
 *  - SOCSO: below 60, First Category (employer 1.75%, employee 0.5%) — locals
 *    and, since July 2024, foreign workers alike. From 60, Second Category:
 *    employment injury only, employer 1.25%, nothing from the employee.
 *  - EIS (SIP): 0.2% each side, citizens and PRs aged 18 to 59 only.
 *  - SKBBK (Lindung 24 Jam, from 1 June 2026): employee-only 0.75%, at any age.
 *    Compulsory for foreign workers; for locals it is opt-OUT — anyone who did
 *    not file the release by 31 August 2026 still contributes.
 */
export function statutory(gross: number, emp: { Citizenship?: string; Age?: number; SKBBK_Opted_Out?: boolean }): Statutory {
  const r = residencyOf(emp.Citizenship);
  const age = Number(emp.Age) || 30;
  const senior = age >= 60;
  const local = r !== 'Foreigner';
  const eisApplies = local && age >= 18 && !senior;
  const skbbkApplies = r === 'Foreigner' || !emp.SKBBK_Opted_Out;
  return {
    epfEmployee:   epfEmployee(gross, emp.Citizenship, age),
    epfEmployer:   epfEmployer(gross, emp.Citizenship, age),
    socsoEmployee: senior ? 0 : perkesoAmount(gross, 0.005, PERKESO_LOW.socsoEmployee),
    socsoEmployer: senior ? perkesoAmount(gross, 0.0125, PERKESO_LOW.socsoInjuryOnly)
                          : perkesoAmount(gross, 0.0175, PERKESO_LOW.socsoEmployer),
    eisEmployee:   eisApplies ? perkesoAmount(gross, 0.002, PERKESO_LOW.eis) : 0,
    eisEmployer:   eisApplies ? perkesoAmount(gross, 0.002, PERKESO_LOW.eis) : 0,
    skbbk:         skbbkApplies ? perkesoAmount(gross, 0.0075, PERKESO_LOW.skbbk) : 0,
  };
}

/** What each deduction line on a payslip should say for this person. */
export function deductionLabels(emp: { Citizenship?: string; Age?: number }) {
  const r = residencyOf(emp.Citizenship);
  const senior = (Number(emp.Age) || 30) >= 60;
  return {
    epf: r === 'Foreigner' ? '2%' : senior ? (r === 'PR' ? '5.5%, PR 60+' : 'none from age 60') : '11%',
    socso: senior ? 'none from age 60, employer pays' : '0.5%',
    eis: r === 'Foreigner' ? 'not for foreign workers' : senior ? 'none from age 60' : '0.2%',
  };
}
