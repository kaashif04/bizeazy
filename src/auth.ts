/**
 * auth.ts — session handling and the single gateway to the Apps Script backend.
 *
 * Every request carries the session token, and the backend resolves the target
 * spreadsheet from that token rather than from anything we send. The company's
 * spreadsheet id is still returned to us, but only so the UI can show it — it
 * is not what grants access.
 */

export type ModuleName = 'invoicing' | 'quotations' | 'payroll' | 'settings';
export const ALL_MODULES: ModuleName[] = ['invoicing', 'quotations', 'payroll', 'settings'];

export const MODULE_LABELS: Record<ModuleName, string> = {
  invoicing: 'Invoicing',
  quotations: 'Quotations',
  payroll: 'Payroll & Payslips',
  settings: 'Settings & Company Profiles',
};

export interface SessionUser {
  user_id: string;
  full_name: string;
  email: string;
  role: 'admin' | 'member';
  modules: ModuleName[];
  active: boolean;
}

export interface SessionCompany {
  company_id: string;
  company_name: string;
  spreadsheet_id: string;
}

export interface Session {
  token: string;
  expires_at: string;
  user: SessionUser;
  company: SessionCompany;
}

// ── API URL ───────────────────────────────────────────────────
export const DEFAULT_API_URL =
  'https://script.google.com/macros/s/AKfycbwvv6xIpTxH8U3QvPfIZGuRzXfBm-k4bLCVIx_TF5c6qdtVlnhGobUivjwh4gQ9Dnuxyw/exec';

export const getApiUrl = (): string => {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('gas_api_url');
    if (stored?.trim()) return stored.trim();
  }
  return DEFAULT_API_URL;
};

export const setApiUrl = (url: string) => {
  if (typeof window === 'undefined') return;
  if (url?.trim()) localStorage.setItem('gas_api_url', url.trim());
  else localStorage.removeItem('gas_api_url');
};

// ── Session storage ───────────────────────────────────────────
const SESSION_KEY = 'bizeazy_session';
export const SIGNED_OUT_EVENT = 'bizeazy:signed-out';

// "Remember me" is the difference between surviving a closed browser and not:
// a remembered session goes to localStorage (and gets a 30-day token from the
// server), an unremembered one to sessionStorage (12-hour token, gone with the
// tab). Both are re-validated server-side on every call.
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
      if (!s?.token || !s?.user) { store.removeItem(SESSION_KEY); continue; }
      if (s.expires_at && Date.parse(s.expires_at) < Date.now()) { store.removeItem(SESSION_KEY); continue; }
      return s;
    } catch { /* unreadable or blocked store — try the next */ }
  }
  return null;
}

export function saveSession(session: Session, remember: boolean) {
  clearSession();
  try {
    const store = remember ? window.localStorage : window.sessionStorage;
    store.setItem(SESSION_KEY, JSON.stringify(session));
  } catch { /* private mode / blocked storage — session lives in memory only */ }
}

export function clearSession() {
  for (const store of stores()) {
    try { store.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }
}

export const getToken = (): string => loadSession()?.token || '';

// ── Transport ─────────────────────────────────────────────────
function handleResult(json: any): any {
  if (json?.success) return json.data;
  if (json?.code === 'AUTH') {
    clearSession();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
  throw new Error(json?.error || 'The server rejected that request.');
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // An HTML body here almost always means the deployment URL is wrong or the
    // web app is not shared with "Anyone" — say that instead of "unexpected <".
    console.error('Non-JSON response from Apps Script:', text.slice(0, 500));
    throw new Error('The backend returned a non-JSON response. Check the Apps Script URL and that it is deployed with access set to "Anyone".');
  }
}

/**
 * Reads go through POST as well, so the session token never ends up in a URL
 * (and therefore never in an execution log or a referrer). Apps Script answers
 * both verbs; only the body is read.
 */
export async function gasGet(params: Record<string, string>): Promise<any> {
  // Apps Script fails the odd request on its own (rate limits, brief server
  // errors). A read is safe to repeat, so retry those before giving up; a write
  // is never retried here, and a rejected session is never a blip.
  for (let attempt = 0; ; attempt++) {
    try {
      return await gasPost(params);
    } catch (err) {
      const transient = err instanceof TypeError
        || (err instanceof HttpError && (err.status === 429 || err.status >= 500));
      if (!transient || attempt >= 2) throw err;
      await new Promise(r => setTimeout(r, 800 * 2 ** attempt));
    }
  }
}

/** A non-2xx answer, kept distinct so gasGet can tell a blip from a refusal. */
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const httpHint = (status: number): string =>
  status === 429 ? ' — Google is rate-limiting the script, try again in a minute'
  : status >= 500 ? ' — Google Apps Script had a temporary error'
  : status === 404 ? ' — check the Apps Script URL in Connection Settings'
  : status === 401 || status === 403 ? ' — the Apps Script must be deployed with access "Anyone"'
  : '';

/**
 * POST through the gateway. text/plain is deliberate: it keeps the request
 * "simple" so the browser skips the CORS preflight that Apps Script cannot answer.
 */
export async function gasPost(body: Record<string, any>): Promise<any> {
  const res = await fetch(`${getApiUrl()}?action=${encodeURIComponent(body.action)}`, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...body, token: getToken() }),
  });
  if (!res.ok) throw new HttpError(res.status, `The server answered HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}${httpHint(res.status)}.`);
  return handleResult(await parse(res));
}

// ── Auth calls ────────────────────────────────────────────────
export async function login(userId: string, password: string, remember: boolean): Promise<Session> {
  const session = await gasPost({ action: 'login', userId, password, remember }) as Session;
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
  const session = await gasPost({ action: 'registerCompany', ...input, remember: true }) as Session;
  saveSession(session, true);
  return session;
}

export async function checkUserId(userId: string): Promise<{ available: boolean; reason?: string }> {
  return gasPost({ action: 'checkUserId', userId });
}

export async function logout(): Promise<void> {
  try {
    if (getToken()) await gasPost({ action: 'logout' });
  } catch {
    // Already-dead sessions are fine to sign out of locally.
  } finally {
    clearSession();
  }
}

/** Re-validate a restored session against the server. */
export async function refreshSession(): Promise<Session> {
  return gasPost({ action: 'session' });
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await gasPost({ action: 'changePassword', oldPassword, newPassword });
}

// ── User management (admin) ───────────────────────────────────
export const listUsers        = (): Promise<SessionUser[]> => gasPost({ action: 'listUsers' });
export const createUser       = (p: { userId: string; password: string; fullName: string; email?: string; role: 'admin' | 'member'; modules: ModuleName[] }) => gasPost({ action: 'createUser', ...p });
export const updateUser       = (p: { userId: string; fullName?: string; email?: string; role?: 'admin' | 'member'; modules?: ModuleName[]; active?: boolean }) => gasPost({ action: 'updateUser', ...p });
export const resetUserPassword = (userId: string, password: string) => gasPost({ action: 'resetUserPassword', userId, password });
export const deleteUser       = (userId: string) => gasPost({ action: 'deleteUser', userId });

export const can = (session: Session | null, mod: ModuleName): boolean =>
  !!session && (session.user.role === 'admin' || session.user.modules.indexOf(mod) !== -1);
