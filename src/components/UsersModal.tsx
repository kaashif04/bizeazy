/**
 * UsersModal.tsx — company admin: who can sign in, and what they can open.
 *
 * Module ticks are enforced by the database (row-level security), not here: a
 * user without Payroll never receives employee or payslip rows in the first
 * place, so hiding the nav item is cosmetic reinforcement, not the control.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Users as UsersIcon, Loader2, Plus, KeyRound, Trash2, Check, AlertTriangle, ShieldCheck,
} from 'lucide-react';
import { Sheet } from './ui/Sheet';
import {
  listUsers, createUser, updateUser, resetUserPassword, deleteUser, changePassword,
  createRecoveryCode, recoveryStatus,
  ALL_MODULES, MODULE_LABELS, ModuleName, Role, Session, SessionUser,
} from '../auth';

type Tab = 'users' | 'password';

const INPUT =
  'w-full px-3 py-2 text-xs rounded-lg border border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-950 text-ink-900 dark:text-white placeholder-ink-400 dark:placeholder-ink-600 focus:outline-none focus:ring-1 focus:ring-brand-500';
const LABEL =
  'block text-2xs font-bold uppercase tracking-wider text-ink-500 dark:text-ink-400 mb-1';
const PRIMARY =
  'px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-bold text-xs rounded-full transition-colors cursor-pointer shadow-sm';
const GHOST =
  'px-3 py-1.5 rounded-lg border border-ink-200 dark:border-ink-700 text-xs font-bold text-ink-700 dark:text-ink-300 hover:bg-ink-50 dark:hover:bg-ink-800 cursor-pointer transition-colors';

function ModuleTicks({
  selected, disabled, onToggle,
}: { selected: ModuleName[]; disabled?: boolean; onToggle: (m: ModuleName) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {ALL_MODULES.map(m => (
        <label
          key={m}
          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border text-2xs font-medium select-none ${
            disabled
              ? 'opacity-50 cursor-not-allowed border-ink-200 dark:border-ink-700'
              : 'cursor-pointer border-ink-200 dark:border-ink-700 hover:bg-ink-50 dark:hover:bg-ink-800'
          } text-ink-700 dark:text-ink-300`}
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={selected.indexOf(m) !== -1}
            onChange={() => onToggle(m)}
            className="w-3.5 h-3.5 rounded border-ink-300 dark:border-ink-600 text-brand-600"
          />
          {MODULE_LABELS[m]}
        </label>
      ))}
    </div>
  );
}

/** Who a login clocks in as. Staff must have one; anyone else may (an owner who also works shifts). */
function EmployeePicker({
  value, role, employees, onChange,
}: { value: string; role: Role; employees: { id: string; name: string }[]; onChange: (id: string) => void }) {
  return (
    <div>
      <label className={LABEL}>{role === 'staff' ? 'Employee *' : 'Clocks in as (optional)'}</label>
      <select value={value} onChange={e => onChange(e.target.value)} className={INPUT}>
        <option value="">{role === 'staff' ? 'Choose the employee…' : 'Nobody — does not clock in'}</option>
        {employees.map(e => <option key={e.id} value={e.id}>{e.name} ({e.id})</option>)}
      </select>
    </div>
  );
}

const ROLE_OPTIONS = (
  <>
    <option value="member">Member (Hub, chosen modules)</option>
    <option value="admin">Admin (full access)</option>
    <option value="staff">Staff (Staff app only)</option>
  </>
);

export function UsersModal({
  session, isDark, onClose, onToast, initialTab, employees = [],
}: {
  initialTab?: Tab;
  /** Payroll's employees, to link staff logins to. */
  employees?: { id: string; name: string }[];
  session: Session;
  isDark: boolean;
  onClose: () => void;
  onToast: (msg: string, type: 'success' | 'error' | 'info' | 'warning') => void;
}) {
  const isAdmin = session.user.role === 'admin';
  const [tab, setTab] = useState<Tab>(initialTab || (isAdmin ? 'users' : 'password'));
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [loading, setLoading] = useState(isAdmin);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    userId: '', password: '', fullName: '', email: '',
    role: 'member' as Role, modules: ['invoicing'] as ModuleName[], employeeId: '',
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ fullName: string; email: string; role: Role; modules: ModuleName[]; active: boolean; employeeId: string } | null>(null);
  const employeeName = (id?: string | null) => employees.find(e => e.id === id)?.name || id || '';

  const [pw, setPw] = useState({ old: '', next: '', confirm: '' });
  const [recovery, setRecovery] = useState<{ exists: boolean; created_at: string | null } | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);

  // An admin with no recovery code is one forgotten password from a locked company.
  useEffect(() => {
    if (!isAdmin) return;
    recoveryStatus().then(setRecovery).catch(() => setRecovery(null));
  }, [isAdmin]);

  const handleNewCode = async () => {
    if (recovery?.exists && !window.confirm('Replace your recovery code? The old one will stop working.')) return;
    setBusy(true); setError('');
    try {
      const { code } = await createRecoveryCode();
      setNewCode(code);
      setRecovery({ exists: true, created_at: new Date().toISOString() });
    } catch (err: any) {
      setError(err.message || 'Could not create a recovery code.');
    } finally {
      setBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true); setError('');
    try {
      setUsers(await listUsers());
    } catch (err: any) {
      setError(err.message || 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (work: () => Promise<any>, okMsg: string) => {
    setBusy(true); setError('');
    try {
      await work();
      await refresh();
      onToast(okMsg, 'success');
      return true;
    } catch (err: any) {
      setError(err.message || 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleAdd = async () => {
    if (!draft.userId.trim() || draft.password.length < 8) {
      setError('A user ID and a password of at least 8 characters are required.');
      return;
    }
    if (draft.role === 'staff' && !draft.employeeId) { setError('Choose the employee this staff login belongs to.'); return; }
    const ok = await run(() => createUser({
      userId: draft.userId.trim(), password: draft.password,
      fullName: draft.fullName.trim() || draft.userId.trim(), email: draft.email.trim(),
      role: draft.role, modules: draft.modules, employeeId: draft.employeeId,
    }), `User "${draft.userId.trim()}" created.`);
    if (ok) {
      setAdding(false);
      setDraft({ userId: '', password: '', fullName: '', email: '', role: 'member', modules: ['invoicing'], employeeId: '' });
    }
  };

  const startEdit = (u: SessionUser) => {
    setEditingId(u.user_id);
    setEdit({ fullName: u.full_name, email: u.email, role: u.role, modules: u.modules, active: u.active, employeeId: u.employee_id || '' });
  };

  const handleSaveEdit = async () => {
    if (!editingId || !edit) return;
    const ok = await run(() => updateUser({ userId: editingId, ...edit }), 'User updated.');
    if (ok) { setEditingId(null); setEdit(null); }
  };

  const handleReset = async (userId: string) => {
    const next = window.prompt(`New password for "${userId}" (at least 8 characters):`);
    if (!next) return;
    if (next.length < 8) { setError('Password must be at least 8 characters.'); return; }
    await run(() => resetUserPassword(userId, next), `Password reset for "${userId}".`);
  };

  const handleDelete = async (userId: string) => {
    if (!window.confirm(`Delete "${userId}"? They lose access immediately. This cannot be undone.`)) return;
    await run(() => deleteUser(userId), `User "${userId}" deleted.`);
  };

  const handleChangePassword = async () => {
    if (pw.next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (pw.next !== pw.confirm) { setError('The two new passwords do not match.'); return; }
    const ok = await run(() => changePassword(pw.old, pw.next), 'Your password has been changed.');
    if (ok) setPw({ old: '', next: '', confirm: '' });
  };

  const toggleDraftModule = (m: ModuleName) =>
    setDraft(d => ({ ...d, modules: d.modules.indexOf(m) !== -1 ? d.modules.filter(x => x !== m) : [...d.modules, m] }));
  const toggleEditModule = (m: ModuleName) =>
    setEdit(e => e && ({ ...e, modules: e.modules.indexOf(m) !== -1 ? e.modules.filter(x => x !== m) : [...e.modules, m] }));

  return (
    <Sheet
      title="Users & Access"
      subtitle={session.company.company_name}
      icon={<UsersIcon className="w-4 h-4" />}
      onClose={onClose}
      maxWidth="2xl"
    >
      <div className="-mx-4 sm:-mx-5 -my-4">
        {isAdmin && (
          <div className={`flex border-b sticky top-0 z-10 ${isDark ? 'border-ink-800 bg-ink-900' : 'border-ink-200 bg-ink-50'}`}>
            {([['users', 'Team Members'], ['password', 'My Password']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => { setTab(key); setError(''); }}
                className={`flex-1 py-2.5 text-xs font-bold transition-colors cursor-pointer ${
                  tab === key
                    ? 'border-b-2 border-brand-500 text-brand-600 dark:text-brand-300'
                    : 'text-ink-500 dark:text-ink-400 hover:text-ink-700 dark:hover:text-ink-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="p-4 sm:p-5 space-y-4">
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-700 dark:text-red-400">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {tab === 'users' && isAdmin && (
            <>
              {loading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="w-5 h-5 animate-spin text-brand-500" />
                </div>
              ) : (
                <div className="space-y-2">
                  {users.map(u => {
                    const isSelf = u.user_id.toLowerCase() === session.user.user_id.toLowerCase();
                    const isEditing = editingId === u.user_id;
                    return (
                      <div
                        key={u.user_id}
                        className={`rounded-xl border p-3 ${isDark ? 'border-ink-800 bg-ink-950/40' : 'border-ink-200 bg-ink-50/60'}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-bold text-ink-900 dark:text-white truncate">{u.full_name || u.user_id}</span>
                              <span className="text-2xs font-mono text-ink-500 dark:text-ink-400">{u.user_id}</span>
                              {u.role === 'admin' && (
                                <span className="inline-flex items-center gap-1 text-2xs font-bold uppercase px-1.5 py-0.5 rounded bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300">
                                  <ShieldCheck className="w-2.5 h-2.5" />Admin
                                </span>
                              )}
                              {u.role === 'staff' && (
                                <span className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300">
                                  Staff app
                                </span>
                              )}
                              {!u.active && (
                                <span className="text-2xs font-bold uppercase px-1.5 py-0.5 rounded bg-ink-200 dark:bg-ink-800 text-ink-600 dark:text-ink-400">
                                  Disabled
                                </span>
                              )}
                              {isSelf && <span className="text-2xs font-bold uppercase text-ink-500 dark:text-ink-400">you</span>}
                            </div>
                            <p className="text-2xs text-ink-500 dark:text-ink-400 mt-0.5 truncate">
                              {u.role === 'admin' ? 'All modules' : u.role === 'staff' ? 'Clock-ins, payslips and leave'
                                : (u.modules.map(m => MODULE_LABELS[m]).join(' · ') || 'No modules assigned')}
                              {u.employee_id && <> · Clocks in as {employeeName(u.employee_id)}</>}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button onClick={() => (isEditing ? (setEditingId(null), setEdit(null)) : startEdit(u))} className={GHOST}>
                              {isEditing ? 'Cancel' : 'Edit'}
                            </button>
                            <button onClick={() => handleReset(u.user_id)} disabled={busy}
                              title="Reset password"
                              className="p-1.5 rounded-lg text-ink-500 hover:text-brand-600 dark:hover:text-brand-400 cursor-pointer">
                              <KeyRound className="w-3.5 h-3.5" />
                            </button>
                            {!isSelf && (
                              <button onClick={() => handleDelete(u.user_id)} disabled={busy}
                                title="Delete user"
                                className="p-1.5 rounded-lg text-ink-500 hover:text-red-600 dark:hover:text-red-400 cursor-pointer">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        {isEditing && edit && (
                          <div className="mt-3 pt-3 border-t border-ink-200 dark:border-ink-800 space-y-2.5">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className={LABEL}>Full Name</label>
                                <input type="text" value={edit.fullName} onChange={e => setEdit({ ...edit, fullName: e.target.value })} className={INPUT} />
                              </div>
                              <div>
                                <label className={LABEL}>Email</label>
                                <input type="email" value={edit.email} onChange={e => setEdit({ ...edit, email: e.target.value })} className={INPUT} />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className={LABEL}>Role</label>
                                <select value={edit.role} onChange={e => setEdit({ ...edit, role: e.target.value as Role })} className={INPUT}>
                                  {ROLE_OPTIONS}
                                </select>
                              </div>
                              <div>
                                <label className={LABEL}>Status</label>
                                <select value={edit.active ? 'active' : 'disabled'} onChange={e => setEdit({ ...edit, active: e.target.value === 'active' })} className={INPUT}>
                                  <option value="active">Active</option>
                                  <option value="disabled">Disabled</option>
                                </select>
                              </div>
                            </div>
                            <EmployeePicker value={edit.employeeId} role={edit.role} employees={employees}
                              onChange={id => setEdit({ ...edit, employeeId: id })} />
                            {edit.role !== 'staff' && (
                              <div>
                                <label className={LABEL}>
                                  Modules {edit.role === 'admin' && <span className="normal-case font-normal">— admins always get everything</span>}
                                </label>
                                <ModuleTicks selected={edit.role === 'admin' ? ALL_MODULES : edit.modules} disabled={edit.role === 'admin'} onToggle={toggleEditModule} />
                              </div>
                            )}
                            <div className="flex justify-end">
                              <button onClick={handleSaveEdit} disabled={busy} className={PRIMARY}>
                                {busy ? 'Saving…' : 'Save Changes'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {adding ? (
                <div className={`rounded-xl border p-3 space-y-2.5 ${isDark ? 'border-brand-900/60 bg-brand-950/20' : 'border-brand-200 bg-brand-50/50'}`}>
                  <p className="text-xs font-bold text-ink-900 dark:text-white">New team member</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={LABEL}>User ID *</label>
                      <input type="text" value={draft.userId} autoCapitalize="none" spellCheck={false}
                        onChange={e => setDraft({ ...draft, userId: e.target.value })} placeholder="siti.cashier" className={INPUT} />
                    </div>
                    <div>
                      <label className={LABEL}>Temporary Password *</label>
                      <input type="text" value={draft.password}
                        onChange={e => setDraft({ ...draft, password: e.target.value })} placeholder="At least 8 characters" className={INPUT} />
                    </div>
                    <div>
                      <label className={LABEL}>Full Name</label>
                      <input type="text" value={draft.fullName}
                        onChange={e => setDraft({ ...draft, fullName: e.target.value })} placeholder="Siti binti Ahmad" className={INPUT} />
                    </div>
                    <div>
                      <label className={LABEL}>Email</label>
                      <input type="email" value={draft.email}
                        onChange={e => setDraft({ ...draft, email: e.target.value })} placeholder="optional" className={INPUT} />
                    </div>
                  </div>
                  <div>
                    <label className={LABEL}>Role</label>
                    <select value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value as Role })} className={INPUT}>
                      {ROLE_OPTIONS}
                    </select>
                  </div>
                  <EmployeePicker value={draft.employeeId} role={draft.role} employees={employees}
                    onChange={id => setDraft({ ...draft, employeeId: id })} />
                  {draft.role === 'staff' ? (
                    <p className="text-2xs text-ink-500 dark:text-ink-400">
                      Staff sign in to the BizEazy Staff app to see their clock-ins, payslips and leave. They cannot open the Hub.
                    </p>
                  ) : (
                    <div>
                      <label className={LABEL}>Modules this user can open</label>
                      <ModuleTicks selected={draft.role === 'admin' ? ALL_MODULES : draft.modules} disabled={draft.role === 'admin'} onToggle={toggleDraftModule} />
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => { setAdding(false); setError(''); }} className={GHOST}>Cancel</button>
                    <button onClick={handleAdd} disabled={busy} className={PRIMARY}>
                      {busy ? 'Creating…' : 'Create User'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { setAdding(true); setError(''); }}
                  className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-dashed border-ink-300 dark:border-ink-700 text-xs font-bold text-ink-500 dark:text-ink-400 hover:border-brand-400 hover:text-brand-600 dark:hover:text-brand-400 cursor-pointer transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Team Member
                </button>
              )}
            </>
          )}

          {tab === 'password' && (
            <div className="space-y-2.5 max-w-sm">
              <p className="text-xs text-ink-500 dark:text-ink-400">
                Signed in as <span className="font-bold text-ink-800 dark:text-ink-200">{session.user.user_id}</span>.
              </p>
              <div>
                <label className={LABEL}>Current Password</label>
                <input type="password" autoComplete="current-password" value={pw.old}
                  onChange={e => setPw({ ...pw, old: e.target.value })} className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>New Password</label>
                <input type="password" autoComplete="new-password" value={pw.next}
                  onChange={e => setPw({ ...pw, next: e.target.value })} placeholder="At least 8 characters" className={INPUT} />
              </div>
              <div>
                <label className={LABEL}>Confirm New Password</label>
                <input type="password" autoComplete="new-password" value={pw.confirm}
                  onChange={e => setPw({ ...pw, confirm: e.target.value })} className={INPUT} />
              </div>
              <button onClick={handleChangePassword} disabled={busy} className={PRIMARY}>
                {busy ? 'Updating…' : <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5" />Change Password</span>}
              </button>

              {isAdmin && (
                <div className="pt-4 mt-4 border-t border-ink-100 dark:border-ink-800">
                  <h4 className="text-xs font-bold text-ink-900 dark:text-white flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5" /> Recovery code
                  </h4>
                  <p className="text-2xs text-ink-500 dark:text-ink-400 mt-1 leading-relaxed">
                    If you forget your password, this code resets it from the sign-in screen (Forgot password?).
                    It works once. Keep it somewhere safe and offline, not in this app.
                  </p>
                  {recovery && !recovery.exists && !newCode && (
                    <p role="alert" className="mt-2 flex items-start gap-1.5 text-2xs font-bold text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      You have no recovery code. If you forget your password and no other admin can reset it, the company is locked out.
                    </p>
                  )}
                  {recovery?.exists && !newCode && recovery.created_at && (
                    <p className="mt-2 text-2xs text-ink-600 dark:text-ink-300">
                      Created {new Date(recovery.created_at).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })}.
                    </p>
                  )}
                  {newCode && (
                    <div className="mt-2 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-3">
                      <p className="text-2xs font-bold text-emerald-800 dark:text-emerald-200">Write this down now. It will not be shown again.</p>
                      <p className="mt-1.5 font-mono text-sm font-bold tracking-wider text-ink-900 dark:text-white select-all break-all">{newCode}</p>
                      <button type="button" onClick={() => navigator.clipboard?.writeText(newCode).then(() => onToast('Recovery code copied.', 'success'))}
                        className={`${GHOST} mt-2`}>Copy</button>
                    </div>
                  )}
                  <button type="button" onClick={handleNewCode} disabled={busy} className={`${GHOST} mt-3`}>
                    {recovery?.exists ? 'Replace recovery code' : 'Create recovery code'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
