/**
 * Runnable check for the session rules that decide whether someone stays signed
 * in: `npx tsx src/auth.selfcheck.ts`. Throws on the first broken assumption.
 *
 * "Remember me" and expiry are the parts where a silent bug is invisible until
 * users are either logged out every reload or never logged out at all.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
}

const local = new MemoryStorage();
const sess = new MemoryStorage();
(globalThis as any).window = { localStorage: local, sessionStorage: sess, dispatchEvent: () => true };
(globalThis as any).localStorage = local;
(globalThis as any).sessionStorage = sess;

const { loadSession, saveSession, clearSession, can, getToken } = await import('./auth');
type S = import('./auth').Session;

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

const make = (overrides: Partial<S> = {}): S => ({
  token: 'tok-abc',
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  user: { user_id: 'siti', full_name: 'Siti', email: '', role: 'member', modules: ['invoicing'], active: true },
  company: { company_id: 'C1', company_name: 'Kiya', spreadsheet_id: 'sheet-1' },
  ...overrides,
});

// Nothing stored → nobody signed in.
ok(loadSession() === null, 'empty storage must mean no session');
ok(getToken() === '', 'no session must mean no token');

// Remembered: survives a closed tab, so it goes to localStorage.
saveSession(make(), true);
ok(local.getItem('bizeazy_session') !== null, 'remembered session must land in localStorage');
ok(sess.getItem('bizeazy_session') === null, 'remembered session must not also sit in sessionStorage');
ok(loadSession()?.user.user_id === 'siti', 'remembered session must load back');
ok(getToken() === 'tok-abc', 'token must come back from the stored session');

// Not remembered: dies with the tab, so sessionStorage — and the old
// remembered copy must be gone, or it would silently outlive the new choice.
saveSession(make({ token: 'tok-xyz' }), false);
ok(sess.getItem('bizeazy_session') !== null, 'unremembered session must land in sessionStorage');
ok(local.getItem('bizeazy_session') === null, 'switching to "do not remember" must clear the localStorage copy');
ok(getToken() === 'tok-xyz', 'the newest session wins');

// An expired token must not keep working offline, and must not linger.
saveSession(make({ expires_at: new Date(Date.now() - 1000).toISOString() }), true);
ok(loadSession() === null, 'an expired session must not load');
ok(local.getItem('bizeazy_session') === null, 'an expired session must be purged from storage');

// Corrupt payloads are discarded rather than thrown out of.
local.setItem('bizeazy_session', '{not json');
ok(loadSession() === null, 'unparseable stored session must be ignored');
local.setItem('bizeazy_session', JSON.stringify({ token: '', user: null }));
ok(loadSession() === null, 'a session with no token must be ignored');

clearSession();
ok(loadSession() === null, 'clearSession must remove it from every store');

// Module gating.
const member = make();
ok(can(member, 'invoicing'), 'a granted module must be allowed');
ok(!can(member, 'payroll'), 'an ungranted module must be refused');
ok(!can(null, 'invoicing'), 'no session must be refused everything');
const admin = make({ user: { ...member.user, role: 'admin', modules: [] } });
ok(can(admin, 'payroll') && can(admin, 'settings'), 'an admin must be allowed every module');

console.log('All session self-checks passed.');
