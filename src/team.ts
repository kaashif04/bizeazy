/**
 * team.ts — attendance, leave and kiosks for the Hub's Team view.
 *
 * Reads the views and calls the functions in
 * supabase/migrations/20261008000000_staff_attendance_leave.sql. Pairing scans
 * into days, leave arithmetic and every access rule live in the database; this
 * file only fetches, formats and forwards. Times are shown in Malaysia time.
 */
import { supabase } from './supabase';

export const TZ = 'Asia/Kuala_Lumpur';
const MYT_OFFSET_MS = 8 * 3600_000;   // Malaysia has no daylight saving

// ── Pure helpers (checked in team.selfcheck.ts) ──────────────────────────────

/** "8:52 am" in Malaysia time. */
export const clock = (iso: string | null | undefined): string => !iso ? '—'
  : new Intl.DateTimeFormat('en-MY', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true })
      .format(new Date(iso)).replace(/\s?(AM|PM)$/i, (_, m) => ` ${m.toLowerCase()}`);

/** 492 → "8 h 12 m"; 45 → "45 m". */
export const duration = (minutes: number): string => {
  const m = Math.max(0, Math.floor(minutes));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m} m`;
};

/** The working day a moment belongs to: Malaysia date, turning over at 4 am (as the database does). */
export const workDate = (at: Date = new Date()): string =>
  new Date(at.getTime() + MYT_OFFSET_MS - 4 * 3600_000).toISOString().slice(0, 10);

/** '2026-09' → ['2026-09-01', '2026-09-30']. */
export function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
}

/** A date and wall-clock time typed in Malaysia → ISO instant. */
export const mytToIso = (date: string, time: string): string =>
  new Date(`${date}T${time}:00+08:00`).toISOString();

/** The instants a working day spans: 04:00 that day to 04:00 the next, Malaysia time. */
export function workDayBounds(date: string): [string, string] {
  const start = new Date(`${date}T04:00:00+08:00`);
  return [start.toISOString(), new Date(start.getTime() + 86400_000).toISOString()];
}

/** "Mon 2 Sep". */
export const dayLabel = (date: string): string =>
  new Date(`${date}T12:00:00+08:00`).toLocaleDateString('en-MY', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

// ── Types ────────────────────────────────────────────────────────────────────

export interface AttendanceDay {
  employee_id: string; work_date: string; first_in: string; last_in: string; last_out: string | null;
  worked_minutes: number; scans: number; open: boolean; late: boolean; has_manual: boolean; untrusted_clock: boolean;
  scheduled: boolean; shift_start: string | null; shift_end: string | null;
}
/** One weekday of a person's shift. weekday is ISO: 1 = Monday … 7 = Sunday. */
export interface ShiftDay { weekday: number; start: string; end: string; break: number }
export type Shifts = Map<string, ShiftDay[]>;   // employee_id → their week; absent = company hours
export interface OnShift { employee_id: string; employee_name: string; branch: string; since: string }
export interface ScanEvent {
  id: string; employee_id: string; occurred_at: string; method: 'fingerprint' | 'face' | 'manual';
  note: string; clock_trusted: boolean; voided?: { reason: string } | null;
}
export interface LeaveType { id: string; name: string; days_per_year: number; paid: boolean; active: boolean }
export interface LeaveRequest {
  id: string; employee_id: string; leave_type_id: string; start_date: string; end_date: string;
  half_day: boolean; days: number; reason: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decided_at: string | null; decision_note: string; created_at: string;
}
export interface LeaveBalance { employee_id: string; leave_type_id: string; entitled: number; taken: number; pending: number; remaining: number | null }
export interface Kiosk { id: string; name: string; branch: string; active: boolean; last_seen_at: string | null; created_at: string }

export interface AttendanceRules {
  day_start: string; day_end: string; grace_minutes: number; break_minutes: number;
  standard_hours_per_day: number; work_days: number[]; timezone: string;
}
export const DEFAULT_RULES: AttendanceRules = {
  timezone: TZ, work_days: [1, 2, 3, 4, 5, 6], day_start: '09:00', day_end: '18:00',
  grace_minutes: 10, break_minutes: 60, standard_hours_per_day: 8,
};
export const rulesOf = (config: Record<string, any>): AttendanceRules =>
  ({ ...DEFAULT_RULES, ...(config?.settings?.attendance || {}) });

/** ISO weekday of a 'YYYY-MM-DD' date: 1 = Monday … 7 = Sunday. */
export const isoWeekday = (date: string): number => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

/**
 * A person's hours on a date, as the database decides it (public.shift_on):
 * their own shift if they have one, else the company's hours. null = day off.
 */
export function shiftFor(employeeId: string, date: string, shifts: Shifts, rules: AttendanceRules): { start: string; end: string } | null {
  const own = shifts.get(employeeId);
  const wd = isoWeekday(date);
  if (own?.length) {
    const d = own.find(x => x.weekday === wd);
    return d ? { start: d.start, end: d.end } : null;
  }
  return rules.work_days.includes(wd) ? { start: rules.day_start, end: rules.day_end } : null;
}

/** '09:00' → '9:00 am'. */
export const hhmm = (t: string | null | undefined): string => {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** "Mon–Fri 10:00 am – 7:00 pm · Sat 10:00 pm – 2:00 am"; consecutive days with the same hours run together. */
export function describeWeek(week: ShiftDay[]): string {
  if (!week.length) return 'Company hours';
  const sorted = [...week].sort((a, b) => a.weekday - b.weekday);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].weekday === sorted[j].weekday + 1
      && sorted[j + 1].start === sorted[i].start && sorted[j + 1].end === sorted[i].end) j++;
    const days = i === j ? DAY_NAMES[sorted[i].weekday - 1] : `${DAY_NAMES[sorted[i].weekday - 1]}–${DAY_NAMES[sorted[j].weekday - 1]}`;
    parts.push(`${days} ${hhmm(sorted[i].start)} – ${hhmm(sorted[i].end)}`);
    i = j + 1;
  }
  return parts.join(' · ');
}

// ── Reads and writes ─────────────────────────────────────────────────────────

/** Database errors in words a person can act on. */
function plain(error: { message?: string; code?: string } | null): Error {
  const msg = error?.message || 'Something went wrong.';
  if (/relation .* does not exist|Could not find the (table|function)/i.test(msg)) {
    return new Error('The database has not been updated for Team yet. Run the staff & attendance SQL in Supabase.');
  }
  if (/fetch|network/i.test(msg)) return new Error('Could not reach the server. Check your connection and try again.');
  return new Error(msg);
}
async function rows<T>(q: PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw plain(error);
  return data || [];
}
async function call(fn: string, args: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw plain(error);
  return data;
}

export const onShiftNow = () =>
  rows<OnShift>(supabase.from('on_shift_now').select('employee_id, employee_name, branch, since').order('since'));

export const daysBetween = (from: string, to: string, employeeId?: string) => {
  let q = supabase.from('attendance_days').select('*').gte('work_date', from).lte('work_date', to);
  if (employeeId) q = q.eq('employee_id', employeeId);
  return rows<AttendanceDay>(q.order('work_date'));
};

/** Every scan of one working day, voided ones included and marked. */
export async function scansOn(employeeId: string, date: string): Promise<ScanEvent[]> {
  const [from, to] = workDayBounds(date);
  const events = await rows<ScanEvent>(supabase.from('attendance_events')
    .select('id, employee_id, occurred_at, method, note, clock_trusted')
    .eq('employee_id', employeeId).gte('occurred_at', from).lt('occurred_at', to).order('occurred_at'));
  if (!events.length) return events;
  const voids = await rows<{ event_id: string; reason: string }>(
    supabase.from('attendance_voids').select('event_id, reason').in('event_id', events.map(e => e.id)));
  const byId = new Map(voids.map(v => [v.event_id, v]));
  return events.map(e => ({ ...e, voided: byId.get(e.id) || null }));
}

export async function loadShifts(): Promise<Shifts> {
  const list = await rows<{ employee_id: string; weekday: number; start_time: string; end_time: string; break_minutes: number }>(
    supabase.from('employee_shifts').select('employee_id, weekday, start_time, end_time, break_minutes'));
  const out: Shifts = new Map();
  for (const r of list) {
    const week = out.get(r.employee_id) || [];
    week.push({ weekday: r.weekday, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5), break: r.break_minutes });
    out.set(r.employee_id, week);
  }
  return out;
}
export const saveShift = (employeeId: string, week: ShiftDay[]) =>
  call('set_shift', { p_employee_id: employeeId, p_days: week });

export const addMissedScan = (employeeId: string, iso: string, note: string) =>
  call('add_manual_event', { p_employee_id: employeeId, p_occurred_at: iso, p_note: note });
export const removeScan = (eventId: string, reason: string) =>
  call('void_event', { p_event_id: eventId, p_reason: reason });

export const leaveTypes = () =>
  rows<LeaveType>(supabase.from('leave_types').select('id, name, days_per_year, paid, active').order('name'));
export async function saveLeaveType(t: Partial<LeaveType> & { name: string }, companyId: string): Promise<void> {
  const row = { company_id: companyId, name: t.name.trim(), days_per_year: Number(t.days_per_year) || 0,
    paid: t.paid ?? true, active: t.active ?? true };
  const { error } = t.id
    ? await supabase.from('leave_types').update(row).eq('id', t.id)
    : await supabase.from('leave_types').insert(row);
  if (error) throw plain(/duplicate/i.test(error.message) ? { message: `There is already a leave type called "${row.name}".` } : error);
}

export const leaveRequests = () =>
  rows<LeaveRequest>(supabase.from('leave_requests').select('*').order('created_at', { ascending: false }).limit(200));
export const leaveBalances = () =>
  rows<LeaveBalance>(supabase.from('leave_balances').select('employee_id, leave_type_id, entitled, taken, pending, remaining'));
export const decideLeave = (id: string, approve: boolean, note: string) =>
  call('decide_leave', { p_id: id, p_approve: approve, p_note: note });

// Kiosks are registered through the kiosk edge function: their tokens never touch the browser's tables.
async function kiosk(action: string, body: Record<string, unknown> = {}): Promise<any> {
  const { data, error } = await supabase.functions.invoke('kiosk', { body: { action, ...body } });
  if (error) throw new Error('Could not reach the kiosk service. It may not be deployed yet.');
  if (data?.success) return data.data;
  throw new Error(String(data?.error || 'The server rejected that request.'));
}
export const listKiosks = (): Promise<Kiosk[]> => kiosk('listDevices');
export const registerKiosk = (name: string, branch: string): Promise<Kiosk & { token: string }> =>
  kiosk('registerDevice', { name, branch });
export const revokeKiosk = (id: string) => kiosk('revokeDevice', { id });
export const KIOSK_ENDPOINT = `${(import.meta as any).env?.VITE_SUPABASE_URL || 'https://rtleeehglawquekygfoh.supabase.co'}/functions/v1/kiosk`;

/** Live refresh: any new scan or leave change in the company calls back. */
export function watchTeam(onChange: () => void): () => void {
  const channel = supabase.channel('team-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'attendance_events' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_requests' }, onChange)
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}
