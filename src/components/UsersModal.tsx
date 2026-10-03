/**
 * UsersModal.tsx — company admin: who can sign in, and what they can open.
 *
 * Module ticks are enforced in Apps Script, not here: a user without Payroll
 * never receives employee or payslip rows in the first place, so hiding the nav
 * item is cosmetic reinforcement rather than the control itself.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Users as UsersIcon, X, Loader2, Plus, KeyRound, Trash2, Check, AlertTriangle, ShieldCheck,
} from 'lucide-react';
import {
  listUsers, createUser, updateUser, resetUserPassword, deleteUser, changePassword,
  ALL_MODULES, MODULE_LABELS, ModuleName, Session, SessionUser,
} from '../auth';

type Tab = 'users' | 'password';

const INPUT =
  'w-full px-3 py-2 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-950 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const LABEL =
  'block text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-slate-400 mb-1';
const PRIMARY =
  'px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-bold text-xs rounded-xl transition-colors cursor-pointer shadow-sm';
const GHOST =
  'px-3 py-1.5 rounded-lg border border-gray-200 dark:border-slate-700 text-xs font-bold text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer transition-colors';

function ModuleTicks({
  selected, disabled, onToggle,
}: { selected: ModuleName[]; disabled?: boolean; onToggle: (m: ModuleName) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {ALL_MODULES.map(m => (
        <label
          key={m}
          className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border text-[11px] font-medium select-none ${
            disabled
              ? 'opacity-50 cursor-not-allowed border-gray-200 dark:border-slate-700'
              : 'cursor-pointer border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800'
          } text-gray-700 dark:text-slate-300`}
        >
          <input
            type="checkbox"
            disabled={disabled}
            checked={selected.indexOf(m) !== -1}
            onChange={() => onToggle(m)}
            className="w-3.5 h-3.5 rounded border-gray-300 dark:border-slate-600 text-indigo-600"
          />
          {MODULE_LABELS[m]}
        </label>
      ))}
    </div>
  );
}

export function UsersModal({
  session, isDark, onClose, onToast,
}: {
  session: Session;
  isDark: boolean;
  onClose: () => void;
  onToast: (msg: string, type: 'success' | 'error' | 'info' | 'warning') => void;
}) {
  const isAdmin = session.user.role === 'admin';
  const [tab, setTab] = useState<Tab>(isAdmin ? 'users' : 'password');
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [loading, setLoading] = useState(isAdmin);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    userId: '', password: '', fullName: '', email: '',
    role: 'member' as 'admin' | 'member', modules: ['invoicing'] as ModuleName[],
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ fullName: string; email: string; role: 'admin' | 'member'; modules: ModuleName[]; active: boolean } | null>(null);

  const [pw, setPw] = useState({ old: '', next: '', confirm: '' });

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
    const ok = await run(() => createUser({
      userId: draft.userId.trim(), password: draft.password,
      fullName: draft.fullName.trim() || draft.userId.trim(), email: draft.email.trim(),
      role: draft.role, modules: draft.modules,
    }), `User "${draft.userId.trim()}" created.`);
    if (ok) {
      setAdding(false);
      setDraft({ userId: '', password: '', fullName: '', email: '', role: 'member', modules: ['invoicing'] });
    }
  };

  const startEdit = (u: SessionUser) => {
    setEditingId(u.user_id);
    setEdit({ fullName: u.full_name, email: u.email, role: u.role, modules: u.modules, active: u.active });
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
    <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className={`w-full max-w-2xl rounded-2xl shadow-2xl flex flex-col max-h-[90vh] ${isDark ? 'bg-slate-900 border border-slate-800' : 'bg-white border border-gray-200'}`}>

        <div className={`flex items-center justify-between px-5 py-4 border-b flex-shrink-0 ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
          <div className="flex items-center gap-2">
            <UsersIcon className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-bold text-gray-900 dark:text-white">Users &amp; Access</h2>
            <span className="text-[10px] font-semibold text-gray-400 dark:text-slate-500">{session.company.company_name}</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {isAdmin && (
          <div className={`flex border-b flex-shrink-0 ${isDark ? 'border-slate-800' : 'border-gray-100'}`}>
            {([['users', 'Team Members'], ['password', 'My Password']] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => { setTab(key); setError(''); }}
                className={`flex-1 py-2.5 text-xs font-bold transition-colors cursor-pointer ${
                  tab === key
                    ? 'border-b-2 border-indigo-500 text-indigo-600 dark:text-indigo-300'
                    : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
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
                  <Loader2 className="w-5 h-5 animate-spin text-indigo-500" />
                </div>
              ) : (
                <div className="space-y-2">
                  {users.map(u => {
                    const isSelf = u.user_id.toLowerCase() === session.user.user_id.toLowerCase();
                    const isEditing = editingId === u.user_id;
                    return (
                      <div
                        key={u.user_id}
                        className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-950/40' : 'border-gray-200 bg-gray-50/60'}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-bold text-gray-900 dark:text-white truncate">{u.full_name || u.user_id}</span>
                              <span className="text-[10px] font-mono text-gray-500 dark:text-slate-500">{u.user_id}</span>
                              {u.role === 'admin' && (
                                <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300">
                                  <ShieldCheck className="w-2.5 h-2.5" />Admin
                                </span>
                              )}
                              {!u.active && (
                                <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-gray-200 dark:bg-slate-800 text-gray-600 dark:text-slate-400">
                                  Disabled
                                </span>
                              )}
                              {isSelf && <span className="text-[9px] font-bold uppercase text-gray-400 dark:text-slate-600">you</span>}
                            </div>
                            <p className="text-[10px] text-gray-500 dark:text-slate-500 mt-0.5 truncate">
                              {u.role === 'admin' ? 'All modules' : (u.modules.map(m => MODULE_LABELS[m]).join(' · ') || 'No modules assigned')}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button onClick={() => (isEditing ? (setEditingId(null), setEdit(null)) : startEdit(u))} className={GHOST}>
                              {isEditing ? 'Cancel' : 'Edit'}
                            </button>
                            <button onClick={() => handleReset(u.user_id)} disabled={busy}
                              title="Reset password"
                              className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer">
                              <KeyRound className="w-3.5 h-3.5" />
                            </button>
                            {!isSelf && (
                              <button onClick={() => handleDelete(u.user_id)} disabled={busy}
                                title="Delete user"
                                className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>

                        {isEditing && edit && (
                          <div className="mt-3 pt-3 border-t border-gray-200 dark:border-slate-800 space-y-2.5">
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
                                <select value={edit.role} onChange={e => setEdit({ ...edit, role: e.target.value as 'admin' | 'member' })} className={INPUT}>
                                  <option value="member">Member</option>
                                  <option value="admin">Admin (full access)</option>
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
                            <div>
                              <label className={LABEL}>
                                Modules {edit.role === 'admin' && <span className="normal-case font-normal">— admins always get everything</span>}
                              </label>
                              <ModuleTicks selected={edit.role === 'admin' ? ALL_MODULES : edit.modules} disabled={edit.role === 'admin'} onToggle={toggleEditModule} />
                            </div>
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
                <div className={`rounded-xl border p-3 space-y-2.5 ${isDark ? 'border-indigo-900/60 bg-indigo-950/20' : 'border-indigo-200 bg-indigo-50/50'}`}>
                  <p className="text-xs font-bold text-gray-900 dark:text-white">New team member</p>
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
                    <select value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value as 'admin' | 'member' })} className={INPUT}>
                      <option value="member">Member</option>
                      <option value="admin">Admin (full access)</option>
                    </select>
                  </div>
                  <div>
                    <label className={LABEL}>Modules this user can open</label>
                    <ModuleTicks selected={draft.role === 'admin' ? ALL_MODULES : draft.modules} disabled={draft.role === 'admin'} onToggle={toggleDraftModule} />
                  </div>
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
                  className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-dashed border-gray-300 dark:border-slate-700 text-xs font-bold text-gray-500 dark:text-slate-400 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Team Member
                </button>
              )}
            </>
          )}

          {tab === 'password' && (
            <div className="space-y-2.5 max-w-sm">
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Signed in as <span className="font-bold text-gray-800 dark:text-slate-200">{session.user.user_id}</span>.
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
