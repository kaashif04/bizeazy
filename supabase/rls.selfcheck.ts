/**
 * Access-control check: `npx tsx supabase/rls.selfcheck.ts`
 *
 * Replays every biz-platform migration (the shared database's whole schema) inside PGlite (Postgres compiled to WebAssembly) with
 * stand-ins for what Supabase provides — the anon/authenticated roles, its
 * default grants, auth.users and auth.uid() — then signs in as different people
 * and checks what each can see and change. This is the boundary between one
 * company's books and another's, so it is tested, not trusted.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, readdirSync } from 'fs';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

const db = new PGlite({ extensions: { pgcrypto } });

// ── What a Supabase project starts with (the same stand-ins as biz-platform's replay) ──
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema extensions;
  create schema auth;
  create table auth.users (
    id uuid primary key, email text, phone text, instance_id uuid, aud text, role text,
    raw_user_meta_data jsonb not null default '{}', email_confirmed_at timestamptz,
    phone_confirmed_at timestamptz, created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub', '')::uuid $$;
  create function auth.role() returns text language sql stable as
    $$ select current_setting('request.jwt.claims', true)::jsonb->>'role' $$;
  create publication supabase_realtime;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now());
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
    name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  create function storage.filename(name text) returns text language sql immutable as
    $$ select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
  grant usage on schema auth, storage to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  grant all on storage.objects to authenticated;
`);

// The schema lives in biz-platform now: replay all of it, every app's.
const dir = process.env.BIZ_PLATFORM_MIGRATIONS || `${homedir()}/biz-platform/supabase/migrations`;
for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec('begin;\n' + readFileSync(join(dir, file), 'utf8') + '\ncommit;');
}

// ── Two companies and four people ──
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const admin = '00000000-0000-0000-0000-000000000001';     // A, admin
const clerk = '00000000-0000-0000-0000-000000000002';     // A, payroll only
const gone = '00000000-0000-0000-0000-000000000003';      // A, deactivated
const rival = '00000000-0000-0000-0000-000000000004';     // B, admin
await db.exec(`
  insert into auth.users (id) values ('${admin}'), ('${clerk}'), ('${gone}'), ('${rival}');
  insert into public.companies (id, name) values ('${A}', 'A Sdn Bhd'), ('${B}', 'B Sdn Bhd');
  insert into public.hub_users (user_id, company_id, user_code, display_id, role, modules, active) values
    ('${admin}', '${A}', 'boss',  'Boss',  'admin',  '{}',          true),
    ('${clerk}', '${A}', 'clerk', 'Clerk', 'member', '{payroll}',   true),
    ('${gone}',  '${A}', 'gone',  'Gone',  'member', '{invoicing}', false),
    ('${rival}', '${B}', 'rival', 'Rival', 'admin',  '{}',          true);
`);

/** Run as a signed-in user (or anon), exactly as PostgREST would. */
async function as<T = any>(who: string | null, sql: string, params: any[] = []): Promise<T[]> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(who ? { sub: who, role: 'authenticated' } : { role: 'anon' })]);
  await db.exec(`set role ${who ? 'authenticated' : 'anon'}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}
async function fails(who: string | null, sql: string, params: any[] = []): Promise<boolean> {
  try { await as(who, sql, params); return false; } catch { return true; }
}
const change = (upserts: any[], deletes: any[] = []): [string, any[]] =>
  [`select public.hub_apply_changes($1::jsonb, $2::jsonb)`, [JSON.stringify(upserts), JSON.stringify(deletes)]];

// ── An admin saves across modules ──
await as(admin, ...change([
  { kind: 'invoices', id: 'INV-1', data: { Invoice_ID: 'INV-1', Total_Amount: 770 } },
  { kind: 'employees', id: 'EMP-1', data: { Employee_ID: 'EMP-1', Basic_Salary: 1800 } },
  { kind: 'customers', id: 'acme|a1', data: { Customer_Name: 'Acme' } },
]));
ok((await as(admin, `select * from public.hub_records`)).length === 3, 'the admin sees all three records');

// Saving the same id again updates it; it never adds a second row.
await as(admin, ...change([{ kind: 'employees', id: 'EMP-1', data: { Employee_ID: 'EMP-1', Basic_Salary: 2000 } }]));
const emp = await as(admin, `select data from public.hub_records where kind = 'employees'`);
ok(emp.length === 1 && emp[0].data.Basic_Salary === 2000, 'a re-save updates in place, no duplicate');

// ── A member only reaches their modules ──
const clerkSees = (await as(clerk, `select kind from public.hub_records order by kind`)).map((r: any) => r.kind);
ok(clerkSees.join() === 'customers,employees', `payroll-only sees employees and shared customers, got ${clerkSees}`);
ok(await fails(clerk, ...change([{ kind: 'invoices', id: 'INV-2', data: {} }])), 'payroll-only cannot write an invoice');
ok(await fails(clerk, ...change([], [{ kind: 'invoices', id: 'INV-1' }])) === false, 'a delete outside their modules is a no-op, not an error');
ok((await as(admin, `select 1 from public.hub_records where id = 'INV-1'`)).length === 1, '…and the invoice is still there');
await as(clerk, ...change([{ kind: 'payslips', id: 'PAY-1', data: { Payslip_ID: 'PAY-1' } }]));
ok((await as(admin, `select 1 from public.hub_records where id = 'PAY-1'`)).length === 1, 'payroll-only can write a payslip');

// ── Companies never see each other ──
ok((await as(rival, `select * from public.hub_records`)).length === 0, 'another company sees none of A\'s records');
ok((await as(rival, `select * from public.hub_users`)).length === 1, 'another company sees only its own people');
ok((await as(rival, `select public.hub_session()->'company'->>'name' as n`))[0].n === 'B Sdn Bhd', 'a Hub user sees their own company through hub_session()');
ok((await as(rival, `select * from public.companies`)).length === 0, '…the core table itself is BizPos-only, so nothing leaks through it');
ok(await fails(rival, `insert into public.hub_records (company_id, kind, id, data) values ($1, 'invoices', 'X', '{}')`, [A]),
   'writing into another company\'s book is refused');
await as(rival, ...change([], [{ kind: 'invoices', id: 'INV-1' }]));
ok((await as(admin, `select 1 from public.hub_records where id = 'INV-1'`)).length === 1, 'deleting another company\'s record does nothing');
await as(rival, ...change([{ kind: 'invoices', id: 'INV-1', data: { hijacked: true } }]));
const mine = await as(admin, `select data from public.hub_records where id = 'INV-1'`);
ok(mine.length === 1 && !mine[0].data.hijacked, 'the same id in another company is a separate record, not an overwrite');

// ── Deactivated and signed-out people get nothing ──
ok((await as(gone, `select * from public.hub_records`)).length === 0, 'a deactivated user reads nothing');
ok(await fails(gone, ...change([{ kind: 'invoices', id: 'INV-9', data: {} }])), 'a deactivated user cannot save');
ok(await fails(null, `select * from public.hub_records`) || (await as(null, `select * from public.hub_records`)).length === 0,
   'signed out, the records are invisible');
ok(await fails(null, ...change([{ kind: 'invoices', id: 'INV-9', data: {} }])), 'signed out, saving is refused');
ok(await fails(null, `select public.hub_current_company()`), 'signed out, the lookup functions are not callable');

// ── Nobody edits their own access ──
await as(clerk, `update public.hub_users set role = 'admin', modules = '{invoicing,payroll,settings}' where user_id = $1`, [clerk])
  .catch(() => undefined);
const clerkRow = await as(admin, `select role, modules from public.hub_users where user_id = $1`, [clerk]);
ok(clerkRow[0].role === 'member' && clerkRow[0].modules.join() === 'payroll', 'a member cannot promote themselves');

// ── Settings ──
await as(admin, `select public.hub_replace_config($1::jsonb)`, [JSON.stringify({ main: { store_name: 'A1' }, old: { x: 1 } })]);
await as(admin, `select public.hub_replace_config($1::jsonb)`, [JSON.stringify({ main: { store_name: 'A1 Bistro' } })]);
const cfg = await as(admin, `select key, value from public.hub_config`);
ok(cfg.length === 1 && cfg[0].value.store_name === 'A1 Bistro', 'saving settings replaces the set: changed key updated, dropped key removed');
ok((await as(clerk, `select * from public.hub_config`)).length === 1, 'every member can read settings (branch names, currency)');
ok(await fails(clerk, `select public.hub_replace_config($1::jsonb)`, ['{}']), 'only the settings module may change them');
ok((await as(admin, `select 1 from public.hub_config`)).length === 1, '…so a refused change leaves them intact');

// ── Deleting ──
await as(admin, ...change([], [{ kind: 'customers', id: 'acme|a1' }]));
ok((await as(admin, `select 1 from public.hub_records where kind = 'customers'`)).length === 0, 'a delete removes exactly that row');

// ── Staff, managers, attendance and leave ──
const staff = '00000000-0000-0000-0000-000000000005';      // A, staff, is EMP-1
const boss2 = '00000000-0000-0000-0000-000000000006';      // A, manager (team)
await db.exec(`
  insert into auth.users (id) values ('${staff}'), ('${boss2}');
  insert into public.hub_users (user_id, company_id, user_code, display_id, role, modules, active, employee_id) values
    ('${staff}', '${A}', 'aisyah', 'Aisyah', 'staff',  '{}',     true, 'EMP-1'),
    ('${boss2}', '${A}', 'mgr',    'Mgr',    'member', '{team}', true, 'EMP-2');
`);
ok(await db.query(`insert into public.hub_users (user_id, company_id, user_code, display_id, role)
  values ('${rival}', '${A}', 'nolink', 'NoLink', 'staff')`).then(() => false, () => true),
  'a staff login must be linked to an employee');

await as(admin, ...change([
  { kind: 'employees', id: 'EMP-2', data: { Employee_ID: 'EMP-2', Employee_Name: 'Ravi' } },
  { kind: 'customers', id: 'walkin|a1', data: { Customer_Name: 'Walk-in' } },
  { kind: 'payslips', id: 'PAY-1', data: { Payslip_ID: 'PAY-1', Employee_ID: 'EMP-1', Is_Saved: true } },
  { kind: 'payslips', id: 'PAY-2', data: { Payslip_ID: 'PAY-2', Employee_ID: 'EMP-1', Is_Saved: false } },
  { kind: 'payslips', id: 'PAY-3', data: { Payslip_ID: 'PAY-3', Employee_ID: 'EMP-2', Is_Saved: true } },
]));
const staffSees = (await as(staff, `select kind, id from public.hub_records order by kind, id`)).map((r: any) => `${r.kind}:${r.id}`);
ok(staffSees.join() === 'employees:EMP-1,payslips:PAY-1',
   `staff see only their own employee row and saved payslips, got ${staffSees}`);
ok((await as(staff, `select user_id from public.hub_users`)).length === 1, 'staff see only their own profile');
ok(await fails(staff, ...change([{ kind: 'employees', id: 'EMP-1', data: { Basic_Salary: 99999 } }])),
   'staff cannot change their own employee record');
ok((await as(boss2, `select id from public.hub_records where kind = 'employees'`)).length === 2, 'a manager reads every employee');
const mgrSlips = (await as(boss2, `select id from public.hub_records where kind = 'payslips'`)).map((r: any) => r.id);
ok(mgrSlips.join() === 'PAY-3', `…but without payroll, only their own payslip, got ${mgrSlips}`);

// Scans in Malaysia time (UTC+8). Day 1 is a late shift past midnight.
await db.exec(`
  insert into public.attendance_events (company_id, employee_id, method, occurred_at) values
    ('${A}', 'EMP-1', 'fingerprint', '2026-09-01 22:00+08'), ('${A}', 'EMP-1', 'fingerprint', '2026-09-02 01:30+08'),
    ('${A}', 'EMP-1', 'fingerprint', '2026-09-02 08:55+08'), ('${A}', 'EMP-1', 'fingerprint', '2026-09-02 18:05+08'),
    ('${A}', 'EMP-1', 'fingerprint', '2026-09-03 09:30+08'),
    ('${A}', 'EMP-2', 'fingerprint', '2026-09-02 09:00+08');
  insert into public.attendance_events (company_id, employee_id, method, occurred_at) values
    ('${B}', 'EMP-1', 'fingerprint', '2026-09-02 09:00+08');
`);
const days = await as(staff, `select work_date::text as d, worked_minutes as m, open, late, last_out from public.attendance_days order by work_date`);
ok(days.map((d: any) => d.d).join() === '2026-09-01,2026-09-02,2026-09-03', `staff see their own days only, got ${days.map((d: any) => d.d)}`);
ok(days[0].m === 210 && !days[0].open, 'a shift past midnight is one working day of 3 h 30 m');
ok(days[1].m === 550 && !days[1].late && !days[1].open, '08:55–18:05 is 9 h 10 m and on time');
ok(days[2].open && days[2].late && days[2].last_out === null, 'a single 09:30 scan is open and late');
ok((await as(boss2, `select 1 from public.attendance_days`)).length === 4, 'a manager sees everyone in the company');
ok((await as(rival, `select 1 from public.attendance_days`)).length === 1, 'another company sees only its own scans');

ok(await fails(staff, `select public.hub_add_manual_event('EMP-1', now() - interval '1 hour', 'forgot')`), 'staff cannot add scans');
ok(await fails(staff, `insert into public.attendance_events (company_id, employee_id, method, occurred_at) values ($1, 'EMP-1', 'manual', now())`, [A]),
   'staff cannot insert scans directly');
await as(boss2, `select public.hub_add_manual_event('EMP-1', '2026-09-03 18:00+08', 'missed clock-out')`);
let d3 = (await as(staff, `select open, has_manual, worked_minutes as m from public.attendance_days where work_date = '2026-09-03'`))[0];
ok(!d3.open && d3.has_manual && d3.m === 510, 'a manager\'s missed clock-out closes the day and is flagged');
const [{ id: manualId }] = await as(boss2, `select id from public.attendance_events where method = 'manual'`);
ok(await fails(boss2, `select public.hub_void_event($1, '  ')`, [manualId]), 'removing a scan needs a reason');
await as(boss2, `select public.hub_void_event($1, 'wrong time')`, [manualId]);
d3 = (await as(staff, `select open from public.attendance_days where work_date = '2026-09-03'`))[0];
ok(d3.open, 'a voided scan is ignored');
ok(await fails(boss2, `select public.hub_add_manual_event('EMP-9', now() - interval '1 hour', '')`), 'scans only for this company\'s employees');

// Leave. Dates are the first full week of December this year, Monday onwards.
const year = new Date().getFullYear();
const mon = new Date(Date.UTC(year, 11, 1));
while (mon.getUTCDay() !== 1) mon.setUTCDate(mon.getUTCDate() + 1);
const day = (n: number) => new Date(mon.getTime() + n * 86400000).toISOString().slice(0, 10);
ok(await fails(staff, `insert into public.leave_types (company_id, name, days_per_year) values ($1, 'Annual', 5)`, [A]),
   'staff cannot set up leave types');
const [{ id: annual }] = await as(boss2, `insert into public.leave_types (company_id, name, days_per_year) values ($1, 'Annual', 5) returning id`, [A]);
const [{ id: unpaid }] = await as(boss2, `insert into public.leave_types (company_id, name, days_per_year, paid) values ($1, 'Unpaid', 0, false) returning id`, [A]);
const ask = (who: string, type: string, a: string, b: string, half = false) =>
  as(who, `select public.hub_request_leave($1, $2::date, $3::date, $4, 'family') as id`, [type, a, b, half]);

const [{ id: req1 }] = await ask(staff, annual, day(0), day(2));
ok((await as(staff, `select days from public.leave_requests where id = $1`, [req1]))[0].days == 3, 'Mon–Wed is three working days');
ok(await fails(staff, `select public.hub_request_leave($1, $2::date, $3::date, false, '')`, [annual, day(1), day(1)]), 'overlapping leave is refused');
ok(await fails(staff, `select public.hub_request_leave($1, $2::date, $3::date, false, '')`, [annual, day(7), day(9)]), 'leave beyond the balance is refused');
ok(await fails(staff, `select public.hub_request_leave($1, $2::date, $3::date, true, '')`, [annual, day(7), day(8)]), 'a half day spans one date');
ok(await fails(staff, `select public.hub_request_leave($1, $2::date, $3::date, false, '')`, [annual, day(6), day(6)]), 'a Sunday alone has no working days');
const [{ id: req2 }] = await ask(staff, unpaid, day(14), day(18));
ok((await as(staff, `select days from public.leave_requests where id = $1`, [req2]))[0].days == 5, 'unpaid leave has no yearly limit');
const [{ id: half }] = await ask(staff, annual, day(7), day(7), true);
ok((await as(staff, `select days from public.leave_requests where id = $1`, [half]))[0].days == 0.5, 'a half day is half a day');

const bal = (await as(staff, `select taken, pending, remaining from public.leave_balances where leave_type_id = $1`, [annual]))[0];
ok(bal.pending == 3.5 && bal.taken == 0 && bal.remaining == 1.5, `balance counts pending leave, got ${JSON.stringify(bal)}`);
ok((await as(staff, `select remaining from public.leave_balances where leave_type_id = $1`, [unpaid]))[0].remaining === null,
   'a type with no limit has no remaining figure');

ok(await fails(staff, `select public.hub_decide_leave($1, true, '')`, [req1]), 'staff cannot approve leave');
ok(await fails(clerk, `select public.hub_decide_leave($1, true, '')`, [req1]), 'payroll alone cannot approve leave');
ok((await as(clerk, `select 1 from public.leave_requests`)).length === 0, '…nor see the requests');
await as(boss2, `select public.hub_decide_leave($1, true, 'enjoy')`, [req1]);
ok(await fails(boss2, `select public.hub_decide_leave($1, false, '')`, [req1]), 'a decided request stays decided');
ok((await as(staff, `select status from public.leave_requests where id = $1`, [req1]))[0].status === 'approved', 'the staff member sees the approval');
await as(staff, `select public.hub_cancel_leave($1)`, [req1]);
ok((await as(staff, `select status from public.leave_requests where id = $1`, [req1]))[0].status === 'cancelled',
   'approved leave that has not started can be cancelled');
ok(await fails(staff, `select public.hub_cancel_leave($1)`, [req1]), 'a cancelled request cannot be cancelled again');
ok(await fails(boss2, `select public.hub_cancel_leave($1)`, [req2]), 'only the requester cancels');
ok((await as(rival, `select 1 from public.leave_requests`)).length === 0, 'another company sees none of the leave');

// Shifts: each person their own. Aisyah (EMP-1) works Mon–Fri 10:00–19:00 and
// Saturday nights 22:00–02:00; Sunday is off.
const week = [1, 2, 3, 4, 5].map(d => ({ weekday: d, start: '10:00', end: '19:00' }))
  .concat([{ weekday: 6, start: '22:00', end: '02:00' }]);
ok(await fails(staff, `select public.hub_set_shift('EMP-1', $1::jsonb)`, [JSON.stringify(week)]), 'staff cannot set their own shift');
ok(await fails(clerk, `select public.hub_set_shift('EMP-1', $1::jsonb)`, [JSON.stringify(week)]), 'payroll alone cannot set shifts');
await as(boss2, `select public.hub_set_shift('EMP-1', $1::jsonb)`, [JSON.stringify(week)]);
ok((await as(staff, `select 1 from public.employee_shifts`)).length === 6, 'staff read their own week');
await as(boss2, `select public.hub_set_shift('EMP-2', $1::jsonb)`, [JSON.stringify([{ weekday: 1, start: '07:00', end: '15:00' }])]);
ok((await as(staff, `select employee_id from public.employee_shifts where employee_id = 'EMP-2'`)).length === 0, "…but not anyone else's");
ok((await as(rival, `select 1 from public.employee_shifts`)).length === 0, 'another company sees no shifts');

// 2026-09-02 (Wed) 08:55 was on time for 09:00; against a 10:00 shift it still is.
// 2026-09-03 (Thu) 09:30 was late against 09:00; against 10:00 it is early.
let byDay = Object.fromEntries((await as(staff, `select work_date::text as d, late, scheduled, shift_start::text as s from public.attendance_days`)).map((r: any) => [r.d, r]));
ok(byDay['2026-09-03'].late === false && byDay['2026-09-03'].s === '10:00:00', 'lateness follows the person\'s own start time');
await db.exec(`insert into public.attendance_events (company_id, employee_id, method, occurred_at) values
  ('${A}', 'EMP-1', 'fingerprint', '2026-09-05 22:20+08'), ('${A}', 'EMP-1', 'fingerprint', '2026-09-06 02:05+08'),
  ('${A}', 'EMP-1', 'fingerprint', '2026-09-07 10:25+08'),
  ('${A}', 'EMP-1', 'fingerprint', '2026-09-13 11:00+08')`);
byDay = Object.fromEntries((await as(staff, `select work_date::text as d, late, scheduled, worked_minutes as m from public.attendance_days`)).map((r: any) => [r.d, r]));
ok(byDay['2026-09-05'].late && byDay['2026-09-05'].m === 225, 'a Saturday night shift 22:20–02:05 is late and 3 h 45 m');
ok(byDay['2026-09-07'].late, '10:25 on a 10:00 Monday is late');
ok(byDay['2026-09-13'].scheduled === false && byDay['2026-09-13'].late === false, 'working on a day off is never late');
const ravi = (await as(boss2, `select late, scheduled from public.attendance_days where employee_id = 'EMP-2' and work_date = '2026-09-02'`))[0];
ok(ravi.scheduled === false && !ravi.late, 'Ravi only works Mondays, so Wednesday is a day off for him');

// Leave counts the person's own working days: Mon–Sun is 6 for Aisyah, not the company's 6 of Mon–Sat by chance.
const [{ id: req3 }] = await ask(staff, unpaid, day(21), day(27));
ok((await as(staff, `select days from public.leave_requests where id = $1`, [req3]))[0].days == 6, 'a week of leave is her six shift days');
ok(await fails(staff, `select public.hub_request_leave($1, $2::date, $3::date, false, '')`, [unpaid, day(34), day(34)]), 'leave on a day off is refused');
await as(boss2, `select public.hub_set_shift('EMP-1', '[]'::jsonb)`);
ok((await as(staff, `select 1 from public.employee_shifts`)).length === 0, 'an empty week puts her back on company hours');
ok((await as(staff, `select scheduled from public.attendance_days where work_date = '2026-09-13'`))[0].scheduled === false,
   '…where Sunday is not a work day');
ok((await as(rival, `select public.hub_leave_days($1, 'EMP-1', $2::date, $3::date, false) as n`, [A, day(0), day(6)]))[0].n == 0,
   'another company cannot count A\'s working days');

// Payslip PDFs in Storage.
const pdf = (who: string, path: string) =>
  as(who, `insert into storage.objects (bucket_id, name) values ('payslips', $1)`, [path]);
await pdf(clerk, `${A}/EMP-1/PAY-1.pdf`);
await pdf(clerk, `${A}/EMP-2/PAY-3.pdf`);
ok(await fails(staff, `insert into storage.objects (bucket_id, name) values ('payslips', $1)`, [`${A}/EMP-1/x.pdf`]), 'staff cannot upload payslips');
ok(await fails(rival, `insert into storage.objects (bucket_id, name) values ('payslips', $1)`, [`${A}/EMP-1/x.pdf`]), 'another company cannot upload into A');
const files = (await as(staff, `select name from storage.objects`)).map((r: any) => r.name);
ok(files.join() === `${A}/EMP-1/PAY-1.pdf`, `staff read only their own payslip PDFs, got ${files}`);
ok((await as(clerk, `select 1 from storage.objects`)).length === 2, 'payroll reads every payslip PDF');
ok((await as(rival, `select 1 from storage.objects`)).length === 0, 'another company reads none');

// ── The shared core: branches, apps and links between apps ──
const sql = (q: string, params: any[] = []) => db.query<any>(q, params).then(r => r.rows);

// Branches. Earlier, A saved settings with branches 'main' and 'old', then dropped 'old'.
let outletsA = await sql(`select hub_key, name, is_active from public.outlets where company_id = $1 order by hub_key`, [A]);
ok(outletsA.map((o: any) => `${o.hub_key}:${o.name}:${o.is_active}`).join() === 'main:A1 Bistro:true,old:old:false',
   `each Hub branch is a shared outlet, a removed one only deactivated, got ${JSON.stringify(outletsA)}`);
await as(admin, `select public.hub_replace_config($1::jsonb)`, [JSON.stringify({
  main: { store_name: 'A1 Bistro Damansara', address: '16G Jalan PJU 5/20D' },
  'Nasi Kandar': { store_name: "Kiya's Restaurant", address: '14A Jalan Datuk Sulaiman' },
  settings: { payroll_scope: 'company' },
})]);
outletsA = await sql(`select hub_key, name, address, is_active from public.outlets where company_id = $1 and is_active order by hub_key`, [A]);
const byKey = Object.fromEntries(outletsA.map((o: any) => [o.hub_key, o]));
ok(outletsA.length === 2 && byKey.main?.name === 'A1 Bistro Damansara' && byKey.main?.address === '16G Jalan PJU 5/20D'
   && byKey['Nasi Kandar']?.name === "Kiya's Restaurant", 'renames and a legacy key like "Nasi Kandar" reach the shared outlet');
ok((await sql(`select 1 from public.outlets where company_id = $1 and hub_key = 'settings'`, [A])).length === 0, 'settings is not a branch');
ok((await sql(`select count(*)::int n from public.outlet_settings s join public.outlets o on o.id = s.outlet_id where o.company_id = $1`, [A]))[0].n === 3,
   'each new outlet gets its POS settings');
ok((await as(admin, `select name from public.hub_branches()`)).length === 3, 'a Hub user lists their branches');
ok((await as(rival, `select name from public.hub_branches()`)).every((b: any) => !/Bistro|Kiya/.test(b.name)), "…and never another company's");
ok(await fails(clerk, `select 1 from public.outlets`) || (await as(clerk, `select 1 from public.outlets`)).length === 0,
   'the outlets table itself stays BizPos-only');
ok(await fails(clerk, `select public.hub_replace_config('{}'::jsonb)`), 'only the settings module changes branches');

// Apps.
const apps = (await sql(`select company_id, app from public.company_apps order by company_id, app`)).map((r: any) => `${r.company_id.slice(-1)}:${r.app}`);
ok(apps.includes('a:hub') && apps.includes('b:hub'), `a company with Hub logins is a Hub customer, got ${apps}`);
ok((await as(admin, `select public.hub_session()->'apps' as a`))[0].a.join() === 'hub', 'hub_session lists the apps (no POS yet)');
const st = (await as(staff, `select public.hub_session() as s`))[0].s;
ok(st.user.role === 'staff' && st.user.employee_id === 'EMP-1' && st.company.id === A, 'hub_session describes a staff login');

// POS → Hub: a BizPos owner of company C starts using the Hub. C has a POS branch the Hub has never seen.
const C = '00000000-0000-0000-0000-00000000000c';
const posOwner = '00000000-0000-0000-0000-000000000007', posManager = '00000000-0000-0000-0000-000000000008';
await db.exec(`
  insert into auth.users (id, email, raw_user_meta_data) values
    ('${posOwner}', 'kim.owner@cafe.my', '{"app":"bizpos"}'), ('${posManager}', 'lee@cafe.my', '{"app":"bizpos"}');
  insert into public.companies (id, name) values ('${C}', 'Cafe Kim Sdn Bhd');
  insert into public.outlets (id, company_id, name, address) values ('00000000-0000-0000-0000-0000000000c1', '${C}', 'Cafe Kim Bangsar', 'Jalan Telawi');
  insert into public.profiles (id, outlet_id, company_id, full_name, role) values
    ('${posOwner}',   '00000000-0000-0000-0000-0000000000c1', '${C}', 'Kim', 'owner'),
    ('${posManager}', '00000000-0000-0000-0000-0000000000c1', '${C}', 'Lee', 'manager');
`);
ok((await as(posOwner, `select public.hub_session() as s`))[0].s.linkable.name === 'Cafe Kim Sdn Bhd', 'a POS owner is offered "Use Cafe Kim Sdn Bhd"');
ok((await as(posManager, `select public.hub_session() as s`))[0].s === null, '…a POS manager is not');
ok(await fails(posManager, `select public.hub_link_from_pos()`), 'only a POS owner can link');
const linked = (await as(posOwner, `select * from public.hub_link_from_pos()`))[0];
ok(linked.company_id === C && linked.role === 'admin' && linked.user_code === 'kim.owner' && linked.display_id === 'kim.owner@cafe.my',
   `the owner becomes a Hub admin of the same company, got ${JSON.stringify(linked)}`);
ok((await as(posOwner, `select * from public.hub_link_from_pos()`))[0].user_id === posOwner
   && (await sql(`select count(*)::int n from public.hub_users where company_id = $1`, [C]))[0].n === 1, 'linking twice changes nothing');
const cfgC = await as(posOwner, `select key, value->>'store_name' as n from public.hub_config`);
ok(cfgC.length === 1 && cfgC[0].n === 'Cafe Kim Bangsar' && /^outlet-/.test(cfgC[0].key), "the POS branch becomes a Hub branch");
ok((await sql(`select hub_key from public.outlets where company_id = $1`, [C]))[0].hub_key === cfgC[0].key, '…tied to the same outlet, not a copy');
ok((await sql(`select count(*)::int n from public.companies`))[0].n === 3, 'no second company');
ok((await as(posOwner, `select public.hub_session()->'apps' as a`))[0].a.join() === 'hub,pos', 'the Hub knows C also uses the POS (Open POS)');
ok((await as(posOwner, `select 1 from public.hub_records`)).length === 0, "…and sees none of A's books");

// Hub → POS (the platform's functions, now that hub_users exists): A's admin sets up the POS.
const cand = (await as(admin, `select public.hub_link_candidates() as c`))[0].c;
ok(cand.company.id === A && cand.branches.length === 3, 'BizPos offers the Hub admin their company and branches');
ok((await as(clerk, `select public.hub_link_candidates() as c`))[0].c === null, '…not a Hub member who is not an admin');
const main = (await sql(`select id from public.outlets where company_id = $1 and hub_key = 'main'`, [A]))[0].id;
await as(admin, `select public.pos_link_from_hub($1::uuid, null)`, [main]);
ok((await sql(`select role, company_id from public.profiles where id = $1`, [admin]))[0].role === 'owner', 'the Hub admin becomes the POS owner of the same company');
ok((await as(admin, `select public.hub_session()->'apps' as a`))[0].a.join() === 'hub,pos', 'and the Hub now shows Open POS');

// Signed out, nothing.
ok(await fails(null, `select public.hub_session()`), 'signed out, hub_session is not callable');
ok(await fails(null, `select public.hub_link_from_pos()`), 'signed out, linking is not callable');
ok(await fails(null, `select * from public.hub_records`) || (await as(null, `select * from public.hub_records`)).length === 0, 'signed out, no records');

console.log('All row-level security self-checks passed.');
