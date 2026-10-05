/**
 * Runnable check for the local-copy merge: `npx tsx src/sheetsService.selfcheck.ts`.
 * The sheet is the record; a browser's leftover copy may only fill its gaps.
 */
import { mergeLocalExtras } from './sheetsService';
import { Employee, Payslip } from './types';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

const emp = { Employee_ID: 'E1', Citizenship: 'PR', Joining_Date: '2026-01-01', Age: 40 } as Employee;
const slip = { Payslip_ID: 'S1', Is_Saved: false, Payment_Transferred: false, Transfer_Date: '' } as Payslip;

// Another device changed Citizenship to PR; this browser still holds "Foreigner".
let r = mergeLocalExtras(
  [emp], [{ Employee_ID: 'E1', Citizenship: 'PR', Joining_Date: '', Age: 40 }],
  { E1: { Citizenship: 'Foreigner', Joining_Date: '2025-06-01', Age: 39 } },
  [], [], {},
);
ok(r.employees[0].Citizenship === 'PR', 'a filled cell must beat a stale local copy');
ok(r.employees[0].Age === 40, 'a filled number cell must win too');
ok(r.employees[0].Joining_Date === '2025-06-01', 'a blank cell is filled from the local copy');

const falseCell = mergeLocalExtras([emp], [{ Employee_ID: 'E1', Employer_Bears_Statutory: false }],
  { E1: { Employer_Bears_Statutory: true } }, [], [], {});
ok(falseCell.employees[0].Employer_Bears_Statutory === undefined, 'FALSE is a value, not a gap');

// A payment marked while offline: the sheet still says FALSE.
r = mergeLocalExtras([], [], {},
  [slip], [{ Payslip_ID: 'S1', Is_Saved: true, Payment_Transferred: false, Transfer_Date: '' }],
  { S1: { Payment_Transferred: true, Transfer_Date: '5 October 2026', Is_Saved: true } });
ok(r.payslips[0].Payment_Transferred === true, 'a recorded payment must survive a failed sync');
ok(r.payslips[0].Transfer_Date === '5 October 2026', 'and so must its date, while the cell is blank');

r = mergeLocalExtras([], [], {},
  [{ ...slip, Transfer_Date: '1 October 2026' }], [{ Payslip_ID: 'S1', Transfer_Date: '1 October 2026' }],
  { S1: { Transfer_Date: '5 October 2026' } });
ok(r.payslips[0].Transfer_Date === '1 October 2026', 'a transfer date on the sheet wins');

ok(mergeLocalExtras([emp], [], {}, [slip], [], {}).employees[0] === emp, 'no local copy leaves the row untouched');

console.log('All sheetsService self-checks passed.');
