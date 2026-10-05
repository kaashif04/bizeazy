/// <reference types="vite/client" />
/**
 * The one Supabase client. The URL and publishable key are public by design:
 * what stops one company reading another's books is row-level security in
 * supabase/migrations, not secrecy of these two values.
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || 'https://rtleeehglawquekygfoh.supabase.co';
const SUPABASE_KEY = import.meta.env?.VITE_SUPABASE_KEY || 'sb_publishable_THbbwo1H7tOpEf2sRxn0cg_zIUWROuC';

const REMEMBER_KEY = 'bizeazy_remember';

/**
 * "Keep me signed in": the auth session goes to localStorage, so it outlives a
 * closed browser; otherwise to sessionStorage, so it dies with the tab. Every
 * read and write goes through here, so switching the choice moves the session.
 */
export function setRemember(remember: boolean) {
  try { localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0'); } catch { /* blocked storage */ }
}
export const remembered = (): boolean => {
  try { return localStorage.getItem(REMEMBER_KEY) !== '0'; } catch { return false; }
};
const storage = {
  getItem(key: string): string | null {
    try { return (remembered() ? localStorage : sessionStorage).getItem(key); } catch { return null; }
  },
  setItem(key: string, value: string) {
    try {
      (remembered() ? localStorage : sessionStorage).setItem(key, value);
      (remembered() ? sessionStorage : localStorage).removeItem(key);
    } catch { /* private mode: the session lives in memory only */ }
  },
  removeItem(key: string) {
    try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch { /* ignore */ }
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

/** People sign in with a User ID; Supabase Auth needs an address. Mirrors supabase/functions/accounts. */
export const loginEmail = (userId: string) => `${userId.trim().toLowerCase()}@users.bizeazy.invalid`;
