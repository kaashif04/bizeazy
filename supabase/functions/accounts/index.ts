/**
 * accounts — everything that creates or changes a login.
 *
 * The app signs in with Supabase Auth directly, but it cannot create accounts:
 * that needs the service-role key, which lives only here. Every admin action
 * checks, itself, that the caller is an active admin of the same company — this
 * function bypasses row-level security, so it must enforce what RLS would.
 *
 * People sign in with a User ID, not an email. Each User ID maps to an internal
 * address on the reserved .invalid domain (RFC 2606), which can never receive
 * mail; the contact email people enter is stored separately on the profile.
 *
 * Deployed with verify_jwt off because registerCompany and checkUserId are
 * public; the admin actions verify the caller's token below.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALL_MODULES = ['invoicing', 'quotations', 'payroll', 'settings', 'team'];
const loginEmail = (code: string) => `${code}@users.bizeazy.invalid`;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// Always 200 with { success }, so the app reads one shape for every outcome.
const reply = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { headers: { ...cors, 'Content-Type': 'application/json' } });

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** A refusal the person should read, as opposed to a fault. */
class Refusal extends Error {}

function userCode(userId: unknown): string {
  const id = String(userId ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(id)) {
    throw new Refusal('User ID must be 3-32 characters: letters, numbers, dot, dash or underscore.');
  }
  return id.toLowerCase();
}

function password(value: unknown): string {
  const pw = String(value ?? '');
  if (pw.length < 8) throw new Refusal('Password must be at least 8 characters.');
  if (pw.length > 72) throw new Refusal('Password must be at most 72 characters.');
  return pw;
}

function cleanModules(modules: unknown): string[] {
  const list = Array.isArray(modules) ? modules : String(modules ?? '').split(',');
  return [...new Set(list.map(m => String(m).trim().toLowerCase()).filter(m => ALL_MODULES.includes(m)))];
}

const isTaken = (message: string) => /already|registered|exists|duplicate/i.test(message);

interface Profile {
  user_id: string; company_id: string; user_code: string; display_id: string;
  full_name: string; email: string; role: 'admin' | 'member' | 'staff'; modules: string[]; active: boolean;
  employee_id: string | null;
}

type Role = Profile['role'];
const cleanRole = (r: unknown): Role => (r === 'admin' || r === 'staff' ? r : 'member');

/** The shape the app keeps as its signed-in user. */
const publicUser = (p: Profile) => ({
  user_id: p.display_id,
  full_name: p.full_name,
  email: p.email,
  role: p.role,
  modules: p.role === 'admin' ? ALL_MODULES : p.role === 'staff' ? [] : p.modules,
  active: p.active,
  employee_id: p.employee_id,
});

/**
 * The employee a login is linked to: it must exist in this company and have no
 * other login. A staff login must have one; anyone else may (an owner who also
 * clocks in). Returns null to unlink.
 */
async function employeeLink(admin: Profile, role: Role, value: unknown, self?: string): Promise<string | null> {
  const id = String(value ?? '').trim();
  if (!id) {
    if (role === 'staff') throw new Refusal('Choose the employee this staff login belongs to.');
    return null;
  }
  const { data: emp } = await db.from('records').select('id')
    .eq('company_id', admin.company_id).eq('kind', 'employees').eq('id', id).maybeSingle();
  if (!emp) throw new Refusal('That employee is not in your payroll.');
  const { data: taken } = await db.from('profiles').select('user_id, display_id')
    .eq('company_id', admin.company_id).eq('employee_id', id).maybeSingle();
  if (taken && taken.user_id !== self) throw new Refusal(`That employee already has a login (${taken.display_id}).`);
  return id;
}

async function signedInAdmin(req: Request): Promise<Profile> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data, error } = token ? await db.auth.getUser(token) : { data: { user: null }, error: null };
  if (error || !data.user) throw new Refusal('Your session has expired. Please sign in again.');
  const { data: me } = await db.from('profiles').select('*').eq('user_id', data.user.id).maybeSingle();
  if (!me || !me.active) throw new Refusal('Your session has expired. Please sign in again.');
  if (me.role !== 'admin') throw new Refusal('Admin access required.');
  return me as Profile;
}

/** Someone in the admin's own company; anyone else is simply not found. */
async function colleague(admin: Profile, userId: unknown): Promise<Profile> {
  const { data } = await db.from('profiles').select('*')
    .eq('company_id', admin.company_id).eq('user_code', String(userId ?? '').trim().toLowerCase()).maybeSingle();
  if (!data) throw new Refusal('User not found.');
  return data as Profile;
}

async function activeAdmins(companyId: string): Promise<number> {
  const { count } = await db.from('profiles').select('*', { count: 'exact', head: true })
    .eq('company_id', companyId).eq('role', 'admin').eq('active', true);
  return count ?? 0;
}

// ── Recovery codes ───────────────────────────────────────────────────────────
// Logins have no real email, so "forgot password" cannot mail a link. An admin
// instead keeps a one-time recovery code, written down somewhere safe. Only its
// salted hash is stored, on the auth user's app_metadata (writable by the
// service key alone). 20 characters from a 32-letter alphabet is 100 bits, so
// guessing one through the public endpoint is not a realistic attack.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I to misread

function newRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map(b => CODE_ALPHABET[b % 32]);
  return [0, 5, 10, 15].map(i => chars.slice(i, i + 5).join('')).join('-');
}

const normaliseCode = (code: unknown) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function checkUserId(p: any) {
  let code: string;
  try { code = userCode(p.userId); } catch (e) { return { available: false, reason: (e as Error).message }; }
  const { data } = await db.from('profiles').select('user_id').eq('user_code', code).maybeSingle();
  return { available: !data };
}

async function registerCompany(p: any) {
  const companyName = String(p.companyName ?? '').trim();
  if (!companyName) throw new Refusal('Company name is required.');
  const code = userCode(p.userId);
  const pw = password(p.password);
  const email = String(p.email ?? '').trim();

  // Set a REGISTRATION_CODE secret on this function to make sign-ups invite-only.
  const required = Deno.env.get('REGISTRATION_CODE');
  if (required && String(p.registrationCode ?? '') !== required) {
    throw new Refusal('A valid registration code is required to create a company.');
  }
  if ((await checkUserId({ userId: code })).available === false) throw new Refusal('That user ID is already taken.');

  const { data: company, error: companyError } = await db.from('companies')
    .insert({ name: companyName, owner_email: email }).select('id').single();
  if (companyError) throw companyError;

  // Undo in reverse if any step fails, so a half-made company never lingers.
  const { data: created, error: userError } = await db.auth.admin.createUser({
    email: loginEmail(code), password: pw, email_confirm: true,
  });
  if (userError || !created.user) {
    await db.from('companies').delete().eq('id', company.id);
    if (userError && isTaken(userError.message)) throw new Refusal('That user ID is already taken.');
    throw userError ?? new Error('Could not create the account.');
  }

  const { error: profileError } = await db.from('profiles').insert({
    user_id: created.user.id, company_id: company.id, user_code: code,
    display_id: String(p.userId).trim(), full_name: String(p.fullName ?? '').trim() || String(p.userId).trim(),
    email, role: 'admin', modules: ALL_MODULES, active: true,
  });
  if (profileError) {
    await db.auth.admin.deleteUser(created.user.id);
    await db.from('companies').delete().eq('id', company.id);
    if (isTaken(profileError.message)) throw new Refusal('That user ID is already taken.');
    throw profileError;
  }

  // One branch to start with; the admin adds more under Branches & Documents.
  await db.from('config').insert({
    company_id: company.id, key: 'main',
    value: {
      store_name: companyName, company_name: companyName, address: '', email, phone: '',
      currency_symbol: 'RM', series_format: `INV-${String(new Date().getFullYear()).slice(2)}-`,
      logo_url: '', footer_text: '', payment_info: '',
    },
  });
  return { user_id: String(p.userId).trim() };
}

/** A fresh code for the calling admin; any earlier one stops working. Shown once. */
async function createRecoveryCode(admin: Profile) {
  const code = newRecoveryCode();
  const salt = crypto.randomUUID();
  const { error } = await db.auth.admin.updateUserById(admin.user_id, {
    app_metadata: { recovery: { salt, hash: await sha256(salt + normaliseCode(code)), created_at: new Date().toISOString() } },
  });
  if (error) throw error;
  return { code };
}

async function recoveryStatus(admin: Profile) {
  const { data } = await db.auth.admin.getUserById(admin.user_id);
  const rec = data.user?.app_metadata?.recovery;
  return { exists: !!rec?.hash, created_at: rec?.created_at || null };
}

/** Public: a forgotten password, reset with the account's recovery code. The code is used up. */
async function recoverAccount(p: any) {
  const nope = new Refusal('That user ID and recovery code do not match.');
  const code = userCode(p.userId);
  const pw = password(p.newPassword);
  const { data: profile } = await db.from('profiles').select('*').eq('user_code', code).maybeSingle();
  if (!profile) throw nope;
  const { data } = await db.auth.admin.getUserById(profile.user_id);
  const rec = data.user?.app_metadata?.recovery;
  if (!rec?.hash || !sameText(await sha256(rec.salt + normaliseCode(p.code)), rec.hash)) throw nope;
  // Only after the code checks out, so the endpoint never reveals account state.
  if (!profile.active) throw new Refusal('This account has been deactivated. Contact your administrator.');
  const { error } = await db.auth.admin.updateUserById(profile.user_id, { password: pw, app_metadata: { recovery: null } });
  if (error) throw error;
  return {};
}

async function listUsers(admin: Profile) {
  const { data, error } = await db.from('profiles').select('*')
    .eq('company_id', admin.company_id).order('created_at');
  if (error) throw error;
  return (data as Profile[]).map(publicUser);
}

async function createUser(admin: Profile, p: any) {
  const code = userCode(p.userId);
  const pw = password(p.password);
  const role = cleanRole(p.role);
  const employee_id = await employeeLink(admin, role, p.employeeId);
  if ((await checkUserId({ userId: code })).available === false) throw new Refusal('That user ID is already taken.');

  const { data: created, error } = await db.auth.admin.createUser({ email: loginEmail(code), password: pw, email_confirm: true });
  if (error || !created.user) {
    if (error && isTaken(error.message)) throw new Refusal('That user ID is already taken.');
    throw error ?? new Error('Could not create the account.');
  }
  const row = {
    user_id: created.user.id, company_id: admin.company_id, user_code: code,
    display_id: String(p.userId).trim(), full_name: String(p.fullName ?? '').trim() || String(p.userId).trim(),
    email: String(p.email ?? '').trim(), role, modules: role === 'staff' ? [] : cleanModules(p.modules), active: true,
    employee_id,
  };
  const { error: profileError } = await db.from('profiles').insert(row);
  if (profileError) {
    await db.auth.admin.deleteUser(created.user.id);
    if (isTaken(profileError.message)) throw new Refusal('That user ID is already taken.');
    throw profileError;
  }
  return publicUser(row as Profile);
}

async function updateUser(admin: Profile, p: any) {
  const user = await colleague(admin, p.userId);
  const role = p.role === undefined ? user.role : cleanRole(p.role);
  const active = p.active === undefined ? user.active : !!p.active;

  // Demoting or disabling the last active admin would lock the whole company
  // out of user management with no way back in through the app.
  if (user.role === 'admin' && user.active && (role !== 'admin' || !active) && await activeAdmins(admin.company_id) <= 1) {
    throw new Refusal('This is the only active admin — promote another user first.');
  }

  const patch: Partial<Profile> = { role, active };
  if (p.fullName !== undefined) patch.full_name = String(p.fullName).trim();
  if (p.email !== undefined) patch.email = String(p.email).trim();
  if (p.modules !== undefined) patch.modules = cleanModules(p.modules);
  if (role === 'staff') patch.modules = [];
  if (p.employeeId !== undefined || (role === 'staff' && !user.employee_id)) {
    patch.employee_id = await employeeLink(admin, role, p.employeeId ?? user.employee_id, user.user_id);
  }
  const { data, error } = await db.from('profiles').update(patch).eq('user_id', user.user_id).select('*').single();
  if (error) throw error;

  // Deactivating also blocks sign-in itself, not just the data behind it.
  if (active !== user.active) {
    await db.auth.admin.updateUserById(user.user_id, { ban_duration: active ? 'none' : '876000h' });
  }
  return publicUser(data as Profile);
}

async function resetUserPassword(admin: Profile, p: any) {
  const user = await colleague(admin, p.userId);
  const { error } = await db.auth.admin.updateUserById(user.user_id, { password: password(p.password) });
  if (error) throw error;
  return {};
}

async function deleteUser(admin: Profile, p: any) {
  const user = await colleague(admin, p.userId);
  if (user.user_id === admin.user_id) throw new Refusal('You cannot delete your own account.');
  if (user.role === 'admin' && user.active && await activeAdmins(admin.company_id) <= 1) {
    throw new Refusal('This is the only active admin — promote another user first.');
  }
  const { error } = await db.auth.admin.deleteUser(user.user_id);   // the profile goes with it
  if (error) throw error;
  return {};
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  let p: any;
  try { p = await req.json(); } catch { return reply({ success: false, error: 'Bad request.' }); }

  try {
    switch (p?.action) {
      case 'checkUserId':       return reply({ success: true, data: await checkUserId(p) });
      case 'registerCompany':   return reply({ success: true, data: await registerCompany(p) });
      case 'recoverAccount':    return reply({ success: true, data: await recoverAccount(p) });
      case 'createRecoveryCode': return reply({ success: true, data: await createRecoveryCode(await signedInAdmin(req)) });
      case 'recoveryStatus':    return reply({ success: true, data: await recoveryStatus(await signedInAdmin(req)) });
      case 'listUsers':         return reply({ success: true, data: await listUsers(await signedInAdmin(req)) });
      case 'createUser':        return reply({ success: true, data: await createUser(await signedInAdmin(req), p) });
      case 'updateUser':        return reply({ success: true, data: await updateUser(await signedInAdmin(req), p) });
      case 'resetUserPassword': return reply({ success: true, data: await resetUserPassword(await signedInAdmin(req), p) });
      case 'deleteUser':        return reply({ success: true, data: await deleteUser(await signedInAdmin(req), p) });
      default:                  return reply({ success: false, error: 'Unknown action.' });
    }
  } catch (err) {
    if (err instanceof Refusal) return reply({ success: false, error: err.message });
    console.error(p?.action, err);
    return reply({ success: false, error: 'Something went wrong on the server. Please try again.' });
  }
});
