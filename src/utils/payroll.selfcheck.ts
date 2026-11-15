/**
 * Hourly and monthly basic pay: `npx tsx src/utils/payroll.selfcheck.ts`
 */
import { basicPayFor, hourlyLabel, payRateText, isHourly, statutory, ageOn, statutoryAge, dobFromIC, payslipRate, withEarlyPaid, advanceMonth, advanceMonthOptions } from './payroll';
import type { Employee } from '../types';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };
const base = { Employee_ID: 'E', Employee_Name: 'X', IC_Passport: '', Position: '', Assigned_Outlet: '', Bank_Details: '', Branch_Location: '' };
const monthly: Employee = { ...base, Basic_Salary: 2000 };
const hourly: Employee = { ...base, Basic_Salary: 0, Pay_Type: 'hourly', Hourly_Rate: 9 };

ok(!isHourly(monthly) && isHourly(hourly), 'pay type defaults to monthly');
ok(basicPayFor(monthly, { daysWorked: 30, daysInPeriod: 30 }) === 2000, 'a full month pays the salary');
ok(basicPayFor(monthly, { daysWorked: 15, daysInPeriod: 30 }, 99) === 1000, 'a half month pays half; hours are ignored for monthly staff');
ok(basicPayFor(hourly, { daysWorked: 15, daysInPeriod: 30 }, 38.5) === 346.5, '38.5 h × RM 9 = RM 346.50, whatever part of the month');
ok(basicPayFor(hourly, { daysWorked: 30, daysInPeriod: 30 }, 0) === 0 && basicPayFor(hourly, { daysWorked: 30, daysInPeriod: 30 }, -3) === 0, 'no hours, no pay');
ok(basicPayFor({ ...hourly, Hourly_Rate: 8.72 }, { daysWorked: 30, daysInPeriod: 30 }, 10.25) === 89.38, 'cents round to 2 places');
ok(hourlyLabel(38.5, 9) === '38.5 h × RM 9.00' && hourlyLabel(40, 8.72) === '40 h × RM 8.72', 'payslip line');
ok(payRateText(hourly) === 'RM 9.00 / hour' && payRateText(monthly) === 'RM 2,000.00', 'rate shown in the roster');
// Part-timers contribute too: statutory amounts follow the wage actually paid.
ok(statutory(346.5, hourly).epfEmployee > 0 && statutory(346.5, hourly).socsoEmployee > 0, 'EPF and SOCSO apply to hourly pay');

// Age from date of birth.
ok(ageOn('1966-09-15', new Date(2026, 8, 14)) === 59 && ageOn('1966-09-15', new Date(2026, 8, 15)) === 60, 'turns 60 on the birthday');
ok(statutoryAge({ Date_Of_Birth: '1966-09-15' }, new Date(2026, 8, 1)) === 59, 'September (birthday month) still uses the under-60 rates');
ok(statutoryAge({ Date_Of_Birth: '1966-09-15' }, new Date(2026, 9, 1)) === 60, 'October, the month after, uses the 60+ rates');
ok(statutoryAge({ Age: 45 }, new Date()) === 45 && statutoryAge({}, new Date()) === 30, 'no date of birth: the typed age, else 30');
ok(dobFromIC('900101-14-5566') === '1990-01-01' && dobFromIC('050620145566', new Date(2026, 0, 1)) === '2005-06-20', 'MyKad birth date');
ok(dobFromIC('A1234567') === '' && dobFromIC('901301145566') === '', 'not a MyKad: nothing filled in');
const over60 = statutory(2000, { Citizenship: 'Malaysian', Age: statutoryAge({ Date_Of_Birth: '1960-01-01' }, new Date(2026, 8, 1)) });
ok(over60.eisEmployee === 0 && over60.socsoEmployee === 0, 'at 66 no employee SOCSO or EIS');
ok(payslipRate('11%') === ' (11%)' && payslipRate('none from age 60') === '' && payslipRate('none from age 60, employer pays') === '', 'payslip shows rates only');

// Allowances paid before payday are deducted once, never twice.
const early = withEarlyPaid(
  [{ description: 'Bonus', amount: 200, paid_on: '2026-11-10' }, { description: 'Overtime', amount: 50 }],
  [{ description: 'Advance', amount: 100 }, { description: 'Bonus paid 2026-11-01', amount: 999, early_paid: true }],
);
ok(early.length === 2 && early[1].description === 'Bonus paid 2026-11-10' && early[1].amount === 200, 'only the early-paid allowance is deducted, stale lines replaced');

// Advances: recovered in their own month unless another is chosen; choices stop at the end date.
ok(advanceMonth(monthly, { id: 'A', date: '2026-11-16', amount: 100 }) === 'November 2026', 'default: the month it was taken');
ok(advanceMonth(monthly, { id: 'A', date: '2026-11-16', amount: 100, deduct_from: 'January 2027' }) === 'January 2027', 'a chosen month wins');
const opts = advanceMonthOptions({ ...monthly, End_Date: '2027-01-31' }, new Date(2026, 10, 16));
ok(opts.join() === 'September 2026,October 2026,November 2026,December 2026,January 2027', `months offered while employed, got ${opts.join()}`);
const unsaved = advanceMonthOptions({ ...monthly, Joining_Date: '2026-10-01' }, new Date(2026, 10, 16), l => l === 'October 2026');
ok(unsaved[0] === 'November 2026', `a saved or pre-joining month is not offered, got ${unsaved.join()}`);

console.log('All payroll pay self-checks passed.');
