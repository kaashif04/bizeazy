/**
 * Access-control check: `npx tsx supabase/rls.selfcheck.ts`
 *
 * Runs the real migration inside PGlite (Postgres compiled to WebAssembly) with
 * stand-ins for what Supabase provides — the anon/authenticated roles, its
 * default grants, auth.users and auth.uid() — then signs in as different people
 * and checks what each can see and change. This is the boundary between one
 * company's books and another's, so it is tested, not trusted.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'fs';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

const db = new PGlite();

// ── What a Supabase project starts with ──
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);

const dir = new URL('./migrations/', import.meta.url);
for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(new URL(file, dir), 'utf8'));
}

// ── Two companies and four people ──
const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const admin = '00000000-0000-0000-0000-000000000001';     // A, admin
const clerk = '00000000-0000-0000-0000-000000000002';     // A, payroll only
const gone = '00000000-0000-0000-0000-000000000003';      // A, deactivated
const rival = '00000000-0000-0000-0000-000000000004';     // B, admin
await db.exec(`
  insert into auth.users values ('${admin}'), ('${clerk}'), ('${gone}'), ('${rival}');
  insert into public.companies (id, name) values ('${A}', 'A Sdn Bhd'), ('${B}', 'B Sdn Bhd');
  insert into public.profiles (user_id, company_id, user_code, display_id, role, modules, active) values
    ('${admin}', '${A}', 'boss',  'Boss',  'admin',  '{}',          true),
    ('${clerk}', '${A}', 'clerk', 'Clerk', 'member', '{payroll}',   true),
    ('${gone}',  '${A}', 'gone',  'Gone',  'member', '{invoicing}', false),
    ('${rival}', '${B}', 'rival', 'Rival', 'admin',  '{}',          true);
`);

/** Run as a signed-in user (or anon), exactly as PostgREST would. */
async function as<T = any>(who: string | null, sql: string, params: any[] = []): Promise<T[]> {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [who || '']);
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
  [`select public.apply_changes($1::jsonb, $2::jsonb)`, [JSON.stringify(upserts), JSON.stringify(deletes)]];

// ── An admin saves across modules ──
await as(admin, ...change([
  { kind: 'invoices', id: 'INV-1', data: { Invoice_ID: 'INV-1', Total_Amount: 770 } },
  { kind: 'employees', id: 'EMP-1', data: { Employee_ID: 'EMP-1', Basic_Salary: 1800 } },
  { kind: 'customers', id: 'acme|a1', data: { Customer_Name: 'Acme' } },
]));
ok((await as(admin, `select * from public.records`)).length === 3, 'the admin sees all three records');

// Saving the same id again updates it; it never adds a second row.
await as(admin, ...change([{ kind: 'employees', id: 'EMP-1', data: { Employee_ID: 'EMP-1', Basic_Salary: 2000 } }]));
const emp = await as(admin, `select data from public.records where kind = 'employees'`);
ok(emp.length === 1 && emp[0].data.Basic_Salary === 2000, 'a re-save updates in place, no duplicate');

// ── A member only reaches their modules ──
const clerkSees = (await as(clerk, `select kind from public.records order by kind`)).map((r: any) => r.kind);
ok(clerkSees.join() === 'customers,employees', `payroll-only sees employees and shared customers, got ${clerkSees}`);
ok(await fails(clerk, ...change([{ kind: 'invoices', id: 'INV-2', data: {} }])), 'payroll-only cannot write an invoice');
ok(await fails(clerk, ...change([], [{ kind: 'invoices', id: 'INV-1' }])) === false, 'a delete outside their modules is a no-op, not an error');
ok((await as(admin, `select 1 from public.records where id = 'INV-1'`)).length === 1, '…and the invoice is still there');
await as(clerk, ...change([{ kind: 'payslips', id: 'PAY-1', data: { Payslip_ID: 'PAY-1' } }]));
ok((await as(admin, `select 1 from public.records where id = 'PAY-1'`)).length === 1, 'payroll-only can write a payslip');

// ── Companies never see each other ──
ok((await as(rival, `select * from public.records`)).length === 0, 'another company sees none of A\'s records');
ok((await as(rival, `select * from public.profiles`)).length === 1, 'another company sees only its own people');
ok((await as(rival, `select * from public.companies`)).length === 1, 'another company sees only itself');
ok(await fails(rival, `insert into public.records (company_id, kind, id, data) values ($1, 'invoices', 'X', '{}')`, [A]),
   'writing into another company\'s book is refused');
await as(rival, ...change([], [{ kind: 'invoices', id: 'INV-1' }]));
ok((await as(admin, `select 1 from public.records where id = 'INV-1'`)).length === 1, 'deleting another company\'s record does nothing');
await as(rival, ...change([{ kind: 'invoices', id: 'INV-1', data: { hijacked: true } }]));
const mine = await as(admin, `select data from public.records where id = 'INV-1'`);
ok(mine.length === 1 && !mine[0].data.hijacked, 'the same id in another company is a separate record, not an overwrite');

// ── Deactivated and signed-out people get nothing ──
ok((await as(gone, `select * from public.records`)).length === 0, 'a deactivated user reads nothing');
ok(await fails(gone, ...change([{ kind: 'invoices', id: 'INV-9', data: {} }])), 'a deactivated user cannot save');
ok(await fails(null, `select * from public.records`) || (await as(null, `select * from public.records`)).length === 0,
   'signed out, the records are invisible');
ok(await fails(null, ...change([{ kind: 'invoices', id: 'INV-9', data: {} }])), 'signed out, saving is refused');
ok(await fails(null, `select public.current_company()`), 'signed out, the lookup functions are not callable');

// ── Nobody edits their own access ──
await as(clerk, `update public.profiles set role = 'admin', modules = '{invoicing,payroll,settings}' where user_id = $1`, [clerk])
  .catch(() => undefined);
const clerkRow = await as(admin, `select role, modules from public.profiles where user_id = $1`, [clerk]);
ok(clerkRow[0].role === 'member' && clerkRow[0].modules.join() === 'payroll', 'a member cannot promote themselves');

// ── Settings ──
await as(admin, `select public.replace_config($1::jsonb)`, [JSON.stringify({ main: { store_name: 'A1' }, old: { x: 1 } })]);
await as(admin, `select public.replace_config($1::jsonb)`, [JSON.stringify({ main: { store_name: 'A1 Bistro' } })]);
const cfg = await as(admin, `select key, value from public.config`);
ok(cfg.length === 1 && cfg[0].value.store_name === 'A1 Bistro', 'saving settings replaces the set: changed key updated, dropped key removed');
ok((await as(clerk, `select * from public.config`)).length === 1, 'every member can read settings (branch names, currency)');
ok(await fails(clerk, `select public.replace_config($1::jsonb)`, ['{}']), 'only the settings module may change them');
ok((await as(admin, `select 1 from public.config`)).length === 1, '…so a refused change leaves them intact');

// ── Deleting ──
await as(admin, ...change([], [{ kind: 'customers', id: 'acme|a1' }]));
ok((await as(admin, `select 1 from public.records where kind = 'customers'`)).length === 0, 'a delete removes exactly that row');

console.log('All row-level security self-checks passed.');
