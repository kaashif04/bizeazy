/**
 * Round trip: `npx tsx src/sync.selfcheck.ts`
 *
 * The real sheetsService talks to the real Code.gs + Auth.gs, running against an
 * in-memory spreadsheet that does what Sheets does to values: digit-only text
 * becomes a number (losing leading zeros) and "YYYY-MM-DD" becomes a date,
 * unless the column is formatted as text. Every column mapping, the migration of
 * an old sheet, other-branch preservation, dedupe and the local-copy cleanup are
 * checked end to end, because each of those has silently lost data here before.
 */
import { readFileSync } from 'fs';
import type { DatabaseState, Employee, Payslip } from './types';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

// ── A spreadsheet that behaves like one ──────────────────────────────────────
class FakeSheet {
  grid: any[][] = [];
  textCols = new Set<number>();
  constructor(public name: string, private ss: FakeSpreadsheet) {}
  getName() { return this.name; }
  setName(n: string) { this.name = n; }
  getParent() { return this.ss; }
  getMaxRows() { return Math.max(1000, this.grid.length); }
  getLastRow() {
    for (let r = this.grid.length - 1; r >= 0; r--) if ((this.grid[r] || []).some(v => v !== '' && v !== undefined)) return r + 1;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.grid.forEach(row => (row || []).forEach((v, c) => { if (v !== '' && v !== undefined) max = Math.max(max, c + 1); }));
    return max;
  }
  appendRow(values: any[]) { this.getRange(this.getLastRow() + 1, 1, 1, values.length).setValues([values]); }
  getRange(r: number, c: number, nr = 1, nc = 1) {
    const sh = this;
    const cells = (fn: (row: number, col: number, i: number, j: number) => void) => {
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) fn(r - 1 + i, c - 1 + j, i, j);
    };
    return {
      getValues: () => Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => sh.grid[r - 1 + i]?.[c - 1 + j] ?? '')),
      setValues: (v: any[][]) => cells((row, col, i, j) => {
        (sh.grid[row] ||= [])[col] = sh.coerce(v[i][j], col + 1);
      }),
      clearContent: () => cells((row, col) => { if (sh.grid[row]) sh.grid[row][col] = ''; }),
      setNumberFormat: (f: string) => { for (let j = 0; j < nc; j++) if (f === '@') sh.textCols.add(c + j); },
      getNumberFormat: () => (sh.textCols.has(c) ? '@' : 'General'),
    };
  }
  /** What Sheets does to a typed string in a General-format cell. */
  coerce(v: any, col: number) {
    if (typeof v !== 'string' || this.textCols.has(col)) return v;
    if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/.test(v)) {
      const [name, y] = v.split(' ');
      return new Date(Number(y), ['January','February','March','April','May','June','July','August','September','October','November','December'].indexOf(name), 1);
    }
    return v;
  }
}

class FakeSpreadsheet {
  sheets: FakeSheet[] = [];
  getSheetByName(n: string) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n: string) { const s = new FakeSheet(n, this); this.sheets.push(s); return s; }
  getSpreadsheetTimeZone() { return 'Asia/Kuala_Lumpur'; }
}

const ss = new FakeSpreadsheet();
const pad = (n: number) => String(n).padStart(2, '0');

// An existing sheet from before this release: the old 12-column Employees tab,
// holding a second branch's employee the current branch must never disturb.
const legacy = ss.insertSheet('Employees');
legacy.getRange(1, 1, 1, 12).setValues([[
  'Employee_ID','Employee_Name','IC_Passport','Position','Assigned_Outlet','Basic_Salary',
  'Bank_Details','Branch_Location','Citizenship','Age','Joining_Date','Employer_Bears_Statutory',
]]);
legacy.textCols.add(11);
legacy.getRange(2, 1, 1, 12).setValues([[
  'EMP-00001','Other Branch Cook','880101-14-5555','Cook','b2',2200,
  'CIMB: 7001','Branch Two','Malaysian/PR',38,'2024-02-01',false,
]]);

// ── Load the real Apps Script, with only the session lookup stubbed ──────────
const gs = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8')
  + '\n' + readFileSync(new URL('../Auth.gs', import.meta.url), 'utf8');
const SESSION = { token: 't', isAdmin: true, modules: ['invoicing', 'quotations', 'payroll', 'settings'], spreadsheetId: 'sheet-1',
  user: { userId: 'admin', role: 'admin', modules: [] }, company: { id: 'c1' } };
const gas = new Function('SpreadsheetApp', 'LockService', 'Utilities', 'Logger', 'PropertiesService', `
  ${gs}
  resolveSession = function() { return SESSION; };
  return { handleAction: handleAction };
`.replace('SESSION;', JSON.stringify(SESSION) + ';'))(
  { openById: () => ss, getActiveSpreadsheet: () => ss },
  { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  { formatDate: (d: Date, _tz: string, f: string) => f === 'yyyy-MM-dd'
      ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : `${d.getHours()}:${pad(d.getMinutes())}` },
  { log() {} },
  { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
);

// The browser: storage, a signed-in admin, and fetch wired straight to doPost's handler.
const mem = () => { const m = new Map<string, string>(); return {
  getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); },
  removeItem: (k: string) => { m.delete(k); }, get size() { return m.size; } }; };
const g = globalThis as any;
g.window = g;
g.localStorage = mem();
g.sessionStorage = mem();
g.fetch = async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  const out = gas.handleAction(body.action, body, body.token);
  return { ok: true, statusText: 'OK', text: async () => JSON.stringify(out) };
};

const { saveSession } = await import('./auth');
const { fetchDataAll, syncStateToSheets, saveEmployeeExtras, savePayslipExtras } = await import('./sheetsService');
saveSession({ ...SESSION, expires_at: new Date(Date.now() + 3600e3).toISOString() } as any, true);

const profiles = [
  { id: 'b1', name: 'A1 Bistro', store_name: 'A1 Bistro' },
  { id: 'b2', name: 'Branch Two', store_name: 'Branch Two' },
] as any[];
const load = async () => (await fetchDataAll('sheet-1', '', profiles)) as DatabaseState;

// ── 1. Reading an old sheet ──
let db = await load();
const header = ss.getSheetByName('Employees')!.getRange(1, 1, 1, 16).getValues()[0];
ok(header.slice(12).join() === 'Pay_Basis,End_Date,Registered_On,Advances_JSON',
   `new columns must be appended after the old ones, got ${header.join()}`);
let other = db.employees.find(e => e.Employee_ID === 'EMP-00001')!;
ok(other && other.Employee_Name === 'Other Branch Cook' && other.Joining_Date === '2024-02-01',
   'an old row must read back unshifted after the migration');
ok(other.Pay_Basis === 'calendar' && !other.End_Date && other.Advances!.length === 0,
   'an old row reads the new fields as their defaults');

// ── 2. Writing everything the new release adds ──
const newbie: Employee = {
  Employee_ID: 'EMP-12345', Employee_Name: 'Aisyah', IC_Passport: '010203141234', Position: 'Cashier',
  Assigned_Outlet: 'b1', Basic_Salary: 1800, Bank_Details: '0123456789', Branch_Location: 'A1 Bistro',
  Citizenship: 'PR', Age: 61, Joining_Date: '2023-03-15', Employer_Bears_Statutory: true,
  Pay_Basis: 'anniversary', End_Date: '2026-10-20', Registered_On: '2026-10-05',
  Advances: [{ id: 'ADV-a', date: '2026-10-03', amount: 250.5, note: 'Medical, "urgent"' }],
};
const slip: Payslip = {
  Payslip_ID: 'PAY-EMP-12345-September-2026', Employee_ID: 'EMP-12345', Issue_Date: '2026-10-05',
  Month_Year: 'September 2026', Basic_Pay: 1800, Custom_Allowances: 0, Total_Allowances: 0,
  Employee_EPF: 99, Employer_EPF: 117, Employee_SOCSO: 0, Employer_SOCSO: 22.5, Employee_EIS: 0,
  Employer_EIS: 0, Employee_SKBBK: 0, Total_Statutory_Deductions: 99, Custom_Deductions: 250.5,
  Employer_Statutory_Offset: 99, Final_Net_Pay: 1549.5, Branch_Location: 'A1 Bistro', Is_Saved: true,
  Allowances_JSON: '[]', Deductions_JSON: JSON.stringify([{ description: 'Salary advance 2026-10-03', amount: 250.5, advance_id: 'ADV-a' }]),
  Payment_Transferred: true, Transfer_Date: '6 October 2026', Pay_Period: '15 Sep – 14 Oct 2026',
};
db = { ...db, employees: [...db.employees, newbie], payslips: [slip] };
saveEmployeeExtras(newbie.Employee_ID, { Citizenship: 'PR', Age: 61 });
savePayslipExtras(slip.Payslip_ID, { Is_Saved: true, Payment_Transferred: true });
await syncStateToSheets('sheet-1', '', db, profiles, 'A1 Bistro');

db = await load();
const back = db.employees.find(e => e.Employee_ID === 'EMP-12345')!;
(['IC_Passport', 'Bank_Details', 'Citizenship', 'Age', 'Joining_Date', 'Employer_Bears_Statutory',
  'Pay_Basis', 'End_Date', 'Registered_On'] as (keyof Employee)[]).forEach(k =>
  ok(back[k] === newbie[k], `employee ${k} must round-trip: sent ${JSON.stringify(newbie[k])}, got ${JSON.stringify(back[k])}`));
ok(JSON.stringify(back.Advances) === JSON.stringify(newbie.Advances), `advances must round-trip, got ${JSON.stringify(back.Advances)}`);

const sback = db.payslips.find(p => p.Payslip_ID === slip.Payslip_ID)!;
(['Month_Year', 'Basic_Pay', 'Custom_Deductions', 'Final_Net_Pay', 'Employer_Statutory_Offset',
  'Is_Saved', 'Payment_Transferred', 'Transfer_Date', 'Pay_Period', 'Deductions_JSON', 'Issue_Date'] as (keyof Payslip)[]).forEach(k =>
  ok(sback[k] === slip[k], `payslip ${k} must round-trip: sent ${JSON.stringify(slip[k])}, got ${JSON.stringify(sback[k])}`));

// ── 3. The other branch is untouched by this branch's sync ──
other = db.employees.find(e => e.Employee_ID === 'EMP-00001')!;
ok(other.Branch_Location === 'Branch Two' && other.Basic_Salary === 2200 && other.IC_Passport === '880101-14-5555',
   'the other branch\'s employee must survive this branch\'s sync');

// ...including the new fields, once that branch has set them.
db = { ...db, employees: db.employees.map(e => e.Employee_ID === 'EMP-00001'
  ? { ...e, End_Date: '2026-09-30', Advances: [{ id: 'ADV-b', date: '2026-09-02', amount: 100 }] } : e) };
await syncStateToSheets('sheet-1', '', db, profiles, 'Branch Two');
await syncStateToSheets('sheet-1', '', await load(), profiles, 'A1 Bistro');   // the other branch saves next
other = (await load()).employees.find(e => e.Employee_ID === 'EMP-00001')!;
ok(other.End_Date === '2026-09-30' && other.Advances!.length === 1,
   'another branch\'s sync must carry this branch\'s new fields through, not blank them');

// ── 4. No duplicates, however often or however sent ──
db = await load();
await syncStateToSheets('sheet-1', '', { ...db, employees: [...db.employees, ...db.employees] }, profiles, 'A1 Bistro');
await syncStateToSheets('sheet-1', '', await load(), profiles, 'A1 Bistro');
const rows = (name: string) => ss.getSheetByName(name)!.getLastRow() - 1;
ok(rows('Employees') === 2, `two employees must be two rows, found ${rows('Employees')}`);
ok(rows('Payslips') === 1, `one payslip must be one row, found ${rows('Payslips')}`);
db = await load();
ok(new Set(db.employees.map(e => e.Employee_ID)).size === db.employees.length, 'no duplicate employees on read');

// ── 5. The local copies are spent once the sheet has them ──
ok(g.localStorage.getItem('bizeazy_employee_extras') === null, 'employee local copies must be cleared after a sync');
ok(g.localStorage.getItem('bizeazy_payslip_extras') === null, 'payslip local copies must be cleared after a sync');

// ── 6. Two devices, each saving from a copy loaded at a different time ──
// A query string gives each device its own module instance, so its own lastSeen.
type Device = typeof import('./sheetsService');
const service = './sheetsService';
const phone: Device = await import(`${service}?device=phone`);
const laptop: Device = await import(`${service}?device=laptop`);
const loadOn = async (d: typeof phone) => (await d.fetchDataAll('sheet-1', '', profiles)) as DatabaseState;
const edit = (db: DatabaseState, id: string, patch: Partial<Employee>) =>
  ({ ...db, employees: db.employees.map(e => e.Employee_ID === id ? { ...e, ...patch } : e) });
const empOnSheet = async (id: string) => (await load()).employees.find(e => e.Employee_ID === id);

let onPhone = await loadOn(phone);
let onLaptop = await loadOn(laptop);

// Laptop raises Aisyah's salary; the phone, still on its 9am copy, edits the cook.
await laptop.syncStateToSheets('sheet-1', '', edit(onLaptop, 'EMP-12345', { Basic_Salary: 2500 }), profiles, 'A1 Bistro');
await phone.syncStateToSheets('sheet-1', '', edit(onPhone, 'EMP-00001', { Position: 'Head Cook' }), profiles, 'Branch Two');
ok((await empOnSheet('EMP-12345'))!.Basic_Salary === 2500, 'a stale device must not revert an edit made on another');
ok((await empOnSheet('EMP-00001'))!.Position === 'Head Cook', 'and its own edit must land');

// Laptop adds an employee; the phone, which never saw them, saves something else.
onPhone = await loadOn(phone);
onLaptop = await loadOn(laptop);
const zara = { ...newbie, Employee_ID: 'EMP-77777', Employee_Name: 'Zara', Advances: [] } as Employee;
await laptop.syncStateToSheets('sheet-1', '', { ...onLaptop, employees: [...onLaptop.employees, zara] }, profiles, 'A1 Bistro');
await phone.syncStateToSheets('sheet-1', '', edit(onPhone, 'EMP-00001', { Age: 39 }), profiles, 'Branch Two');
ok(!!(await empOnSheet('EMP-77777')), 'an employee added on another device must survive a stale save');

// A payment recorded on the laptop must survive the phone saving an unrelated change.
onPhone = await loadOn(phone);
onLaptop = await loadOn(laptop);
await laptop.syncStateToSheets('sheet-1', '', { ...onLaptop,
  payments: [{ Payment_ID: 'PMT-1', Invoice_ID: 'INV-1', Amount: 300, Date: '2026-10-05', Method: 'Cash', Reference: '00921' }] },
  profiles, 'A1 Bistro');
await phone.syncStateToSheets('sheet-1', '', edit(onPhone, 'EMP-00001', { Age: 40 }), profiles, 'Branch Two');
const pay = (await load()).payments.find(p => p.Payment_ID === 'PMT-1');
ok(!!pay, 'a payment recorded on another device must survive a stale save');
ok(pay!.Reference === '00921', `a payment reference keeps its leading zeros, got ${JSON.stringify(pay!.Reference)}`);

// Deleting on one device sticks, even when a stale device saves afterwards.
onPhone = await loadOn(phone);
onLaptop = await loadOn(laptop);
await laptop.syncStateToSheets('sheet-1', '', { ...onLaptop, employees: onLaptop.employees.filter(e => e.Employee_ID !== 'EMP-77777') }, profiles, 'A1 Bistro');
await phone.syncStateToSheets('sheet-1', '', edit(onPhone, 'EMP-00001', { Age: 41 }), profiles, 'Branch Two');
ok(!(await empOnSheet('EMP-77777')), 'a deletion must not be undone by a stale device');
ok((await empOnSheet('EMP-00001'))!.Age === 41, 'while that device\'s own edit still lands');

// The same person edited on both: the later save wins, and nothing is duplicated.
onPhone = await loadOn(phone);
onLaptop = await loadOn(laptop);
await laptop.syncStateToSheets('sheet-1', '', edit(onLaptop, 'EMP-00001', { Basic_Salary: 2300 }), profiles, 'Branch Two');
await phone.syncStateToSheets('sheet-1', '', edit(onPhone, 'EMP-00001', { Basic_Salary: 2400 }), profiles, 'Branch Two');
ok((await empOnSheet('EMP-00001'))!.Basic_Salary === 2400, 'the same row edited twice: the later save wins');
ok(rows('Employees') === 2, `still two employee rows, found ${rows('Employees')}`);

// ── 7. Failure must write nothing ──
const before = JSON.stringify(ss.getSheetByName('Employees')!.grid);
const realFetch = g.fetch;
g.fetch = async (url: string, init: { body: string }) =>
  JSON.parse(init.body).action === 'fetchDataAll'
    ? { ok: false, status: 503, statusText: '', text: async () => '' }
    : realFetch(url, init);
let threw = false;
try { await phone.syncStateToSheets('sheet-1', '', edit(await loadOn(laptop), 'EMP-00001', { Age: 50 }), profiles, 'Branch Two'); }
catch (err: any) { threw = true; ok(/HTTP 503/.test(err.message), `the error must name the HTTP status, got "${err.message}"`); }
g.fetch = realFetch;
ok(threw, 'a save that cannot read the sheet first must fail loudly');
ok(JSON.stringify(ss.getSheetByName('Employees')!.grid) === before, 'and must not have written anything');

// One bad answer from Google is retried, and the save then goes through.
let blips = 1;
g.fetch = async (url: string, init: { body: string }) =>
  JSON.parse(init.body).action === 'fetchDataAll' && blips-- > 0
    ? { ok: false, status: 503, statusText: '', text: async () => '' }
    : realFetch(url, init);
await phone.syncStateToSheets('sheet-1', '', edit(await loadOn(phone), 'EMP-00001', { Age: 42 }), profiles, 'Branch Two');
g.fetch = realFetch;
ok((await empOnSheet('EMP-00001'))!.Age === 42, 'a single failed read must be retried, not fail the save');

// A save from an emptied copy (as after a sign-out) must not wipe the sheet.
await phone.syncStateToSheets('sheet-1', '', {
  invoices: [], invoice_items: [], payments: [], customers: [], employees: [],
  payslips: [], quotations: [], quotation_days: [], quotation_items: [] }, profiles, 'Branch Two');
ok(rows('Employees') === 2 && rows('Payslips') === 1 && rows('Invoice_Payments') === 1,
   'an empty copy must never read as "delete everything"');

console.log('All sync round-trip self-checks passed.');
