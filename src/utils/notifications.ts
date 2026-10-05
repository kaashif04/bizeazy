/**
 * notifications.ts — what needs attention, derived entirely from loaded data.
 *
 * Deliberately stateless: no notifications tab, no read/dismissed flags, no
 * snoozing. Every item is computed from the current rows, so it disappears the
 * moment the underlying thing is dealt with and cannot go stale or hide a real
 * problem behind a dismissal. Add snoozing only if nagging proves to be wrong.
 */
import { DatabaseState, Employee, Payslip, CompanyProfile } from '../types';
import { getPaymentSummary } from './payments';
import { outletLabel } from './outlets';
import { parseLocalDate, monthLabel, periodBounds, payPeriod, isRemindable, PayPeriod } from './payroll';

export { parseLocalDate, monthLabel };

/**
 * Malaysian Employment Act s.19: wages are payable within 7 days of the end of
 * the wage period. This constant is the single definition of the salary
 * deadline — PayrollDashboard's countdown and the email reminder both use it.
 */
export const SALARY_DEADLINE_DAYS = 7;

/** Days after which an unsettled invoice counts as overdue. */
const INVOICE_OVERDUE_DAYS = 30;

/** Days of notice before a quotation's validity lapses. */
const QUOTATION_NOTICE_DAYS = 3;

export type NotificationKind =
  | 'salary-due' | 'salary-overdue' | 'invoice-overdue' | 'quotation-expiring' | 'quotation-expired';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  severity: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
  view: 'payroll' | 'invoicing' | 'quotations';
}

const daysBetween = (from: Date, to: Date): number =>
  Math.ceil((to.getTime() - from.getTime()) / 86400000);

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Normalise whatever a Month_Year cell holds to "September 2026". */
export function normaliseMonthLabel(raw?: string): string {
  const value = String(raw || '');
  if (value.includes('T') || /^\d{4}-\d{2}/.test(value)) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return monthLabel(d);
  }
  return value;
}

/**
 * When salary for a wage period must be paid, and how that stands today.
 * One definition shared by the generator's countdown, the bell and the email.
 */
export function salaryDeadline(periodEnd: Date, today: Date): {
  ended: boolean; deadline: Date; daysLeft: number; overdue: boolean;
} {
  const deadline = new Date(periodEnd.getTime());
  deadline.setDate(deadline.getDate() + SALARY_DEADLINE_DAYS);
  const daysLeft = daysBetween(today, deadline);
  // Day-level: the period's last day is still a working day, whatever the hour.
  return { ended: startOfDay(today) > periodEnd, deadline, daysLeft, overdue: daysLeft < 0 };
}

/**
 * The most recent ended wage period this employee is owed for, if a reminder
 * should chase it. Only the latest one: anyone further behind is already being
 * told about this one, and older months would nag a company about payroll it
 * simply was not running in the app yet.
 * On the anniversary basis last month's period may still be running, so this
 * looks one month further back for the latest one that has ended.
 */
export function salaryDue(emp: Employee, today: Date): PayPeriod | null {
  const day = startOfDay(today);
  for (let back = 1; back <= 2; back++) {
    const month = new Date(day.getFullYear(), day.getMonth() - back, 1);
    if (day <= periodBounds(emp, month.getFullYear(), month.getMonth()).end) continue;
    const period = payPeriod(emp, month.getFullYear(), month.getMonth());
    return period && isRemindable(emp, period) ? period : null;
  }
  return null;
}

const isPaid = (p: Payslip): boolean => p.Payment_Transferred === true;

/**
 * Everything currently needing attention, worst first. Grouped rather than one
 * row per record: "4 staff unpaid for September" is actionable, forty separate
 * lines are wallpaper.
 */
export function buildNotifications(
  db: DatabaseState,
  profiles: CompanyProfile[],
  today: Date = new Date(),
): AppNotification[] {
  const out: AppNotification[] = [];
  const branches = profiles.length ? profiles : [];

  // ── Salary, per branch per wage month ──
  branches.forEach(profile => {
    const branch = outletLabel(profile);
    const groups = new Map<string, { owed: Employee[]; unpaid: Employee[]; end: Date | null }>();
    db.employees
      .filter(e => e.Assigned_Outlet === profile.id || e.Branch_Location === branch)
      .forEach(e => {
        const period = salaryDue(e, today);
        if (!period) return;
        const g = groups.get(period.label) || { owed: [], unpaid: [], end: null };
        groups.set(period.label, g);
        g.owed.push(e);
        const paid = db.payslips.some(p =>
          p.Employee_ID === e.Employee_ID && normaliseMonthLabel(p.Month_Year) === period.label && isPaid(p));
        if (paid) return;
        g.unpaid.push(e);
        // Anniversary periods end on different days; chase the earliest deadline.
        if (!g.end || period.end < g.end) g.end = period.end;
      });

    groups.forEach(({ owed, unpaid, end }, label) => {
      if (!unpaid.length || !end) return;
      const { daysLeft, overdue } = salaryDeadline(end, today);
      const who = unpaid.length === 1
        ? unpaid[0].Employee_Name
        : `${unpaid.length} of ${owed.length} staff`;
      const names = unpaid.slice(0, 3).map(e => e.Employee_Name).join(', ');
      const more = unpaid.length > 3 ? ` +${unpaid.length - 3} more` : '';

      out.push({
        id: `salary:${profile.id}:${label}`,
        kind: overdue ? 'salary-overdue' : 'salary-due',
        severity: overdue ? 'danger' : 'warning',
        title: overdue
          ? `Salary overdue — ${label}`
          : `Salary due in ${daysLeft} day${daysLeft === 1 ? '' : 's'} — ${label}`,
        detail: overdue
          ? `${who} unpaid at ${branch}, ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} past the 7-day deadline. ${names}${more}`
          : `${who} still to be paid at ${branch}. ${names}${more}`,
        view: 'payroll',
      });
    });
  });

  // ── Invoices left unsettled ──
  const overdueInvoices = db.invoices.filter(inv => {
    const issued = parseLocalDate(inv.Date);
    if (!issued || daysBetween(issued, today) < INVOICE_OVERDUE_DAYS) return false;
    return getPaymentSummary(inv, db.payments).balance > 0.005;
  });
  if (overdueInvoices.length) {
    const owed = overdueInvoices.reduce(
      (sum, inv) => sum + getPaymentSummary(inv, db.payments).balance, 0);
    const currency = profiles[0]?.currency_symbol || 'RM';
    out.push({
      id: `invoice-overdue:${overdueInvoices.length}`,
      kind: 'invoice-overdue',
      severity: 'warning',
      title: `${overdueInvoices.length} invoice${overdueInvoices.length === 1 ? '' : 's'} unpaid over ${INVOICE_OVERDUE_DAYS} days`,
      detail: `${currency} ${owed.toFixed(2)} outstanding. Oldest: ${overdueInvoices[0].Invoice_ID} (${overdueInvoices[0].Customer_Name}).`,
      view: 'invoicing',
    });
  }

  // ── Quotations about to lapse, or already lapsed, and never billed ──
  db.quotations.forEach(q => {
    if (q.Converted_Invoice_ID) return;
    const until = parseLocalDate(q.Valid_Until);
    if (!until) return;
    const left = daysBetween(today, until);
    if (left < -QUOTATION_NOTICE_DAYS || left > QUOTATION_NOTICE_DAYS) return;
    out.push({
      id: `quotation:${q.Quotation_ID}`,
      kind: left < 0 ? 'quotation-expired' : 'quotation-expiring',
      severity: left < 0 ? 'info' : 'warning',
      title: left < 0
        ? `Quotation expired — ${q.Quotation_ID}`
        : `Quotation expires in ${left} day${left === 1 ? '' : 's'} — ${q.Quotation_ID}`,
      detail: `${q.Customer_Name}, valid until ${q.Valid_Until}. Not yet converted to an invoice.`,
      view: 'quotations',
    });
  });

  const rank = { danger: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
