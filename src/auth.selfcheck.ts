/**
 * Runnable check for the rules that decide whether someone stays signed in:
 * `npx tsx src/auth.selfcheck.ts`. Throws on the first broken assumption.
 *
 * "Keep me signed in" is the part where a silent bug is invisible until users
 * are either logged out every reload or never logged out at all.
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

const { loadSession, saveSession, clearSession, can } = await import('./auth');
const { setRemember, remembered, loginEmail } = await import('./supabase');
type S = import('./auth').Session;

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

const make = (overrides: Partial<S> = {}): S => ({
  user: { user_id: 'Siti', full_name: 'Siti', email: '', role: 'member', modules: ['invoicing'], active: true },
  company: { company_id: 'c1', company_name: 'Kiya' },
  ...overrides,
});

// Nothing stored → nobody signed in.
ok(loadSession() === null, 'empty storage must mean no session');

// Remembered: survives a closed tab, so it goes to localStorage.
saveSession(make(), true);
ok(local.getItem('bizeazy_session') !== null, 'remembered session must land in localStorage');
ok(sess.getItem('bizeazy_session') === null, 'remembered session must not also sit in sessionStorage');
ok(loadSession()?.user.user_id === 'Siti', 'remembered session must load back');

// Not remembered: dies with the tab, and the old remembered copy must be gone,
// or it would silently outlive the new choice.
saveSession(make({ company: { company_id: 'c2', company_name: 'Other' } }), false);
ok(sess.getItem('bizeazy_session') !== null, 'unremembered session must land in sessionStorage');
ok(local.getItem('bizeazy_session') === null, 'switching to "do not remember" must clear the localStorage copy');
ok(loadSession()?.company.company_id === 'c2', 'the newest session wins');

// Corrupt or partial copies are discarded rather than thrown out of.
clearSession();
local.setItem('bizeazy_session', '{not json');
ok(loadSession() === null, 'unparseable stored session must be ignored');
local.setItem('bizeazy_session', JSON.stringify({ user: { user_id: 'x' } }));
ok(loadSession() === null, 'a session with no company must be ignored');
clearSession();
ok(loadSession() === null, 'clearSession must remove it from every store');

// The Supabase auth session follows the same choice.
setRemember(true);
ok(remembered(), 'remember on');
setRemember(false);
ok(!remembered(), 'remember off');

// User IDs map to one internal address however they are typed.
ok(loginEmail('  Kaashif.04 ') === 'kaashif.04@users.bizeazy.invalid', `login address, got ${loginEmail('  Kaashif.04 ')}`);
// BizPos owners sign in with their real email: used as typed (lower-cased), never wrapped.
ok(loginEmail(' Owner@Cafe.my ') === 'owner@cafe.my', `an email is used as it is, got ${loginEmail(' Owner@Cafe.my ')}`);

// Module gating.
const member = make();
ok(can(member, 'invoicing'), 'a granted module must be allowed');
ok(!can(member, 'payroll'), 'an ungranted module must be refused');
ok(!can(null, 'invoicing'), 'no session must be refused everything');
const admin = make({ user: { ...member.user, role: 'admin', modules: [] } });
ok(can(admin, 'payroll') && can(admin, 'settings'), 'an admin must be allowed every module');

console.log('All session self-checks passed.');
process.exit(0);   // the Supabase client keeps a refresh timer alive
