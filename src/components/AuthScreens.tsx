/**
 * AuthScreens.tsx — sign in, and register a new company.
 *
 * Replaces the old Google-sign-in screen plus the "paste your spreadsheet ID"
 * setup screen: the spreadsheet a user gets is now decided by their account,
 * so there is nothing for them to paste. The Apps Script URL stays reachable
 * under Advanced for pointing a build at a different deployment.
 */
import React, { useEffect, useState } from 'react';
import {
  Building2, AlertTriangle, Loader2, Eye, EyeOff, Check, X, ArrowLeft, ChevronDown,
} from 'lucide-react';
import {
  login, registerCompany, checkUserId, getApiUrl, setApiUrl, Session,
} from '../auth';

const CARD =
  'bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm';
const INPUT =
  'w-full px-3 py-2.5 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const LABEL =
  'block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1.5';
const BUTTON =
  'w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold text-sm py-2.5 px-4 rounded-xl transition-colors cursor-pointer shadow-sm';

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-indigo-600 rounded-xl mb-4 shadow-sm">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-gray-900 dark:text-white">{title}</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">{subtitle}</p>
        </div>
        {children}
        <p className="text-center text-[10px] text-gray-400 dark:text-slate-600 mt-4">
          Invoicing · Quotations · Payroll · Malaysian Statutory 2026
        </p>
      </div>
    </div>
  );
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-700 dark:text-red-400 mb-4">
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function PasswordField({
  id, label, value, onChange, autoComplete, placeholder,
}: {
  id: string; label: string; value: string;
  onChange: (v: string) => void; autoComplete: string; placeholder?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div>
      <label htmlFor={id} className={LABEL}>{label}</label>
      <div className="relative">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          className={`${INPUT} pr-10`}
        />
        <button
          type="button"
          onClick={() => setShown(s => !s)}
          aria-label={shown ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer"
        >
          {shown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

/** Collapsed endpoint override — only needed when pointing at another deployment. */
function AdvancedEndpoint() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(() => getApiUrl());
  const [saved, setSaved] = useState(false);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 mx-auto text-[10px] font-semibold text-gray-400 dark:text-slate-600 hover:text-gray-600 dark:hover:text-slate-400 cursor-pointer"
      >
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        Advanced
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          <label htmlFor="api-url" className={LABEL}>Apps Script API URL</label>
          <input
            id="api-url"
            type="text"
            value={url}
            onChange={e => { setUrl(e.target.value); setSaved(false); }}
            placeholder="https://script.google.com/macros/s/…/exec"
            className={`${INPUT} font-mono text-xs`}
          />
          <button
            type="button"
            onClick={() => { setApiUrl(url); setSaved(true); }}
            className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 cursor-pointer"
          >
            {saved ? 'Saved — reload to apply' : 'Save endpoint'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────
export function LoginScreen({
  onSignedIn, onRegister,
}: { onSignedIn: (s: Session) => void; onRegister: () => void }) {
  const [userId, setUserId] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId.trim() || !password) { setError('Enter your user ID and password.'); return; }
    setBusy(true); setError('');
    try {
      onSignedIn(await login(userId.trim(), password, remember));
    } catch (err: any) {
      setError(err.message || 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="BizEazy Hub" subtitle="Restaurant Operations Center">
      <div className={CARD}>
        {error && <ErrorNote message={error} />}
        <form onSubmit={submit} className="space-y-3.5">
          <div>
            <label htmlFor="login-user" className={LABEL}>User ID</label>
            <input
              id="login-user"
              type="text"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="your.user.id"
              className={INPUT}
            />
          </div>
          <PasswordField
            id="login-password" label="Password" value={password}
            onChange={setPassword} autoComplete="current-password"
          />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-gray-300 dark:border-slate-600 text-indigo-600 cursor-pointer"
            />
            <span className="text-xs text-gray-600 dark:text-slate-400">Keep me signed in on this device</span>
          </label>
          <button type="submit" disabled={busy} className={BUTTON}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-gray-100 dark:border-slate-800 text-center">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            New here?{' '}
            <button onClick={onRegister} className="font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer">
              Register a new company
            </button>
          </p>
          <p className="text-[10px] text-gray-400 dark:text-slate-600 mt-2">
            Staff accounts are created by your company administrator.
          </p>
        </div>
      </div>
      <AdvancedEndpoint />
    </Shell>
  );
}

// ─── Register a company ───────────────────────────────────────────────────────
export function RegisterScreen({
  onRegistered, onBack,
}: { onRegistered: (s: Session) => void; onBack: () => void }) {
  const [companyName, setCompanyName] = useState('');
  const [fullName, setFullName] = useState('');
  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [idState, setIdState] = useState<{ status: 'idle' | 'checking' | 'free' | 'taken'; reason?: string }>({ status: 'idle' });

  // Live availability check — the backend re-checks under a lock at write time,
  // so this is a courtesy, not the thing that actually enforces uniqueness.
  useEffect(() => {
    const id = userId.trim();
    if (!id) { setIdState({ status: 'idle' }); return; }
    setIdState({ status: 'checking' });
    const timer = setTimeout(async () => {
      try {
        const res = await checkUserId(id);
        setIdState(res.available ? { status: 'free' } : { status: 'taken', reason: res.reason });
      } catch {
        setIdState({ status: 'idle' });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [userId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyName.trim()) { setError('Company name is required.'); return; }
    if (idState.status === 'taken') { setError(idState.reason || 'That user ID is already taken.'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('The two passwords do not match.'); return; }

    setBusy(true); setError('');
    try {
      onRegistered(await registerCompany({
        companyName: companyName.trim(),
        fullName: fullName.trim(),
        userId: userId.trim(),
        password,
        email: email.trim(),
        registrationCode: code.trim(),
      }));
    } catch (err: any) {
      const msg = err.message || 'Registration failed.';
      if (/registration code/i.test(msg)) setNeedsCode(true);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const idHint = {
    idle: null,
    checking: <span className="text-gray-400 dark:text-slate-500">Checking availability…</span>,
    free: <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Check className="w-3 h-3" />Available</span>,
    taken: <span className="flex items-center gap-1 text-red-600 dark:text-red-400"><X className="w-3 h-3" />{idState.reason || 'Already taken'}</span>,
  }[idState.status];

  return (
    <Shell title="Register Company" subtitle="Create your workspace and admin login">
      <div className={CARD}>
        {error && <ErrorNote message={error} />}
        <form onSubmit={submit} className="space-y-3.5">
          <div>
            <label htmlFor="reg-company" className={LABEL}>Company Name *</label>
            <input id="reg-company" type="text" value={companyName} onChange={e => setCompanyName(e.target.value)}
              placeholder="Culinary Holdings Sdn Bhd" className={INPUT} />
            <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">
              A fresh Google Sheet is created for your company's data.
            </p>
          </div>
          <div>
            <label htmlFor="reg-name" className={LABEL}>Your Name</label>
            <input id="reg-name" type="text" value={fullName} onChange={e => setFullName(e.target.value)}
              autoComplete="name" placeholder="Kaashif Shaheem" className={INPUT} />
          </div>
          <div>
            <label htmlFor="reg-user" className={LABEL}>Choose a User ID *</label>
            <input id="reg-user" type="text" value={userId} onChange={e => setUserId(e.target.value)}
              autoComplete="username" autoCapitalize="none" spellCheck={false}
              placeholder="kaashif.admin" className={INPUT} />
            <p className="text-[10px] mt-1 min-h-[14px]">
              {idHint || <span className="text-gray-400 dark:text-slate-500">3–32 characters · letters, numbers, dot, dash, underscore</span>}
            </p>
          </div>
          <div>
            <label htmlFor="reg-email" className={LABEL}>
              Email <span className="normal-case font-normal">(optional)</span>
            </label>
            <input id="reg-email" type="email" value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="email" placeholder="you@company.com" className={INPUT} />
          </div>
          <PasswordField id="reg-password" label="Password *" value={password}
            onChange={setPassword} autoComplete="new-password" placeholder="At least 8 characters" />
          <PasswordField id="reg-confirm" label="Confirm Password *" value={confirm}
            onChange={setConfirm} autoComplete="new-password" />
          {needsCode && (
            <div>
              <label htmlFor="reg-code" className={LABEL}>Registration Code *</label>
              <input id="reg-code" type="text" value={code} onChange={e => setCode(e.target.value)}
                placeholder="Provided by BizEazy" className={INPUT} />
            </div>
          )}
          <button type="submit" disabled={busy} className={BUTTON}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? 'Creating workspace…' : 'Create Company & Sign In'}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-gray-100 dark:border-slate-800 text-center">
          <button onClick={onBack} className="inline-flex items-center gap-1 text-xs font-bold text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200 cursor-pointer">
            <ArrowLeft className="w-3 h-3" />
            Back to sign in
          </button>
        </div>
      </div>
    </Shell>
  );
}
