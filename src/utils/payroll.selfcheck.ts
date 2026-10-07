/**
 * Hourly and monthly basic pay: `npx tsx src/utils/payroll.selfcheck.ts`
 */
import { basicPayFor, hourlyLabel, payRateText, isHourly, statutory, ageOn, statutoryAge, dobFromIC, payslipRate } from './payroll';
import type { Employee } from '../types';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };
const base = { Employee_ID: 'E', Employee_Name: 'X', IC_Passport: '', Position: '', Assigned_Outlet: '', Bank_Details: '', Branch_Location: '' };
const monthly: Employee = { ...base, Basic_Salary: 2000 };
const hourly: Employee = { ...base, Basic_Salary: 0, Pay_Type: 'hourly', Hourly_Rate: 9 };

ok(!isHourly(monthly) && isHourly(hourly), 'pay type defaults to monthly');
ok(basicPayFor(monthly, { fraction: 1 }) === 2000, 'a full month pays the salary');
ok(basicPayFor(monthly, { fraction: 0.5 }, 99) === 1000, 'a half month pays half; hours are ignored for monthly staff');
ok(basicPayFor(hourly, { fraction: 0.5 }, 38.5) === 346.5, '38.5 h × RM 9 = RM 346.50, whatever part of the month');
ok(basicPayFor(hourly, { fraction: 1 }, 0) === 0 && basicPayFor(hourly, { fraction: 1 }, -3) === 0, 'no hours, no pay');
ok(basicPayFor({ ...hourly, Hourly_Rate: 8.72 }, { fraction: 1 }, 10.25) === 89.38, 'cents round to 2 places');
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

console.log('All payroll pay self-checks passed.');
