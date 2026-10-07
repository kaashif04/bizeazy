/**
 * Time helpers for the Team view: `npx tsx src/team.selfcheck.ts`
 * The database pairs scans into days; these only have to agree with it on
 * which day a moment belongs to, and show Malaysia time.
 */
import { clock, duration, workDate, monthRange, mytToIso, workDayBounds, rulesOf } from './team';

const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(`SELF-CHECK FAILED: ${msg}`); };

ok(clock('2026-09-02T00:52:00Z') === '8:52 am', `UTC 00:52 is 8:52 am in Malaysia, got ${clock('2026-09-02T00:52:00Z')}`);
ok(clock('2026-09-02T10:05:00Z') === '6:05 pm', `UTC 10:05 is 6:05 pm, got ${clock('2026-09-02T10:05:00Z')}`);
ok(clock(null) === '—', 'no time shows a dash');

ok(duration(492) === '8 h 12 m' && duration(45) === '45 m' && duration(60) === '1 h 0 m' && duration(-5) === '0 m', 'durations');

// The working day turns over at 4 am Malaysia time, like public.work_date().
ok(workDate(new Date('2026-09-01T17:30:00Z')) === '2026-09-01', '01:30 am on the 2nd still belongs to the 1st');
ok(workDate(new Date('2026-09-01T20:00:00Z')) === '2026-09-02', '04:00 am on the 2nd starts the 2nd');
ok(workDate(new Date('2026-09-01T16:30:00Z')) === '2026-09-01', '00:30 am Malaysia is still the 1st');

ok(monthRange('2026-02').join() === '2026-02-01,2026-02-28', 'February 2026 has 28 days');
ok(monthRange('2028-02')[1] === '2028-02-29', 'February 2028 has 29');
ok(monthRange('2026-12')[1] === '2026-12-31', 'December ends on the 31st');

ok(mytToIso('2026-09-03', '18:00') === '2026-09-03T10:00:00.000Z', '18:00 Malaysia is 10:00 UTC');
const [from, to] = workDayBounds('2026-09-01');
ok(from === '2026-08-31T20:00:00.000Z' && to === '2026-09-01T20:00:00.000Z', 'a working day runs 4 am to 4 am');

ok(rulesOf({}).day_start === '09:00' && rulesOf({ settings: { attendance: { grace_minutes: 5 } } }).grace_minutes === 5,
   'rules fall back to defaults and keep what was set');

console.log('All team time self-checks passed.');
