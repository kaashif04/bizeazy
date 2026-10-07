/**
 * TeamModule.tsx — attendance, leave and kiosks, for owners and managers.
 *
 * Staff see their own side of this in the separate BizEazy Staff app. Here the
 * Hub sets the rules (work hours, leave types, kiosks), fixes attendance
 * (adds a missed scan, removes a wrong one, never edits one) and decides leave.
 * The database pairs scans into days and does the leave arithmetic; see
 * src/team.ts.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, CalendarDays, CalendarClock, Plane, Settings2, Plus, Check, X, Copy, Fingerprint, FileUp, RefreshCw } from 'lucide-react';
import type { DatabaseState, CompanyProfile } from '../types';
import { outletLabel } from '../utils/outlets';
import { loadConfig, saveCompanySettings } from '../db';
import { publishAllPayslips } from '../utils/payslipPdf';
import { Sheet } from './ui/Sheet';
import { Skeleton, EmptyState } from './ui/States';
import {
  clock, duration, workDate, monthRange, mytToIso, dayLabel, rulesOf, DEFAULT_RULES,
  onShiftNow, daysBetween, scansOn, addMissedScan, removeScan,
  leaveTypes, saveLeaveType, leaveRequests, leaveBalances, decideLeave,
  listKiosks, registerKiosk, revokeKiosk, KIOSK_ENDPOINT, watchTeam,
  loadShifts, saveShift, shiftFor, describeWeek, hhmm, type ShiftDay,
  type AttendanceDay, type ScanEvent, type LeaveType, type LeaveRequest,
  type LeaveBalance, type Kiosk, type AttendanceRules,
} from '../team';

type Toast = (msg: string, type: 'success' | 'error' | 'info' | 'warning') => void;
type Tab = 'today' | 'attendance' | 'shifts' | 'leave' | 'setup';

const CARD = 'rounded-2xl bg-white dark:bg-ink-900 shadow-sm';
const LABEL = 'text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-ink-500 dark:text-ink-400';
const INPUT = 'w-full px-3 py-2 text-sm rounded-xl border border-ink-200 dark:border-ink-700 bg-ink-50 dark:bg-ink-950 text-ink-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-brand-500';
const PRIMARY = 'inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-xs font-bold cursor-pointer transition-colors';
const GHOST = 'inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full border border-ink-200 dark:border-ink-700 text-xs font-bold text-ink-700 dark:text-ink-200 hover:bg-ink-50 dark:hover:bg-ink-800 cursor-pointer transition-colors disabled:opacity-60';

function Pill({ tone, children }: { tone: 'ok' | 'wait' | 'bad' | 'info' | 'muted'; children: React.ReactNode }) {
  const t = {
    ok:    ['bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300', 'bg-emerald-500'],
    wait:  ['bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300', 'bg-amber-500'],
    bad:   ['bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300', 'bg-rose-500'],
    info:  ['bg-brand-50 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300', 'bg-brand-500'],
    muted: ['bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300', 'bg-ink-400'],
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-bold whitespace-nowrap ${t[0]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${t[1]}`} />{children}
    </span>
  );
}

function DayBadges({ d }: { d: AttendanceDay }) {
  return (
    <span className="flex flex-wrap gap-1">
      {d.scheduled === false && <Pill tone="muted">Day off</Pill>}
      {d.late && <Pill tone="wait">Late</Pill>}
      {d.open && d.work_date !== workDate() && <Pill tone="bad">Missed clock-out</Pill>}
      {d.open && d.work_date === workDate() && <Pill tone="info">On shift</Pill>}
      {d.has_manual && <Pill tone="muted">Corrected</Pill>}
      {d.untrusted_clock && <Pill tone="bad">Kiosk clock wrong</Pill>}
    </span>
  );
}

/** Someone not on the books any more is still named in old records, but not offered for new ones. */
const isCurrent = (e: { End_Date?: string }) => !e.End_Date || String(e.End_Date).slice(0, 10) >= workDate();

export function TeamModule({
  db, profiles, companyId, canSettings, canPayroll, payrollScope, triggerToast,
}: {
  db: DatabaseState;
  profiles: CompanyProfile[];
  companyId: string;
  canSettings: boolean;
  canPayroll: boolean;
  payrollScope: 'company' | 'branch';
  triggerToast: Toast;
}) {
  const [tab, setTab] = useState<Tab>('today');
  const [tick, setTick] = useState(0);   // bumps on live changes; each tab refetches
  useEffect(() => watchTeam(() => setTick(t => t + 1)), []);

  const names = useMemo(() => new Map(db.employees.map(e => [e.Employee_ID, e.Employee_Name])), [db.employees]);
  const people = useMemo(() => db.employees.filter(isCurrent)
    .sort((a, b) => a.Employee_Name.localeCompare(b.Employee_Name)), [db.employees]);
  const nameOf = (id: string) => names.get(id) || id;

  const tabs: [Tab, string, React.FC<React.SVGProps<SVGSVGElement>>][] = [
    ['today', 'Today', Clock], ['attendance', 'Attendance', CalendarDays], ['shifts', 'Shifts', CalendarClock],
    ['leave', 'Leave', Plane], ['setup', 'Setup', Settings2],
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-5 pb-8">
      <div role="tablist" aria-label="Team" className="grid grid-cols-5 sm:inline-flex w-full sm:w-auto p-1 rounded-full bg-ink-100 dark:bg-ink-900 shadow-[inset_1px_1px_3px_var(--nm-sh),inset_-1px_-1px_3px_var(--nm-hl)]">
        {tabs.map(([key, label, Icon]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`flex items-center justify-center gap-1.5 px-0.5 sm:px-4 py-2 rounded-full text-[0.6875rem] sm:text-xs font-bold whitespace-nowrap cursor-pointer transition-colors ${
              tab === key ? 'bg-white dark:bg-ink-800 text-brand-700 dark:text-brand-300 shadow-sm' : 'text-ink-600 dark:text-ink-300 hover:text-ink-900 dark:hover:text-white'}`}>
            <Icon className="w-3.5 h-3.5 hidden sm:block" />{label}
          </button>
        ))}
      </div>

      <div key={tab} className="view-enter">
        {tab === 'today' && <TodayTab tick={tick} people={people} nameOf={nameOf} onOpenLeave={() => setTab('leave')} />}
        {tab === 'attendance' && <AttendanceTab tick={tick} people={people} nameOf={nameOf} triggerToast={triggerToast} />}
        {tab === 'shifts' && <ShiftsTab tick={tick} people={people} triggerToast={triggerToast} />}
        {tab === 'leave' && <LeaveTab tick={tick} nameOf={nameOf} companyId={companyId} triggerToast={triggerToast} />}
        {tab === 'setup' && (
          <SetupTab db={db} profiles={profiles} companyId={companyId} canSettings={canSettings} canPayroll={canPayroll}
            payrollScope={payrollScope} triggerToast={triggerToast} />
        )}
      </div>
    </div>
  );
}

// ── Today ────────────────────────────────────────────────────────────────────

function useLoad<T>(load: () => Promise<T>, deps: React.DependencyList): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(d => { if (live) { setData(d); setError(''); } })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading: data === null && !error, reload: () => setN(x => x + 1) };
}

function ErrorNote({ message }: { message: string }) {
  return <p role="alert" className={`${CARD} p-4 text-sm text-rose-700 dark:text-rose-300`}>{message}</p>;
}

function TodayTab({ tick, people, nameOf, onOpenLeave }: {
  tick: number; people: DatabaseState['employees']; nameOf: (id: string) => string; onOpenLeave: () => void;
}) {
  const today = workDate();
  const { data, error } = useLoad(async () => {
    const [shift, days, reqs, shifts, config] = await Promise.all([onShiftNow(), daysBetween(today, today), leaveRequests(), loadShifts(), loadConfig()]);
    return { shift, days, shifts, rules: rulesOf(config), pending: reqs.filter(r => r.status === 'pending').length,
      away: reqs.filter(r => r.status === 'approved' && r.start_date <= today && r.end_date >= today) };
  }, [tick, today]);
  // A live "so far" without refetching: re-render every minute.
  const [, setNow] = useState(0);
  useEffect(() => { const t = setInterval(() => setNow(n => n + 1), 60_000); return () => clearInterval(t); }, []);

  if (error) return <ErrorNote message={error} />;
  const byId = new Map((data?.days || []).map(d => [d.employee_id, d]));
  const awayIds = new Set((data?.away || []).map(r => r.employee_id));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-5">
      <section className={`${CARD} p-5 min-w-0`} aria-labelledby="on-shift">
        <div className="flex items-baseline justify-between">
          <h2 id="on-shift" className={LABEL}>On shift now</h2>
          {data && <span className="text-2xl font-semibold text-ink-900 dark:text-white tabular-nums">{data.shift.length}</span>}
        </div>
        {!data ? <div className="mt-4 space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          : data.shift.length === 0 ? <p className="mt-4 text-sm text-ink-500 dark:text-ink-400">Nobody is clocked in right now.</p>
          : (
            <ul className="mt-3 divide-y divide-ink-100 dark:divide-ink-800">
              {data.shift.map(s => (
                <li key={s.employee_id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink-900 dark:text-white truncate">{s.employee_name}</span>
                    <span className="block text-xs text-ink-500 dark:text-ink-400">{s.branch || '—'} · since {clock(s.since)}</span>
                  </span>
                  <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-300 tabular-nums whitespace-nowrap">
                    {duration((Date.now() - new Date(s.since).getTime()) / 60000)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        {data && data.pending > 0 && (
          <button onClick={onOpenLeave} className={`${GHOST} mt-4`}>
            <Plane className="w-3.5 h-3.5" />{data.pending} leave request{data.pending === 1 ? '' : 's'} waiting
          </button>
        )}
      </section>

      <section className={`${CARD} min-w-0 overflow-hidden`} aria-labelledby="today-all">
        <h2 id="today-all" className={`${LABEL} px-5 pt-5 pb-2`}>Everyone today · {dayLabel(today)}</h2>
        {!data ? <div className="p-5 space-y-2"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
          : people.length === 0 ? <EmptyState compact icon={<Clock />} title="No staff yet" body="Add employees in Payroll; they appear here." />
          : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {people.map(p => {
                const d = byId.get(p.Employee_ID);
                const plan = data ? shiftFor(p.Employee_ID, today, data.shifts, data.rules) : null;
                return (
                  <li key={p.Employee_ID} className="flex items-center justify-between gap-3 px-5 py-3">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink-900 dark:text-white truncate">{nameOf(p.Employee_ID)}</span>
                      <span className="block text-xs text-ink-500 dark:text-ink-400 tabular-nums">
                        {d ? `${clock(d.first_in)} – ${d.open ? 'now' : clock(d.last_out)} · ${duration(d.worked_minutes)}`
                          : plan ? `Shift ${hhmm(plan.start)} – ${hhmm(plan.end)}` : 'Day off'}
                      </span>
                    </span>
                    {d ? <DayBadges d={d} /> : awayIds.has(p.Employee_ID) ? <Pill tone="info">On leave</Pill>
                      : !plan ? <Pill tone="muted">Off today</Pill> : <Pill tone="wait">Not in yet</Pill>}
                  </li>
                );
              })}
            </ul>
          )}
      </section>
    </div>
  );
}

// ── Attendance ───────────────────────────────────────────────────────────────

function AttendanceTab({ tick, people, nameOf, triggerToast }: {
  tick: number; people: DatabaseState['employees']; nameOf: (id: string) => string; triggerToast: Toast;
}) {
  const [who, setWho] = useState(people[0]?.Employee_ID || '');
  const [month, setMonth] = useState(workDate().slice(0, 7));
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [from, to] = monthRange(month);
  const { data, error, reload } = useLoad(() => who ? daysBetween(from, to, who) : Promise.resolve([]), [who, from, to, tick]);

  const total = (data || []).reduce((s, d) => s + d.worked_minutes, 0);
  return (
    <div className="space-y-4">
      <div className={`${CARD} p-4 grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-3 items-end`}>
        <label className="block">
          <span className={LABEL}>Person</span>
          <select value={who} onChange={e => setWho(e.target.value)} className={`${INPUT} mt-1`}>
            {people.map(p => <option key={p.Employee_ID} value={p.Employee_ID}>{p.Employee_Name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className={LABEL}>Month</span>
          <input type="month" value={month} onChange={e => e.target.value && setMonth(e.target.value)} className={`${INPUT} mt-1`} />
        </label>
        <button className={PRIMARY} disabled={!who} onClick={() => setOpenDay(workDate())}>
          <Plus className="w-3.5 h-3.5" />Add missed scan
        </button>
      </div>

      {error ? <ErrorNote message={error} /> : (
        <section className={`${CARD} overflow-hidden`} aria-label="Days">
          <div className="flex gap-6 px-5 pt-4 pb-2">
            <span><span className={LABEL}>Days worked</span><span className="block text-xl font-semibold text-ink-900 dark:text-white tabular-nums">{data?.length ?? '—'}</span></span>
            <span><span className={LABEL}>Hours</span><span className="block text-xl font-semibold text-ink-900 dark:text-white tabular-nums">{data ? duration(total) : '—'}</span></span>
          </div>
          {!data ? <div className="p-5 space-y-2"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
            : data.length === 0 ? <p className="px-5 pb-5 text-sm text-ink-500 dark:text-ink-400">No scans for {nameOf(who)} in this month.</p>
            : (
              <ul className="divide-y divide-ink-100 dark:divide-ink-800">
                {data.map(d => (
                  <li key={d.work_date}>
                    <button onClick={() => setOpenDay(d.work_date)}
                      className="w-full grid grid-cols-[5.5rem_1fr_auto] sm:grid-cols-[7rem_10rem_5rem_1fr] items-center gap-3 px-5 py-3 text-left hover:bg-ink-50 dark:hover:bg-ink-800/50 cursor-pointer">
                      <span className="text-sm font-semibold text-ink-900 dark:text-white">{dayLabel(d.work_date)}</span>
                      <span className="text-xs text-ink-600 dark:text-ink-300 tabular-nums">{clock(d.first_in)} – {d.open ? '…' : clock(d.last_out)}</span>
                      <span className="text-sm font-semibold text-ink-900 dark:text-white tabular-nums text-right sm:text-left">{duration(d.worked_minutes)}</span>
                      <span className="col-span-3 sm:col-span-1"><DayBadges d={d} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </section>
      )}

      {openDay && who && (
        <DaySheet employeeId={who} name={nameOf(who)} date={openDay} triggerToast={triggerToast}
          onClose={() => setOpenDay(null)} onChanged={reload} />
      )}
    </div>
  );
}

function DaySheet({ employeeId, name, date: initialDate, triggerToast, onClose, onChanged }: {
  employeeId: string; name: string; date: string; triggerToast: Toast; onClose: () => void; onChanged: () => void;
}) {
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const { data: scans, error, reload } = useLoad<ScanEvent[]>(() => scansOn(employeeId, date), [employeeId, date]);

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await work(); triggerToast(done, 'success'); reload(); onChanged(); return true; }
    catch (e: any) { triggerToast(e.message, 'error'); return false; }
    finally { setBusy(false); }
  };
  const add = async () => {
    if (!time) { triggerToast('Enter the time of the missed scan.', 'warning'); return; }
    // Times after midnight but before 4 am belong to this working day, so they are on the next calendar date.
    const calendar = time < '04:00' ? new Date(new Date(`${date}T12:00:00Z`).getTime() + 86400_000).toISOString().slice(0, 10) : date;
    if (await act(() => addMissedScan(employeeId, mytToIso(calendar, time), note), 'Scan added.')) { setTime(''); setNote(''); }
  };

  return (
    <Sheet title={name} subtitle={`Scans on ${dayLabel(date)}`} icon={<Fingerprint className="w-4 h-4" />} onClose={onClose} maxWidth="md">
      <div className="space-y-5">
        <label className="block">
          <span className={LABEL}>Working day</span>
          <input type="date" value={date} max={workDate()} onChange={e => e.target.value && setDate(e.target.value)} className={`${INPUT} mt-1`} />
        </label>

        {error ? <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>
          : !scans ? <Skeleton className="h-16" />
          : scans.length === 0 ? <p className="text-sm text-ink-500 dark:text-ink-400">No scans on this day.</p>
          : (
            <ul className="space-y-2">
              {scans.map(s => (
                <li key={s.id} className={`rounded-xl px-3 py-2.5 bg-ink-50 dark:bg-ink-800/60 ${s.voided ? 'opacity-60' : ''}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm font-semibold tabular-nums ${s.voided ? 'line-through text-ink-500' : 'text-ink-900 dark:text-white'}`}>{clock(s.occurred_at)}</span>
                    <span className="flex items-center gap-1.5">
                      {s.method === 'manual' ? <Pill tone="muted">Added by manager</Pill> : <Pill tone="ok">{s.method === 'face' ? 'Face' : 'Fingerprint'}</Pill>}
                      {!s.clock_trusted && <Pill tone="bad">Clock wrong</Pill>}
                      {!s.voided && removing !== s.id && (
                        <button onClick={() => { setRemoving(s.id); setReason(''); }} className="text-xs font-bold text-rose-700 dark:text-rose-300 hover:underline cursor-pointer px-1 min-h-8">Remove</button>
                      )}
                    </span>
                  </div>
                  {s.note && <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">{s.note}</p>}
                  {s.voided && <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">Removed: {s.voided.reason}</p>}
                  {removing === s.id && (
                    <div className="mt-2 flex gap-2">
                      <input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Why? e.g. scanned twice" className={INPUT} />
                      <button disabled={busy || !reason.trim()} className={GHOST}
                        onClick={async () => { if (await act(() => removeScan(s.id, reason), 'Scan removed.')) setRemoving(null); }}>Remove</button>
                      <button onClick={() => setRemoving(null)} className={GHOST} aria-label="Keep this scan"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

        <div className="rounded-2xl p-4 bg-ink-50 dark:bg-ink-800/60 space-y-3">
          <p className={LABEL}>Add a missed scan</p>
          <div className="grid grid-cols-[8rem_1fr] gap-2">
            <input type="time" value={time} onChange={e => setTime(e.target.value)} className={INPUT} aria-label="Time" />
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note, e.g. forgot to clock out" className={INPUT} aria-label="Note" />
          </div>
          <p className="text-2xs text-ink-500 dark:text-ink-400">Malaysia time. A time before 4 am counts as the end of this working day.</p>
          <button onClick={add} disabled={busy} className={PRIMARY}><Plus className="w-3.5 h-3.5" />Add scan</button>
        </div>
      </div>
    </Sheet>
  );
}

// ── Leave ────────────────────────────────────────────────────────────────────

const fmtDates = (r: LeaveRequest) => r.start_date === r.end_date
  ? `${dayLabel(r.start_date)}${r.half_day ? ' (half day)' : ''}` : `${dayLabel(r.start_date)} – ${dayLabel(r.end_date)}`;
const days = (n: number) => `${Number(n)} day${Number(n) === 1 ? '' : 's'}`;

function LeaveTab({ tick, nameOf, companyId, triggerToast }: {
  tick: number; nameOf: (id: string) => string; companyId: string; triggerToast: Toast;
}) {
  const { data, error, reload } = useLoad(async () => {
    const [types, reqs, bals] = await Promise.all([leaveTypes(), leaveRequests(), leaveBalances()]);
    return { types, reqs, bals };
  }, [tick]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>;

  const typeName = (id: string) => data.types.find(t => t.id === id)?.name || 'Leave';
  const balance = (r: LeaveRequest): LeaveBalance | undefined =>
    data.bals.find(b => b.employee_id === r.employee_id && b.leave_type_id === r.leave_type_id);
  const pending = data.reqs.filter(r => r.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const decided = data.reqs.filter(r => r.status !== 'pending').slice(0, 20);

  const decide = async (r: LeaveRequest, approve: boolean) => {
    setBusy(r.id);
    try {
      await decideLeave(r.id, approve, notes[r.id] || '');
      triggerToast(`${approve ? 'Approved' : 'Rejected'}: ${nameOf(r.employee_id)}, ${fmtDates(r)}.`, 'success');
      reload();
    } catch (e: any) { triggerToast(e.message, 'error'); }
    finally { setBusy(null); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr] gap-5">
      <div className="space-y-5 min-w-0">
        <section className="space-y-2" aria-labelledby="leave-pending">
          <h2 id="leave-pending" className={LABEL}>Waiting for you · {pending.length}</h2>
          {pending.length === 0 ? <p className={`${CARD} p-5 text-sm text-ink-500 dark:text-ink-400`}>No leave requests are waiting.</p>
            : pending.map(r => {
              const b = balance(r);
              return (
                <div key={r.id} className={`${CARD} p-4 space-y-3 row-enter`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink-900 dark:text-white">{nameOf(r.employee_id)}</p>
                      <p className="text-xs text-ink-600 dark:text-ink-300">{typeName(r.leave_type_id)} · {fmtDates(r)} · {days(r.days)}</p>
                      {r.reason && <p className="text-xs text-ink-500 dark:text-ink-400 mt-1">“{r.reason}”</p>}
                    </div>
                    {b?.remaining != null && <Pill tone={b.remaining < 0 ? 'bad' : 'muted'}>{Number(b.remaining)} left after</Pill>}
                  </div>
                  <input value={notes[r.id] || ''} onChange={e => setNotes({ ...notes, [r.id]: e.target.value })}
                    placeholder="Note to them (optional)" className={INPUT} />
                  <div className="flex gap-2 justify-end">
                    <button disabled={busy === r.id} onClick={() => decide(r, false)} className={GHOST}><X className="w-3.5 h-3.5" />Reject</button>
                    <button disabled={busy === r.id} onClick={() => decide(r, true)} className={PRIMARY}><Check className="w-3.5 h-3.5" />Approve</button>
                  </div>
                </div>
              );
            })}
        </section>

        {decided.length > 0 && (
          <section className={`${CARD} overflow-hidden`} aria-labelledby="leave-decided">
            <h2 id="leave-decided" className={`${LABEL} px-5 pt-4 pb-2`}>Recently decided</h2>
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {decided.map(r => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink-900 dark:text-white truncate">{nameOf(r.employee_id)}</span>
                    <span className="block text-xs text-ink-500 dark:text-ink-400">{typeName(r.leave_type_id)} · {fmtDates(r)}</span>
                  </span>
                  <Pill tone={r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'bad' : 'muted'}>
                    {r.status[0].toUpperCase() + r.status.slice(1)}
                  </Pill>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <LeaveTypesCard types={data.types} companyId={companyId} triggerToast={triggerToast} onSaved={reload} />
    </div>
  );
}

function LeaveTypesCard({ types, companyId, triggerToast, onSaved }: {
  types: LeaveType[]; companyId: string; triggerToast: Toast; onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Partial<LeaveType> & { name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (t: Partial<LeaveType> & { name: string }) => {
    if (!t.name.trim()) { triggerToast('Give the leave type a name.', 'warning'); return; }
    setBusy(true);
    try { await saveLeaveType(t, companyId); triggerToast(`${t.name.trim()} saved.`, 'success'); setDraft(null); onSaved(); }
    catch (e: any) { triggerToast(e.message, 'error'); }
    finally { setBusy(false); }
  };

  return (
    <section className={`${CARD} p-5 space-y-3 self-start`} aria-labelledby="leave-types">
      <h2 id="leave-types" className={LABEL}>Leave types</h2>
      {types.length === 0 && !draft && (
        <p className="text-sm text-ink-500 dark:text-ink-400">Staff can request leave once you add a type, e.g. Annual, 12 days a year.</p>
      )}
      <ul className="space-y-2">
        {types.map(t => (
          <li key={t.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 bg-ink-50 dark:bg-ink-800/60">
            <span className="min-w-0">
              <span className={`block text-sm font-semibold ${t.active ? 'text-ink-900 dark:text-white' : 'text-ink-500 line-through'}`}>{t.name}</span>
              <span className="block text-xs text-ink-500 dark:text-ink-400">
                {Number(t.days_per_year) > 0 ? `${Number(t.days_per_year)} days a year` : 'No yearly limit'} · {t.paid ? 'Paid' : 'Unpaid'}
              </span>
            </span>
            <button onClick={() => setDraft({ ...t })} className={GHOST}>Edit</button>
          </li>
        ))}
      </ul>
      {draft ? (
        <div className="rounded-2xl p-3 bg-ink-50 dark:bg-ink-800/60 space-y-2">
          <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Name, e.g. Annual leave" className={INPUT} />
          <label className="flex items-center gap-2 text-xs text-ink-700 dark:text-ink-200">
            Days a year
            <input type="number" min={0} step={0.5} value={draft.days_per_year ?? 0}
              onChange={e => setDraft({ ...draft, days_per_year: Number(e.target.value) })} className={`${INPUT} w-24`} />
            <span className="text-ink-500 dark:text-ink-400">0 = no limit</span>
          </label>
          <div className="flex gap-4 text-xs text-ink-700 dark:text-ink-200">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.paid ?? true} onChange={e => setDraft({ ...draft, paid: e.target.checked })} />Paid</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={draft.active ?? true} onChange={e => setDraft({ ...draft, active: e.target.checked })} />Staff can request it</label>
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setDraft(null)} className={GHOST}>Cancel</button>
            <button disabled={busy} onClick={() => save(draft)} className={PRIMARY}>Save</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ name: '', days_per_year: 12, paid: true, active: true })} className={GHOST}>
          <Plus className="w-3.5 h-3.5" />Add leave type
        </button>
      )}
    </section>
  );
}

// ── Setup ────────────────────────────────────────────────────────────────────

const WEEKDAYS: [number, string][] = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

function SetupTab({ db, profiles, companyId, canSettings, canPayroll, payrollScope, triggerToast }: {
  db: DatabaseState; profiles: CompanyProfile[]; companyId: string; canSettings: boolean; canPayroll: boolean;
  payrollScope: 'company' | 'branch'; triggerToast: Toast;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <WorkHoursCard canSettings={canSettings} triggerToast={triggerToast} />
      <div className="space-y-5 min-w-0">
        <KiosksCard profiles={profiles} triggerToast={triggerToast} />
        {canPayroll && <PublishCard db={db} profiles={profiles} companyId={companyId} payrollScope={payrollScope} triggerToast={triggerToast} />}
        <section className={`${CARD} p-5`}>
          <h2 className={LABEL}>Staff logins</h2>
          <p className="mt-2 text-sm text-ink-600 dark:text-ink-300">
            Give each person a login in <span className="font-semibold">Users &amp; Access</span>: choose the Staff role and their employee record.
            They use it in the BizEazy Staff app to see clock-ins, payslips and leave.
          </p>
        </section>
      </div>
    </div>
  );
}

function WorkHoursCard({ canSettings, triggerToast }: { canSettings: boolean; triggerToast: Toast }) {
  const [rules, setRules] = useState<AttendanceRules | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadConfig().then(c => setRules(rulesOf(c))).catch(() => setRules(DEFAULT_RULES)); }, []);
  if (!rules) return <Skeleton className="h-72 rounded-2xl" />;

  const set = <K extends keyof AttendanceRules>(k: K, v: AttendanceRules[K]) => setRules({ ...rules, [k]: v });
  const save = async () => {
    if (!rules.work_days.length) { triggerToast('Choose at least one work day.', 'warning'); return; }
    setBusy(true);
    try { await saveCompanySettings({ attendance: rules }); triggerToast('Work hours saved.', 'success'); }
    catch (e: any) { triggerToast(`Not saved: ${e.message}`, 'error'); }
    finally { setBusy(false); }
  };
  const num = (k: 'grace_minutes' | 'break_minutes' | 'standard_hours_per_day', label: string, step = 1) => (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <input type="number" min={0} step={step} value={rules[k]} disabled={!canSettings}
        onChange={e => set(k, Number(e.target.value))} className={`${INPUT} mt-1`} />
    </label>
  );

  return (
    <section className={`${CARD} p-5 space-y-4 self-start`} aria-labelledby="work-hours">
      <h2 id="work-hours" className={LABEL}>Default hours</h2>
      <p className="text-xs text-ink-500 dark:text-ink-400 -mt-2">For anyone without their own shift (set those in Shifts).</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className={LABEL}>Day starts</span>
          <input type="time" value={rules.day_start} disabled={!canSettings} onChange={e => set('day_start', e.target.value)} className={`${INPUT} mt-1`} /></label>
        <label className="block"><span className={LABEL}>Day ends</span>
          <input type="time" value={rules.day_end} disabled={!canSettings} onChange={e => set('day_end', e.target.value)} className={`${INPUT} mt-1`} /></label>
        {num('grace_minutes', 'Late after (min)')}
        {num('break_minutes', 'Break (min)')}
        {num('standard_hours_per_day', 'Hours a day', 0.5)}
      </div>
      <div>
        <span className={LABEL}>Work days</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {WEEKDAYS.map(([n, label]) => {
            const on = rules.work_days.includes(n);
            return (
              <button key={n} type="button" disabled={!canSettings} aria-pressed={on}
                onClick={() => set('work_days', on ? rules.work_days.filter(d => d !== n) : [...rules.work_days, n].sort())}
                className={`px-3 py-1.5 rounded-full text-xs font-bold cursor-pointer transition-colors ${on
                  ? 'bg-brand-600 text-white' : 'bg-ink-100 dark:bg-ink-800 text-ink-600 dark:text-ink-300'}`}>{label}</button>
            );
          })}
        </div>
      </div>
      <p className="text-xs text-ink-500 dark:text-ink-400">
        Someone is late when their first scan is after their shift start plus the grace minutes. Grace applies to everyone.
      </p>
      {canSettings
        ? <button onClick={save} disabled={busy} className={PRIMARY}>{busy ? 'Saving…' : 'Save work hours'}</button>
        : <p className="text-xs text-amber-800 dark:text-amber-300">Only someone with Settings access can change these.</p>}
    </section>
  );
}

function KiosksCard({ profiles, triggerToast }: { profiles: CompanyProfile[]; triggerToast: Toast }) {
  const { data, error, reload } = useLoad<Kiosk[]>(listKiosks, []);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [branch, setBranch] = useState(profiles[0] ? outletLabel(profiles[0]) : '');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try { const k = await registerKiosk(name, branch); setToken(k.token); setAdding(false); setName(''); reload(); }
    catch (e: any) { triggerToast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const revoke = async (k: Kiosk) => {
    if (!window.confirm(`Stop "${k.name}" from sending scans? This cannot be undone; register it again to reconnect.`)) return;
    try { await revokeKiosk(k.id); triggerToast(`${k.name} disconnected.`, 'success'); reload(); }
    catch (e: any) { triggerToast(e.message, 'error'); }
  };
  const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => triggerToast(`${what} copied.`, 'success'));

  return (
    <section className={`${CARD} p-5 space-y-3`} aria-labelledby="kiosks">
      <div className="flex items-center justify-between">
        <h2 id="kiosks" className={LABEL}>Clock-in kiosks</h2>
        <button onClick={reload} className="p-1.5 rounded-full text-ink-500 hover:text-brand-600 cursor-pointer" aria-label="Refresh kiosks"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>
      {error ? <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p>
        : !data ? <Skeleton className="h-12" />
        : data.length === 0 && !token ? <p className="text-sm text-ink-500 dark:text-ink-400">No kiosks yet. Register one to get the token it signs in with.</p>
        : (
          <ul className="space-y-2">
            {data.map(k => (
              <li key={k.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 bg-ink-50 dark:bg-ink-800/60">
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-900 dark:text-white truncate">{k.name}</span>
                  <span className="block text-xs text-ink-500 dark:text-ink-400">
                    {k.branch || 'Any branch'} · {k.last_seen_at ? `last seen ${new Date(k.last_seen_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' })}` : 'never connected'}
                  </span>
                </span>
                {k.active ? <button onClick={() => revoke(k)} className={GHOST}>Disconnect</button> : <Pill tone="muted">Disconnected</Pill>}
              </li>
            ))}
          </ul>
        )}

      {token && (
        <div className="rounded-2xl p-3 border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 space-y-2">
          <p className="text-xs font-bold text-emerald-800 dark:text-emerald-200">Put this token on the kiosk now. It will not be shown again.</p>
          <p className="font-mono text-xs font-bold text-ink-900 dark:text-white break-all select-all">{token}</p>
          <p className="text-2xs text-ink-600 dark:text-ink-300 break-all">Endpoint: {KIOSK_ENDPOINT} · header <span className="font-mono">x-device-token</span></p>
          <div className="flex gap-2">
            <button onClick={() => copy(token, 'Token')} className={GHOST}><Copy className="w-3.5 h-3.5" />Copy token</button>
            <button onClick={() => setToken(null)} className={GHOST}>Done</button>
          </div>
        </div>
      )}

      {adding ? (
        <div className="rounded-2xl p-3 bg-ink-50 dark:bg-ink-800/60 space-y-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name, e.g. Kitchen door" className={INPUT} />
          <select value={branch} onChange={e => setBranch(e.target.value)} className={INPUT}>
            {profiles.map(p => <option key={p.id} value={outletLabel(p)}>{outletLabel(p)}</option>)}
          </select>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setAdding(false)} className={GHOST}>Cancel</button>
            <button disabled={busy || !name.trim()} onClick={add} className={PRIMARY}>Register</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className={GHOST}><Plus className="w-3.5 h-3.5" />Register a kiosk</button>
      )}
    </section>
  );
}

function PublishCard({ db, profiles, companyId, payrollScope, triggerToast }: {
  db: DatabaseState; profiles: CompanyProfile[]; companyId: string; payrollScope: 'company' | 'branch'; triggerToast: Toast;
}) {
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const saved = db.payslips.filter(p => p.Is_Saved).length;
  const run = useCallback(async () => {
    setProgress([0, saved]);
    const failed = await publishAllPayslips(companyId, db, profiles, payrollScope === 'branch', (d, t) => setProgress([d, t]));
    setProgress(null);
    triggerToast(failed ? `${failed} of ${saved} payslips did not upload. Try again.` : `All ${saved} payslips are in the Staff app.`, failed ? 'warning' : 'success');
  }, [companyId, db, profiles, payrollScope, saved, triggerToast]);

  return (
    <section className={`${CARD} p-5 space-y-3`} aria-labelledby="publish">
      <h2 id="publish" className={LABEL}>Payslips in the Staff app</h2>
      <p className="text-sm text-ink-600 dark:text-ink-300">
        New payslips go to the Staff app when you save them. Payslips saved before that need publishing once.
      </p>
      <button onClick={run} disabled={!!progress || !saved} className={PRIMARY}>
        <FileUp className="w-3.5 h-3.5" />
        {progress ? `Publishing ${progress[0]} of ${progress[1]}…` : `Publish ${saved} saved payslip${saved === 1 ? '' : 's'}`}
      </button>
    </section>
  );
}

// ── Shifts ───────────────────────────────────────────────────────────────────

const WEEK: [number, string][] = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [7, 'Sunday']];

function ShiftsTab({ tick, people, triggerToast }: { tick: number; people: DatabaseState['employees']; triggerToast: Toast }) {
  const { data, error, reload } = useLoad(async () => {
    const [shifts, config] = await Promise.all([loadShifts(), loadConfig()]);
    return { shifts, rules: rulesOf(config) };
  }, [tick]);
  const [editing, setEditing] = useState<string | null>(null);

  if (error) return <ErrorNote message={error} />;
  if (!data) return <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>;
  const company = describeWeek(data.rules.work_days.map(d => ({ weekday: d, start: data.rules.day_start, end: data.rules.day_end, break: data.rules.break_minutes })));
  const person = people.find(p => p.Employee_ID === editing);

  return (
    <div className="space-y-4">
      <p className={`${CARD} p-4 text-sm text-ink-600 dark:text-ink-300`}>
        Each person's shift decides when they are late and how many days their leave takes.
        Anyone without their own shift works the default hours: <span className="font-semibold text-ink-900 dark:text-white">{company}</span>.
      </p>
      <section className={`${CARD} overflow-hidden`} aria-label="Shifts">
        {people.length === 0 ? <EmptyState compact icon={<CalendarClock />} title="No staff yet" body="Add employees in Payroll; then set their shifts here." />
          : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {people.map(p => {
                const week = data.shifts.get(p.Employee_ID) || [];
                return (
                  <li key={p.Employee_ID} className="flex items-center justify-between gap-3 px-5 py-3.5">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink-900 dark:text-white truncate">{p.Employee_Name}</span>
                      <span className="block text-xs text-ink-500 dark:text-ink-400">
                        {week.length ? describeWeek(week) : `Default hours · ${company}`}
                      </span>
                    </span>
                    <button onClick={() => setEditing(p.Employee_ID)} className={GHOST}>{week.length ? 'Edit' : 'Set shift'}</button>
                  </li>
                );
              })}
            </ul>
          )}
      </section>
      {editing && person && (
        <ShiftSheet name={person.Employee_Name} employeeId={editing} week={data.shifts.get(editing) || []}
          defaults={{ start: data.rules.day_start, end: data.rules.day_end, days: data.rules.work_days, break: data.rules.break_minutes }}
          triggerToast={triggerToast} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      )}
    </div>
  );
}

function ShiftSheet({ name, employeeId, week, defaults, triggerToast, onClose, onSaved }: {
  name: string; employeeId: string; week: ShiftDay[];
  defaults: { start: string; end: string; days: number[]; break: number };
  triggerToast: Toast; onClose: () => void; onSaved: () => void;
}) {
  // Start from their own week, or from the default hours if they have none.
  const [days, setDays] = useState<Record<number, ShiftDay | null>>(() => Object.fromEntries(WEEK.map(([n]) => {
    const own = week.find(d => d.weekday === n);
    if (week.length) return [n, own || null];
    return [n, defaults.days.includes(n) ? { weekday: n, start: defaults.start, end: defaults.end, break: defaults.break } : null];
  })));
  const [busy, setBusy] = useState(false);
  const set = (n: number, patch: Partial<ShiftDay> | null) =>
    setDays(d => ({ ...d, [n]: patch === null ? null : { ...(d[n] || { weekday: n, start: defaults.start, end: defaults.end, break: defaults.break }), ...patch } }));
  const first = WEEK.map(([n]) => days[n]).find(Boolean);
  const copyToAll = () => first && setDays(d => Object.fromEntries(WEEK.map(([n]) => [n, d[n] ? { ...first, weekday: n } : null])));

  const save = async (list: ShiftDay[], done: string) => {
    if (list.some(d => !d.start || !d.end)) { triggerToast('Fill in a start and end time for each working day.', 'warning'); return; }
    if (list.some(d => d.start === d.end)) { triggerToast('A shift cannot start and end at the same time.', 'warning'); return; }
    setBusy(true);
    try { await saveShift(employeeId, list); triggerToast(done, 'success'); onSaved(); }
    catch (e: any) { triggerToast(e.message, 'error'); }
    finally { setBusy(false); }
  };
  const chosen = WEEK.map(([n]) => days[n]).filter((d): d is ShiftDay => !!d);

  return (
    <Sheet title={`${name}'s shift`} subtitle="Malaysia time. An end time earlier than the start runs past midnight."
      icon={<CalendarClock className="w-4 h-4" />} onClose={onClose} maxWidth="md"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2 w-full">
          <button disabled={busy || !week.length} onClick={() => save([], `${name} is back on the default hours.`)} className={GHOST}>Use default hours</button>
          <button disabled={busy} onClick={() => save(chosen, `${name}'s shift saved.`)} className={PRIMARY}>{busy ? 'Saving…' : 'Save shift'}</button>
        </div>
      }>
      <div className="space-y-2">
        {WEEK.map(([n, label]) => {
          const d = days[n];
          return (
            <div key={n} className={`rounded-2xl px-3 py-2.5 ${d ? 'bg-ink-50 dark:bg-ink-800/60' : 'bg-transparent border border-dashed border-ink-200 dark:border-ink-700'}`}>
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm font-semibold text-ink-900 dark:text-white cursor-pointer">
                  <input type="checkbox" checked={!!d} onChange={e => set(n, e.target.checked ? {} : null)} className="w-4 h-4" />
                  {label}
                </label>
                {!d && <span className="text-xs text-ink-500 dark:text-ink-400">Day off</span>}
              </div>
              {d && (
                <div className="mt-2 grid grid-cols-[1fr_1fr_5.5rem] gap-2">
                  <label className="block min-w-0"><span className="sr-only">{label} start</span>
                    <input type="time" value={d.start} onChange={e => set(n, { start: e.target.value })} className={INPUT} /></label>
                  <label className="block min-w-0"><span className="sr-only">{label} end</span>
                    <input type="time" value={d.end} onChange={e => set(n, { end: e.target.value })} className={INPUT} /></label>
                  <label className="block min-w-0"><span className="sr-only">{label} break minutes</span>
                    <input type="number" min={0} step={5} value={d.break} onChange={e => set(n, { break: Number(e.target.value) })} className={INPUT} title="Break (min)" /></label>
                </div>
              )}
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-2xs text-ink-500 dark:text-ink-400">Start · End · Break (min)</span>
          <button type="button" disabled={!first} onClick={copyToAll} className={GHOST}>Same hours every working day</button>
        </div>
      </div>
    </Sheet>
  );
}
