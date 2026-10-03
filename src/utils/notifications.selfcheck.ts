/**
 * Runnable check for the reminder rules: `npx tsx src/utils/notifications.selfcheck.ts`.
 *
 * The salary deadline carries a legal meaning (Employment Act s.19, 7 days
 * after the wage period), so the boundaries are pinned here rather than eyeballed.
 * Dates are fixed, never `new Date()`, or the suite would pass or fail by month.
 */
import { readFileSync } from 'fs';
import { DatabaseState, CompanyProfile, Employee, Payslip, Invoice, Quotation } from '../types';
import {
  buildNotifications, salaryDeadline, owedForMonth, parseLocalDate,
  normaliseMonthLabel, monthLabel, SALARY_DEADLINE_DAYS,
} from './notifications';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

const outlet = (id: string, name: string): CompanyProfile => ({
  id, name, store_name: name, address: '', email: '', phone: '', currency_symbol: 'RM',
} as CompanyProfile);

const emp = (over: Partial<Employee> & { Employee_ID: string }): Employee => ({
  Employee_Name: over.Employee_ID, IC_Passport: '', Position: 'Staff',
  Assigned_Outlet: 'b1', Basic_Salary: 2000, Bank_Details: '', Branch_Location: 'Main',
  ...over,
} as Employee);

const slip = (over: Partial<Payslip> & { Employee_ID: string; Month_Year: string }): Payslip => ({
  Payslip_ID: `PS-${over.Employee_ID}-${over.Month_Year}`, Issue_Date: '',
  Basic_Pay: 2000, Custom_Allowances: 0, Total_Allowances: 0,
  Employee_EPF: 0, Employer_EPF: 0, Employee_SOCSO: 0, Employer_SOCSO: 0,
  Employee_EIS: 0, Employer_EIS: 0, Employee_SKBBK: 0,
  Total_Statutory_Deductions: 0, Custom_Deductions: 0, Employer_Statutory_Offset: 0,
  Final_Net_Pay: 2000, Branch_Location: 'Main', Is_Saved: true,
  ...over,
} as Payslip);

const empty = (): DatabaseState => ({
  invoices: [], invoice_items: [], payments: [], customers: [],
  employees: [], payslips: [], quotations: [], quotation_days: [], quotation_items: [],
});

// ── Date parsing: the UTC trap ──
ok(parseLocalDate('2026-05-15')!.getMonth() === 4, 'May must parse as month index 4');
ok(parseLocalDate('2026-05-15')!.getDate() === 15, 'a local parse must not shift the day across a timezone');
ok(parseLocalDate('') === null, 'empty must not parse');
ok(parseLocalDate('not a date') === null, 'nonsense must not parse');
ok(parseLocalDate('2026-05-15T08:00:00Z')!.getDate() === 15, 'a timestamp must still yield its own day');

ok(normaliseMonthLabel('September 2026') === 'September 2026', 'an already-formatted label is left alone');
ok(normaliseMonthLabel('2026-09-01') === 'September 2026', 'an ISO month must become a label');
ok(normaliseMonthLabel('') === '', 'blank stays blank');

// ── The 7-day deadline, at its boundaries ──
const sepEnd = new Date(2026, 8, 30);                 // 30 September 2026
ok(!salaryDeadline(sepEnd, new Date(2026, 8, 20)).ended, 'a month still running has not ended');
ok(salaryDeadline(sepEnd, new Date(2026, 9, 1)).ended, 'the 1st of next month means it ended');

const onDeadline = salaryDeadline(sepEnd, new Date(2026, 9, 7));   // 7 October
ok(onDeadline.daysLeft === 0 && !onDeadline.overdue, `the deadline day itself is not yet overdue (got ${onDeadline.daysLeft})`);
const dayAfter = salaryDeadline(sepEnd, new Date(2026, 9, 8));
ok(dayAfter.overdue && dayAfter.daysLeft === -1, `the day after is overdue by 1 (got ${dayAfter.daysLeft})`);
ok(salaryDeadline(sepEnd, new Date(2026, 9, 3)).daysLeft === 4, 'three days in leaves four to go');
ok(SALARY_DEADLINE_DAYS === 7, 'the statutory window is 7 days');

// ── Eligibility ──
const oct5 = new Date(2026, 9, 5);
ok(owedForMonth(emp({ Employee_ID: 'E1' }), sepEnd, oct5), 'a long-serving employee is owed');
ok(!owedForMonth(emp({ Employee_ID: 'E2' }), new Date(2026, 9, 31), oct5), 'the current month is not owed yet');
ok(!owedForMonth(emp({ Employee_ID: 'E3', Joining_Date: '2026-10-02' }), sepEnd, oct5),
   'someone who joined after month end is not owed for it');
ok(owedForMonth(emp({ Employee_ID: 'E4', Joining_Date: '2026-09-15' }), sepEnd, new Date(2026, 9, 20)),
   'a mid-month joiner is owed once a full month has passed');
ok(!owedForMonth(emp({ Employee_ID: 'E5', Joining_Date: '2026-09-15' }), sepEnd, new Date(2026, 9, 10)),
   'a mid-month joiner is not owed before their first full month');
ok(owedForMonth(emp({ Employee_ID: 'E6', Joining_Date: '2026-09-30' }), sepEnd, new Date(2026, 10, 1)),
   'joining on the last day of the month is still owed for that month');
ok(!owedForMonth(emp({ Employee_ID: 'E7', Joining_Date: '2026-10-01' }), sepEnd, new Date(2026, 10, 1)),
   'joining the day after month end is not');

// ── Salary notifications ──
const profiles = [outlet('b1', 'Main Branch')];
const db = empty();
db.employees = [
  emp({ Employee_ID: 'E1', Employee_Name: 'Aisha' }),
  emp({ Employee_ID: 'E2', Employee_Name: 'Ben' }),
];

let notes = buildNotifications(db, profiles, new Date(2026, 9, 3));   // 3 Oct, inside the window
let salary = notes.filter(n => n.kind === 'salary-due' || n.kind === 'salary-overdue');
ok(salary.length === 1,
   `only the most recent ended month nags, not every unpaid month in history, got ${salary.length}`);
ok(salary[0].title.includes('September 2026'), 'and that month is September, not August or July');
ok(salary[0].kind === 'salary-due' && salary[0].severity === 'warning', 'inside the window is a warning, not a danger');
ok(salary[0].detail.includes('Aisha'), 'the names of the unpaid must be shown');

notes = buildNotifications(db, profiles, new Date(2026, 9, 20));      // 20 Oct, past it
salary = notes.filter(n => n.kind === 'salary-overdue');
ok(salary.length === 1 && salary[0].severity === 'danger', 'past the deadline is a danger');
ok(salary[0].title.includes('September 2026'), 'the month must be named');

// A generated-but-unpaid payslip is still unpaid. This is the case that matters:
// marking Is_Saved is not the same as having paid anyone.
db.payslips = [slip({ Employee_ID: 'E1', Month_Year: 'September 2026', Payment_Transferred: false })];
notes = buildNotifications(db, profiles, new Date(2026, 9, 20));
ok(notes.some(n => n.kind === 'salary-overdue'), 'an unpaid payslip must not silence the reminder');

// Paying one of two leaves one.
db.payslips = [slip({ Employee_ID: 'E1', Month_Year: 'September 2026', Payment_Transferred: true })];
notes = buildNotifications(db, profiles, new Date(2026, 9, 20));
const remaining = notes.find(n => n.kind === 'salary-overdue');
ok(!!remaining && remaining.detail.includes('Ben'), 'the one still unpaid must be named');
ok(!remaining!.detail.includes('Aisha'), 'the one already paid must not be');

// Paying everyone clears it entirely.
db.payslips.push(slip({ Employee_ID: 'E2', Month_Year: 'September 2026', Payment_Transferred: true }));
notes = buildNotifications(db, profiles, new Date(2026, 9, 20));
ok(!notes.some(n => n.kind.startsWith('salary')), 'everyone paid means no salary reminder');

// An ISO Month_Year must count as the same month as the label form.
db.payslips = [
  slip({ Employee_ID: 'E1', Month_Year: '2026-09-01', Payment_Transferred: true }),
  slip({ Employee_ID: 'E2', Month_Year: '2026-09-01', Payment_Transferred: true }),
];
notes = buildNotifications(db, profiles, new Date(2026, 9, 20));
ok(!notes.some(n => n.kind.startsWith('salary')), 'an ISO Month_Year must match the same month');

// ── Invoices ──
const idb = empty();
idb.invoices = [
  { Invoice_ID: 'INV-1', Date: '2026-08-01', Company: 'b1', Customer_Name: 'Acme',
    Customer_Type: 'Regular', Status: 'Pending', Total_Amount: 500 } as Invoice,
  { Invoice_ID: 'INV-2', Date: '2026-10-01', Company: 'b1', Customer_Name: 'Fresh Co',
    Customer_Type: 'Regular', Status: 'Pending', Total_Amount: 300 } as Invoice,
];
notes = buildNotifications(idb, profiles, new Date(2026, 9, 3));
const inv = notes.find(n => n.kind === 'invoice-overdue');
ok(!!inv, 'an invoice unpaid for two months must be reported');
ok(inv!.title.includes('1 invoice'), `only the old one counts, got "${inv!.title}"`);
ok(inv!.detail.includes('500.00'), 'the outstanding balance must be stated');

// Settled in full → nothing to chase.
idb.payments = [{ Payment_ID: 'P1', Invoice_ID: 'INV-1', Amount: 500, Date: '2026-08-10' }];
notes = buildNotifications(idb, profiles, new Date(2026, 9, 3));
ok(!notes.some(n => n.kind === 'invoice-overdue'), 'a fully paid invoice must not be chased');

// Part-paid → still chased, for the remainder only.
idb.payments = [{ Payment_ID: 'P1', Invoice_ID: 'INV-1', Amount: 200, Date: '2026-08-10' }];
notes = buildNotifications(idb, profiles, new Date(2026, 9, 3));
ok(notes.find(n => n.kind === 'invoice-overdue')!.detail.includes('300.00'),
   'a part-paid invoice must report only the balance');

// ── Quotations ──
const qdb = empty();
const quote = (over: Partial<Quotation> & { Quotation_ID: string }): Quotation => ({
  Date: '2026-09-01', Company: 'b1', Customer_Name: 'Party Co',
  Pricing_Mode: 'itemized', Total_Amount: 1000, ...over,
} as Quotation);
qdb.quotations = [
  quote({ Quotation_ID: 'Q-SOON', Valid_Until: '2026-10-05' }),
  quote({ Quotation_ID: 'Q-FAR', Valid_Until: '2026-12-01' }),
  quote({ Quotation_ID: 'Q-DONE', Valid_Until: '2026-10-05', Converted_Invoice_ID: 'INV-9' }),
  quote({ Quotation_ID: 'Q-ANCIENT', Valid_Until: '2026-01-01' }),
];
notes = buildNotifications(qdb, profiles, new Date(2026, 9, 3));
const qIds = notes.filter(n => n.kind.startsWith('quotation')).map(n => n.id);
ok(qIds.includes('quotation:Q-SOON'), 'a quotation lapsing in two days must be flagged');
ok(!qIds.includes('quotation:Q-FAR'), 'one valid for months must not be');
ok(!qIds.includes('quotation:Q-DONE'), 'one already converted must not be');
ok(!qIds.includes('quotation:Q-ANCIENT'), 'one long expired must not nag forever');

// ── Ordering: the legal deadline outranks the rest ──
const mixed = empty();
mixed.employees = [emp({ Employee_ID: 'E1', Employee_Name: 'Aisha' })];
mixed.quotations = [quote({ Quotation_ID: 'Q-SOON', Valid_Until: '2026-10-22' })];
notes = buildNotifications(mixed, profiles, new Date(2026, 9, 20));
ok(notes[0].severity === 'danger', 'the worst item must come first');

// ── No outlets configured must not throw ──
ok(buildNotifications(mixed, [], new Date(2026, 9, 20)).length >= 0, 'no profiles must not throw');
ok(buildNotifications(empty(), profiles, new Date(2026, 9, 20)).length === 0, 'an empty company has nothing to report');

// ── The mirror: Code.gs re-derives the salary rule for its email reminder,
//    because Apps Script cannot import this file. If the two ever disagree, the
//    bell and the email would name different people as unpaid — so check it here
//    rather than trusting a comment to keep them in step.
{
  const code = readFileSync(new URL('../../Code.gs', import.meta.url), 'utf8');
  // new Function gives a sloppy-mode scope, which Code.gs needs for its
  // top-level `var`/`function` declarations; nothing in it runs at definition time.
  const gas = new Function('Logger', 'PropertiesService', `
    ${code}
    return { owedForMonthGs, normaliseMonthLabelGs, parseLocalDateGs, SALARY_DEADLINE_DAYS, isTruthyCell };
  `)({ log() {} }, { getScriptProperties: () => ({ getProperty: () => null }) });

  ok(gas.SALARY_DEADLINE_DAYS === SALARY_DEADLINE_DAYS,
     `the deadline must match: TS ${SALARY_DEADLINE_DAYS} vs GAS ${gas.SALARY_DEADLINE_DAYS}`);

  const sep = new Date(2026, 8, 30);
  const mirrorCases: [Partial<Employee>, Date, Date, string][] = [
    [{}, sep, new Date(2026, 9, 5), 'no joining date'],
    [{ Joining_Date: '2026-10-02' }, sep, new Date(2026, 9, 5), 'joined after month end'],
    [{ Joining_Date: '2026-09-30' }, sep, new Date(2026, 10, 1), 'joined ON month end'],
    [{ Joining_Date: '2026-10-01' }, sep, new Date(2026, 10, 1), 'joined the day after month end'],
    [{ Joining_Date: '2026-09-15' }, sep, new Date(2026, 9, 20), 'mid-month joiner, full month passed'],
    [{ Joining_Date: '2026-09-15' }, sep, new Date(2026, 9, 10), 'mid-month joiner, too early'],
    [{ Joining_Date: '2020-01-01' }, sep, new Date(2026, 9, 5), 'long serving'],
    [{}, new Date(2026, 9, 31), new Date(2026, 9, 5), 'current month'],
  ];
  mirrorCases.forEach(([e, end, today, what]) => {
    const ts = owedForMonth(e as Employee, end, today);
    const g = gas.owedForMonthGs(e, end, today);
    ok(ts === g, `mirror drift on "${what}": TS ${ts} vs GAS ${g}`);
  });

  ['2026-09-01', 'September 2026', ''].forEach(raw => {
    ok(normaliseMonthLabel(raw) === gas.normaliseMonthLabelGs(raw),
       `mirror drift normalising "${raw}"`);
  });

  const d1 = parseLocalDate('2026-05-15')!;
  const d2 = gas.parseLocalDateGs('2026-05-15');
  ok(d1.getTime() === d2.getTime(), 'mirror drift parsing a date');
}

console.log('All notification self-checks passed (including the Code.gs mirror).');
