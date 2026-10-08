/**
 * auth.ts — signing in, the signed-in user, and account management.
 *
 * Supabase Auth holds the real session (tokens, refresh, expiry). This module
 * keeps a small copy of who is signed in — name, role, modules, company — so
 * the app renders instantly on reload, then re-confirms it with the server.
 * What anyone may read or write is decided by row-level security, not here.
 */
import { supabase, setRemember, remembered, loginEmail } from './supabase';

export type ModuleName = 'invoicing' | 'quotations' | 'payroll' | 'settings' | 'team';
export const ALL_MODULES: ModuleName[] = ['invoicing', 'quotations', 'payroll', 'settings', 'team'];

export const MODULE_LABELS: Record<ModuleName, string> = {
  invoicing: 'Invoicing',
  quotations: 'Quotations',
  payroll: 'Payroll & Payslips',
  settings: 'Settings & Company Profiles',
  team: 'Team: attendance & leave',
};

/** Staff sign in to the BizEazy Staff app only; the Hub turns them away. */
export type Role = 'admin' | 'member' | 'staff';

export interface SessionUser {
  user_id: string;
  full_name: string;
  email: string;
  role: Role;
  modules: ModuleName[];
  active: boolean;
  /** The employee record this login clocks in as, if any. */
  employee_id?: string | null;
}

export interface SessionCompany {
  company_id: string;
  company_name: string;
}

export interface Session {
  user: SessionUser;
  company: SessionCompany;
  /** Which Biz apps the company uses: 'hub', 'pos', 'wallet'. */
  apps?: string[];
}

/**
 * A BizPos owner signed in who has no Hub login yet. The sign-in screen offers
 * "Use <company>" (linkFromPos); nothing is created until they accept.
 */
export class LinkOffer extends Error {
  constructor(public companyName: string) {
    super(`${companyName} uses BizPos. Use it in BizEazy Hub too?`);
  }
}
const NO_HUB = 'This sign-in has no BizEazy Hub account. Ask your company administrator.';

// ── The cached copy ───────────────────────────────────────────
const SESSION_KEY = 'bizeazy_session';
export const SIGNED_OUT_EVENT = 'bizeazy:signed-out';

const stores = (): Storage[] => {
  if (typeof window === 'undefined') return [];
  const out: Storage[] = [];
  try { out.push(window.localStorage); } catch { /* blocked */ }
  try { out.push(window.sessionStorage); } catch { /* blocked */ }
  return out;
};

export function loadSession(): Session | null {
  for (const store of stores()) {
    try {
      const raw = store.getItem(SESSION_KEY);
      if (!raw) continue;
      const s = JSON.parse(raw) as Session;
      if (!s?.user?.user_id || !s?.company?.company_id) { store.removeItem(SESSION_KEY); continue; }
      return s;
    } catch { /* unreadable or blocked store — try the next */ }
  }
  return null;
}

/** Remembered → localStorage, outliving the browser; otherwise sessionStorage, gone with the tab. */
export function saveSession(session: Session, remember: boolean) {
  clearSession();
  try {
    (remember ? window.localStorage : window.sessionStorage).setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* private mode / blocked storage — session lives in memory only */ }
}

export function clearSession() {
  for (const store of stores()) {
    try { store.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }
}

function signalSignedOut() {
  clearSession();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}

// A refresh token that stopped working (revoked, or the account banned) ends
// the session on Supabase's side; tell the app instead of failing every call.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' && loadSession()) signalSignedOut();
});

const DEACTIVATED = 'This account has been deactivated. Contact your administrator.';
const EXPIRED = 'Your session has expired. Please sign in again.';
const STAFF_ONLY = 'This login is for the BizEazy Staff app. Ask your manager for the link.';

/** Who is signed in, read fresh from the server. */
async function fetchSession(): Promise<Session> {
  const { data: { session: auth } } = await supabase.auth.getSession();
  if (!auth) throw new Error(EXPIRED);

  // One call: the Hub login, its company and the company's apps (the shared
  // core tables are only readable through it).
  const { data: s, error } = await supabase.rpc('hub_session');
  if (error) throw new Error(error.message);
  if (s?.linkable) throw new LinkOffer(s.linkable.name);
  const p = s?.user;
  if (!p) {
    await supabase.auth.signOut();
    throw new Error(NO_HUB);
  }
  if (!p.active) {
    await supabase.auth.signOut();
    throw new Error(DEACTIVATED);
  }
  if (p.role === 'staff') {
    await supabase.auth.signOut();
    throw new Error(STAFF_ONLY);
  }
  const role = p.role === 'admin' ? 'admin' : 'member';
  return {
    user: {
      user_id: p.display_id,
      full_name: p.full_name,
      email: p.email,
      role,
      modules: (role === 'admin' ? ALL_MODULES : (p.modules || [])) as ModuleName[],
      active: p.active,
    },
    company: { company_id: p.company_id, company_name: s.company?.name || '' },
    apps: s.apps || [],
  };
}

// ── Signing in and out ────────────────────────────────────────
export async function login(userId: string, password: string, remember: boolean): Promise<Session> {
  setRemember(remember);
  const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(userId), password });
  if (error) {
    if (/banned/i.test(error.message)) throw new Error(DEACTIVATED);
    if (/fetch|network/i.test(error.message)) throw new Error('Could not reach the server. Check your connection and try again.');
    // Same message either way: "no such user" would hand out valid user IDs.
    throw new Error('Incorrect user ID or password.');
  }
  const session = await fetchSession();
  saveSession(session, remember);
  return session;
}

/** A BizPos owner accepts the LinkOffer: an admin Hub login in their own company. */
export async function linkFromPos(remember: boolean): Promise<Session> {
  const { error } = await supabase.rpc('hub_link_from_pos');
  if (error) throw new Error(error.message);
  const session = await fetchSession();
  saveSession(session, remember);
  return session;
}

export interface RegisterInput {
  companyName: string;
  fullName: string;
  userId: string;
  password: string;
  email?: string;
  registrationCode?: string;
}

export async function registerCompany(input: RegisterInput): Promise<Session> {
  await accounts('registerCompany', { ...input });
  return login(input.userId, input.password, true);
}

export async function checkUserId(userId: string): Promise<{ available: boolean; reason?: string }> {
  return accounts('checkUserId', { userId });
}

export async function logout(): Promise<void> {
  clearSession();   // first, so the SIGNED_OUT event that follows is not read as an expiry
  try { await supabase.auth.signOut(); } catch { /* already gone */ }
}

/** Re-validate a restored session against the server. */
export async function refreshSession(): Promise<Session> {
  try {
    const session = await fetchSession();
    saveSession(session, remembered());
    return session;
  } catch (err) {
    // Offline is not signed out: keep the cached copy and let the next call retry.
    if (!(err instanceof LinkOffer) && !/expired|deactivated|Staff app|no BizEazy Hub/i.test((err as Error).message)) throw err;
    signalSignedOut();
    throw err;
  }
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  if (newPassword.length < 8) throw new Error('Password must be at least 8 characters.');
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) throw new Error(EXPIRED);
  // Re-entering the current password is the proof; an open session alone is not enough.
  const { error: wrong } = await supabase.auth.signInWithPassword({ email: user.email, password: oldPassword });
  if (wrong) throw new Error('Current password is incorrect.');
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);
}

// ── Account management (the accounts edge function) ───────────
async function accounts(action: string, body: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.functions.invoke('accounts', { body: { action, ...body } });
  if (error) throw new Error('Could not reach the server. Check your connection and try again.');
  if (data?.success) return data.data;
  const message = String(data?.error || 'The server rejected that request.');
  if (/session has expired/i.test(message)) signalSignedOut();
  throw new Error(message);
}

export const listUsers = (): Promise<SessionUser[]> => accounts('listUsers', {});
export const createUser = (p: { userId: string; password: string; fullName: string; email?: string; role: Role; modules: ModuleName[]; employeeId?: string }) =>
  accounts('createUser', p);
export const updateUser = (p: { userId: string; fullName?: string; email?: string; role?: Role; modules?: ModuleName[]; active?: boolean; employeeId?: string }) =>
  accounts('updateUser', p);
export const resetUserPassword = (userId: string, password: string) => accounts('resetUserPassword', { userId, password });
export const deleteUser = (userId: string) => accounts('deleteUser', { userId });

// ── Account recovery ──────────────────────────────────────────
// Logins have no real email to send a reset link to, so an admin keeps a
// one-time recovery code instead. Staff who forget a password ask an admin.
export const createRecoveryCode = (): Promise<{ code: string }> => accounts('createRecoveryCode', {});
export const recoveryStatus = (): Promise<{ exists: boolean; created_at: string | null }> => accounts('recoveryStatus', {});

/** Reset a forgotten password with a recovery code, then sign in with the new one. The code is used up. */
export async function recoverAccount(userId: string, code: string, newPassword: string): Promise<Session> {
  await accounts('recoverAccount', { userId, code, newPassword });
  return login(userId, newPassword, true);
}

export const can = (session: Session | null, mod: ModuleName): boolean =>
  !!session && (session.user.role === 'admin' || session.user.modules.indexOf(mod) !== -1);
