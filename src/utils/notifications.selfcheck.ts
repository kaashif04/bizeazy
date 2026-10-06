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
  buildNotifications, salaryDeadline, salaryDue, parseLocalDate,
  normaliseMonthLabel, monthLabel, SALARY_DEADLINE_DAYS,
} from './notifications';
import { payPeriod, periodLabelFor, describePeriod, epfEmployee, epfEmployer, residencyOf, statutory } from './payroll';

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

// ── Wage periods ──
const oct5 = new Date(2026, 9, 5);
const sepCal = payPeriod(emp({ Employee_ID: 'P1', Joining_Date: '2026-09-15' }), 2026, 8)!;
ok(sepCal.daysWorked === 16 && sepCal.daysInPeriod === 30, `calendar: joined 15 Sep works 16 of 30 days (got ${sepCal.daysWorked}/${sepCal.daysInPeriod})`);
ok(payPeriod(emp({ Employee_ID: 'P1', Joining_Date: '2026-09-15' }), 2026, 9)!.fraction === 1, 'calendar: the next month is paid in full');
ok(payPeriod(emp({ Employee_ID: 'P1', Joining_Date: '2026-09-15' }), 2026, 7) === null, 'nothing is owed before joining');
ok(describePeriod(sepCal) === '15 Sep – 30 Sep 2026 · 16 of 30 days', `period text, got "${describePeriod(sepCal)}"`);

const anniv = emp({ Employee_ID: 'P2', Joining_Date: '2026-09-15', Pay_Basis: 'anniversary' });
const sepAnn = payPeriod(anniv, 2026, 8)!;
ok(sepAnn.fraction === 1 && sepAnn.end.getMonth() === 9 && sepAnn.end.getDate() === 14,
   'anniversary: "September" runs 15 Sep – 14 Oct and is paid in full');
ok(periodLabelFor(anniv, new Date(2026, 9, 3)) === 'September 2026', 'anniversary: 3 Oct falls in the September period');
ok(periodLabelFor(anniv, new Date(2026, 9, 20)) === 'October 2026', 'anniversary: 20 Oct falls in October');
ok(periodLabelFor(emp({ Employee_ID: 'P3' }), new Date(2026, 9, 3)) === 'October 2026', 'calendar: 3 Oct is October');

const jan31 = emp({ Employee_ID: 'P4', Joining_Date: '2026-01-31', Pay_Basis: 'anniversary' });
const feb = payPeriod(jan31, 2026, 1)!;
ok(feb.start.getDate() === 28 && feb.end.getMonth() === 2 && feb.end.getDate() === 30,
   'anniversary: a 31st joiner\'s February period clamps to 28 Feb – 30 Mar');

const leaver = emp({ Employee_ID: 'P5', Joining_Date: '2020-01-01', End_Date: '2026-10-10' });
ok(payPeriod(leaver, 2026, 9)!.daysWorked === 10, 'a leaver on 10 Oct is paid 10 of 31 days');
ok(payPeriod(leaver, 2026, 10) === null, 'and nothing after');
const annLeaver = emp({ Employee_ID: 'P6', Joining_Date: '2026-09-15', Pay_Basis: 'anniversary', End_Date: '2026-09-24' });
ok(payPeriod(annLeaver, 2026, 8)!.daysWorked === 10, 'anniversary leaver is prorated over their final period');

// ── Who a reminder chases ──
ok(salaryDue(emp({ Employee_ID: 'E1' }), oct5)!.label === 'September 2026', 'long serving: last month is due');
ok(!salaryDue(emp({ Employee_ID: 'E3', Joining_Date: '2026-10-02' }), oct5), 'joined after last month: nothing due');
ok(salaryDue(emp({ Employee_ID: 'E4', Joining_Date: '2026-09-15' }), oct5)!.daysWorked === 16,
   'calendar: a mid-month joiner is due their part month as soon as it ends');
ok(!salaryDue(anniv, oct5), 'anniversary: 15 Sep – 14 Oct has not ended on 5 Oct');
ok(salaryDue(anniv, new Date(2026, 9, 20))!.label === 'September 2026', 'and is due once it has');
ok(salaryDue(emp({ Employee_ID: 'E5', Joining_Date: '2024-03-15', Pay_Basis: 'anniversary' }), oct5)!.label === 'August 2026',
   'anniversary, long serving: on 5 Oct the latest ended period is August (15 Aug – 14 Sep)');
ok(salaryDue(emp({ Employee_ID: 'E6' }), new Date(2026, 8, 30, 15))!.label === 'August 2026',
   'on the last day of a month, at any hour, that month has not ended — August is still the latest');

const backdated = emp({ Employee_ID: 'E7', Joining_Date: '2023-03-01', Registered_On: '2026-10-05' });
ok(!salaryDue(backdated, new Date(2026, 9, 20)), 'registered 5 Oct: September back pay is never chased');
ok(payPeriod(backdated, 2026, 8) !== null, 'but September can still be generated');
ok(salaryDue(backdated, new Date(2026, 10, 3))!.label === 'October 2026', 'October, the month registered, is chased');
ok(!salaryDue(leaver, new Date(2026, 11, 3)), 'nothing is chased after the last working day');
ok(salaryDue(leaver, new Date(2026, 10, 3))!.daysWorked === 10, 'but the final part month is');

// ── EPF: PR and citizen part ways only at 60 ──
ok(epfEmployee(3000, 'PR', 30) === epfEmployee(3000, 'Malaysian', 30), 'below 60 a PR pays as a citizen');
ok(epfEmployer(3000, 'PR', 30) === 390, 'employer 13% up to RM5,000');
ok(epfEmployee(3000, 'Malaysian', 61) === 0 && epfEmployer(3000, 'Malaysian', 61) === 120, 'citizen 60+: 0% / 4%');
ok(epfEmployee(3000, 'PR', 61) === 165 && epfEmployer(3000, 'PR', 61) === 195, 'PR 60+: 5.5% / 6.5%');
ok(epfEmployer(6000, 'PR', 61) === 360, 'PR 60+ above RM5,000: employer 6%');
ok(epfEmployee(3000, 'Malaysian/PR', 61) === 0, 'the old combined value is charged as a citizen, as it always was');
ok(epfEmployee(3000, 'Foreigner', 30) === 60, 'foreign worker 2%');
ok(residencyOf(undefined) === 'Malaysian', 'blank reads as Malaysian');

// ── Figures from the published schedules ──
// EPF rows are copied from the KWSP Third Schedule. PERKESO rows at RM25, 1,800,
// 3,000, 5,000, 6,000 and above are copied from the June 2026 table (SKBBK at
// 2,000/3,000/6,000 and EIS at 2,000/5,000/6,000 from published examples); the
// remaining cells follow the schedule's own band rule (midpoint, up to 5 sen).
// KWSP Third Schedule, Part A (Malaysian / PR below 60): [wage, employer, employee]
([
  [10, 0, 0], [15, 3, 3], [50, 8, 7], [1790, 234, 198], [1800, 234, 198],
  [2010, 263, 223], [3000, 390, 330], [5050, 612, 561], [12050, 1452, 1331], [15050, 1812, 1661],
] as const).forEach(([wage, er, ee]) => {
  ok(epfEmployer(wage, 'Malaysian', 30) === er, `EPF employer on RM${wage}: schedule ${er}, got ${epfEmployer(wage, 'Malaysian', 30)}`);
  ok(epfEmployee(wage, 'Malaysian', 30) === ee, `EPF employee on RM${wage}: schedule ${ee}, got ${epfEmployee(wage, 'Malaysian', 30)}`);
});
ok(epfEmployee(25000, 'Malaysian', 30) === 2750 && epfEmployer(25000.5, 'Malaysian', 30) === 3001,
   'above RM20,000 the wage itself is charged, rounded up to the ringgit');

// PERKESO schedule (June 2026): [wage, SOCSO employer, SOCSO employee, injury-only employer (60+), SKBBK, EIS each]
([
  [25,   0.40,   0.10,  0.30,  0.20, 0.05],
  [1800, 30.65,  8.75,  21.90, 13.15, 3.50],
  [2000, 34.15,  9.75,  24.40, 14.65, 3.90],
  [3000, 51.65,  14.75, 36.90, 22.15, 5.90],
  [5000, 86.65,  24.75, 61.90, 37.15, 9.90],
  [6000, 104.15, 29.75, 74.40, 44.65, 11.90],
  [9000, 104.15, 29.75, 74.40, 44.65, 11.90],
] as const).forEach(([wage, er, ee, injury, skbbk, eis]) => {
  const young = statutory(wage, { Citizenship: 'Malaysian', Age: 30 });
  ok(young.socsoEmployer === er && young.socsoEmployee === ee,
     `SOCSO on RM${wage}: schedule ${er}/${ee}, got ${young.socsoEmployer}/${young.socsoEmployee}`);
  ok(young.skbbk === skbbk, `SKBBK on RM${wage}: schedule ${skbbk}, got ${young.skbbk}`);
  ok(young.eisEmployee === eis && young.eisEmployer === eis, `EIS on RM${wage}: schedule ${eis}, got ${young.eisEmployee}`);
  const senior = statutory(wage, { Citizenship: 'Malaysian', Age: 61 });
  ok(senior.socsoEmployer === injury && senior.socsoEmployee === 0,
     `60+ SOCSO on RM${wage}: employer ${injury}, employee nothing; got ${senior.socsoEmployer}/${senior.socsoEmployee}`);
});

// Who pays what
const at = (who: Parameters<typeof statutory>[1]) => statutory(3000, who);
ok(at({ Citizenship: 'Malaysian', Age: 61 }).eisEmployee === 0, 'no EIS from 60');
ok(at({ Citizenship: 'Malaysian', Age: 61 }).skbbk === 22.15, 'SKBBK continues at 60+ (no age limit)');
ok(at({ Citizenship: 'Malaysian', Age: 30, SKBBK_Opted_Out: true }).skbbk === 0, 'a local who opted out pays no SKBBK');
ok(at({ Citizenship: 'PR', Age: 30 }).skbbk === 22.15 && at({ Citizenship: 'PR', Age: 30 }).eisEmployee === 5.90,
   'a PR is a local: SKBBK by default, EIS');
ok(at({ Citizenship: 'Foreigner', Age: 30, SKBBK_Opted_Out: true }).skbbk === 22.15, 'a foreign worker cannot opt out of SKBBK');
ok(at({ Citizenship: 'Foreigner', Age: 30 }).eisEmployee === 0, 'no EIS for foreign workers');
ok(at({ Citizenship: 'Foreigner', Age: 30 }).socsoEmployee === 14.75, 'foreign workers pay First Category SOCSO like locals');
ok(at({ Citizenship: 'Foreigner', Age: 30 }).epfEmployee === 60, 'foreign worker EPF 2%');
ok(at({ Citizenship: 'PR', Age: 61 }).epfEmployee === 165 && at({ Citizenship: 'PR', Age: 61 }).epfEmployer === 195, 'PR 60+ EPF 5.5% / 6.5%');

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
    return { salaryDueGs, payPeriodGs, normaliseMonthLabelGs, parseLocalDateGs, SALARY_DEADLINE_DAYS, isTruthyCell };
  `)({ log() {} }, { getScriptProperties: () => ({ getProperty: () => null }) });

  ok(gas.SALARY_DEADLINE_DAYS === SALARY_DEADLINE_DAYS,
     `the deadline must match: TS ${SALARY_DEADLINE_DAYS} vs GAS ${gas.SALARY_DEADLINE_DAYS}`);

  const same = (a: any, b: any) => (a === null || b === null)
    ? a === b
    : a.label === b.label && a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime()
      && a.daysWorked === b.daysWorked && a.daysInPeriod === b.daysInPeriod;
  const mirrorCases: [Partial<Employee>, Date, string][] = [
    [{}, new Date(2026, 9, 5), 'no dates'],
    [{ Joining_Date: '2026-10-02' }, new Date(2026, 9, 5), 'joined after the period'],
    [{ Joining_Date: '2026-09-30' }, new Date(2026, 10, 1), 'joined on the last day'],
    [{ Joining_Date: '2026-09-15' }, new Date(2026, 9, 5), 'calendar part month'],
    [{ Joining_Date: '2026-09-15', Pay_Basis: 'anniversary' }, new Date(2026, 9, 5), 'anniversary, running'],
    [{ Joining_Date: '2026-09-15', Pay_Basis: 'anniversary' }, new Date(2026, 9, 20), 'anniversary, ended'],
    [{ Joining_Date: '2024-03-15', Pay_Basis: 'anniversary' }, new Date(2026, 9, 5), 'anniversary, long serving, looks two months back'],
    [{ Joining_Date: '2026-01-31', Pay_Basis: 'anniversary' }, new Date(2026, 2, 31), 'anniversary, 31st clamp'],
    [{ Joining_Date: '2020-01-01', End_Date: '2026-09-10' }, new Date(2026, 9, 5), 'leaver, final part month'],
    [{ Joining_Date: '2020-01-01', End_Date: '2026-08-10' }, new Date(2026, 9, 5), 'leaver, after'],
    [{ Joining_Date: '2020-01-01', Registered_On: '2026-10-02' }, new Date(2026, 9, 5), 'registered after the period'],
    [{ Joining_Date: '2020-01-01', Registered_On: '2026-09-02' }, new Date(2026, 9, 5), 'registered within it'],
    [{}, new Date(2026, 8, 30, 15), 'last day of the month, afternoon'],
  ];
  mirrorCases.forEach(([e, today, what]) => {
    ok(same(salaryDue(e as Employee, today), gas.salaryDueGs(e, today)), `mirror drift on "${what}"`);
    ok(same(payPeriod(e as Employee, 2026, 8), gas.payPeriodGs(e, 2026, 8)), `mirror drift on the period for "${what}"`);
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
