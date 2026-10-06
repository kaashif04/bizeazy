# Master prompt — BizEazy Staff app

Paste everything below the line into a fresh coding session (Claude Code or
similar), opened on a new, empty repository for the staff app.

---

You are building **BizEazy Staff**, a phone-first web app for the staff and
managers of small Malaysian restaurants. It is a companion to an existing
product, **BizEazy Hub** (the owner's back office: invoices, quotations,
payroll), and to a fingerprint clock-in kiosk that is still being built. This is
a **prototype** tested by the owner and family: keep it simple, correct and
pleasant, and leave legal compliance (Employment Act, PDPA) for a later phase.

## 1. The one rule about the backend

The Staff app and the Hub share one Supabase project. **The Hub repository owns
the database**: every table, view, function, access policy and storage bucket is
created there, by its migrations. In this repo you must:

- **never** create, alter or drop tables, policies, functions or buckets, and
  never ship SQL migrations;
- use only the tables, views, RPCs and storage paths listed in section 4;
- if you need something that is not listed, **stop and write it down** in
  `docs/NEEDS_FROM_HUB.md` (what, why, and the exact shape you would want)
  instead of working around it.

Row-level security decides what each person can see. Do not re-implement access
control in the client; a hidden button is a courtesy, the policy is the control.

## 2. Users and roles

Everyone signs in with a **User ID and password** (no email). Supabase Auth
needs an email address, so the app maps a User ID to an internal address:

```ts
const loginEmail = (userId: string) => `${userId.trim().toLowerCase()}@users.bizeazy.invalid`;
```

`.invalid` is a reserved domain; no mail is ever sent. The Hub creates every
account; this app has **no sign-up** and **no password reset by email**. A user
who forgets their password asks their manager (the Hub resets it).

After sign-in, read the person's profile:

```ts
supabase.from('profiles')
  .select('display_id, full_name, role, modules, active, company_id, employee_id, companies ( name )')
  .eq('user_id', session.user.id).maybeSingle()
```

Two kinds of people use this app:

| Who | How you know | What they can do here |
|---|---|---|
| **Staff** | `role = 'staff'` and `employee_id` is set | Their own clock-ins, payslips and leave |
| **Manager** | `role = 'admin'`, or `'team'` is in `modules` | Everything staff can do for themselves (if they have an `employee_id`), plus who is on shift now, every staff member's attendance, and approving or rejecting leave |

Anyone else (no profile, `active = false`, or a member without `'team'` and
without `employee_id`) sees a polite "This app is for staff and managers. Use
BizEazy Hub." screen and a sign-out button.

Remember-me: offer "Keep me signed in on this device" (default on). On, the
Supabase session lives in `localStorage`; off, in `sessionStorage`. Do this with
a custom `storage` adapter passed to `createClient`.

## 3. Stack and setup

- React 19 + TypeScript + Vite + Tailwind CSS v4, `@supabase/supabase-js` v2,
  `lucide-react` for icons. No state library, no router library unless you can
  justify it in one sentence; a hash- or state-based view switch is enough.
- Installable PWA: `manifest.webmanifest` (name "BizEazy Staff", theme colour
  `#195C4B`, background `#FAF8F6`, 192 and 512 icons) and a small service
  worker that caches the app shell only. **Never cache API responses or
  payslip PDFs.**
- Environment:
  ```
  VITE_SUPABASE_URL=https://rtleeehglawquekygfoh.supabase.co
  VITE_SUPABASE_KEY=sb_publishable_THbbwo1H7tOpEf2sRxn0cg_zIUWROuC
  ```
  The key is a publishable key, safe in the browser by design. Never use or ask
  for the service-role key in this app.
- Deploy as its own Vercel project (e.g. `bizeazy-staff.vercel.app`).
- Timezone for everything shown: `Asia/Kuala_Lumpur`. Timestamps from the
  database are UTC (`timestamptz`); format with `Intl.DateTimeFormat('en-MY', { timeZone: 'Asia/Kuala_Lumpur', … })`.
  Money is RM with two decimals, in a monospace, tabular font.

## 4. The data contract (provided by the Hub)

All of these are scoped to the signed-in person's company by RLS. Column names
are exact.

### 4.1 `profiles` (read)
`user_id, company_id, display_id, full_name, role ('admin'|'member'|'staff'),
modules text[], active, employee_id text null`. Managers can read colleagues in
their company; staff read only themselves.

### 4.2 Employees — `records` (read)
Employee details live in the Hub's generic `records` table:
`company_id, kind, id, data jsonb, updated_at`.
- `kind = 'employees'`, `id = Employee_ID`, `data` holds `Employee_Name,
  Position, Branch_Location, Joining_Date, End_Date, Basic_Salary, …`.
- Staff can read **only their own** employee row. Managers can read all.
- Show only `Employee_Name, Position, Branch_Location, Joining_Date`. Do not
  display bank details, IC, salary or statutory fields anywhere in this app.

### 4.3 Payslips (read)
- Metadata: `records` with `kind = 'payslips'`; `data` has `Payslip_ID,
  Employee_ID, Month_Year` (e.g. "September 2026"), `Final_Net_Pay`,
  `Payment_Transferred`, `Transfer_Date`, `Is_Saved`. Staff see only their own,
  and only saved ones.
- The PDF is rendered by the Hub when the payslip is saved and stored at
  **`payslips/{company_id}/{employee_id}/{Payslip_ID}.pdf`** in the private
  Storage bucket `payslips`. Open it with
  `supabase.storage.from('payslips').createSignedUrl(path, 60)`.
  If the file is missing (older payslips), show "Ask your manager to re-save
  this payslip in the Hub" instead of an error. **Never render a payslip
  yourself** — one renderer, in the Hub, keeps the figures identical.

### 4.4 Attendance (read)
- **`attendance_events`** (raw, never edited):
  `id uuid, company_id, employee_id text, device_id uuid null,
  client_event_id text, event_type ('in'|'out'|'scan'), method
  ('fingerprint'|'face'|'manual'), occurred_at timestamptz, received_at
  timestamptz, clock_trusted boolean, note text, created_by uuid null`.
  `method = 'manual'` rows were added by a manager to fix a missed scan.
- **`attendance_voids`**: `event_id uuid, reason text, voided_by uuid,
  voided_at`. A voided event is ignored everywhere.
- **`attendance_days`** (view, read this for display): one row per employee per
  local date — `employee_id, work_date date, first_in timestamptz, last_out
  timestamptz null, worked_minutes int, scans int, open boolean, late boolean,
  has_manual boolean, untrusted_clock boolean`. Pairing rule (implemented in
  the view, do not re-implement): non-voided events of the day sorted by time,
  paired 1st–2nd, 3rd–4th…; `open` means an odd count (still on shift, or a
  missed clock-out). `late` compares `first_in` with the company's day start
  plus grace minutes.
- **`on_shift_now`** (view, managers): `employee_id, employee_name,
  branch, since timestamptz` — people whose latest event today is an open in.

### 4.5 Leave (read and write)
- **`leave_types`** (read): `id uuid, name, days_per_year numeric, paid
  boolean, active boolean`. Set up by the owner in the Hub.
- **`leave_balances`** (view, read): `employee_id, leave_type_id, year int,
  entitled numeric, taken numeric, pending numeric, remaining numeric`.
- **`leave_requests`** (read): `id uuid, employee_id, leave_type_id,
  start_date date, end_date date, half_day boolean, days numeric, reason text,
  status ('pending'|'approved'|'rejected'|'cancelled'), decided_by uuid null,
  decided_at timestamptz null, decision_note text, created_at`.
- Writes go through RPCs only, never direct `insert`/`update`:
  - `request_leave(p_leave_type_id uuid, p_start date, p_end date, p_half_day boolean, p_reason text) returns uuid`
    — staff, for themselves. The server computes `days` and refuses overlaps,
    end-before-start, half-day across several days, and requests beyond the
    remaining balance of an unpaid-limited type.
  - `cancel_leave(p_id uuid)` — the requester, while `pending` (or an approved
    request whose start date is still in the future).
  - `decide_leave(p_id uuid, p_approve boolean, p_note text)` — managers only.
  Show the server's error message to the user as-is; it is written for them.

### 4.6 Company rules (read)
`config` table, key `'settings'`, value JSON. Read
`value.attendance` for display only:
```json
{ "timezone": "Asia/Kuala_Lumpur", "work_days": [1,2,3,4,5,6],
  "day_start": "09:00", "day_end": "18:00", "grace_minutes": 10,
  "break_minutes": 60, "standard_hours_per_day": 8 }
```
The owner sets these in the Hub. This app never computes pay, overtime or
deductions — it shows hours; the Hub turns hours into money.

### 4.7 Live updates
Subscribe with Supabase Realtime to `attendance_events` (insert) and
`leave_requests` (insert, update) for the signed-in company, and refresh the
affected view. A manager sees someone clock in within seconds.

## 5. Screens

Phone first (360–430 px), bottom tab bar, large tap targets (≥ 44 px), works
one-handed. Tablet and desktop just centre a wider column.

**Sign in** — User ID, password (show/hide), keep me signed in, "Forgot your
password? Ask your manager to reset it." No sign-up link.

**Staff tabs: Today · Attendance · Payslips · Leave · Me**

1. **Today** — greeting with first name; today's status card: "Clocked in at
   8:52 · 3 h 14 m so far" (live counter) / "Not clocked in yet" / "Clocked out
   at 18:04 · 8 h 12 m"; late badge if `late`; this week's total hours; the
   next approved leave; any pending leave request.
2. **Attendance** — month picker (current month default); one row per day from
   `attendance_days`: date, in, out, hours, badges (Late, Missed clock-out,
   Corrected by manager, Kiosk clock was wrong). Month totals at the top
   (days worked, hours). Days with no record that are work days show as
   "Absent" only if they are in the past and not on approved leave.
3. **Payslips** — list newest first by month: month, net pay, Paid on date /
   Payment pending; tap → open the PDF (signed URL) with Download and Share
   (Web Share API where available).
4. **Leave** — balances per type (remaining of entitled), "Request leave"
   button → sheet: type, start, end, half day (only if one day), reason →
   `request_leave`. Below: my requests with status chips; pending ones can be
   cancelled.
5. **Me** — name, position, branch, joining date; change password (current +
   new + confirm, min 8 chars: re-authenticate with the current password via
   `signInWithPassword`, then `auth.updateUser`); dark mode toggle; sign out.

**Manager tabs (added before Me): Team · Approvals**

6. **Team** — "On shift now" list from `on_shift_now` (name, branch, since,
   live duration); below, today's attendance for everyone from
   `attendance_days` with filters by branch; tap a person → their Attendance
   month view (same component as staff).
7. **Approvals** — pending leave requests, oldest first: who, type, dates, days,
   reason, their remaining balance; Approve / Reject (optional note) →
   `decide_leave`. A "Decided" tab lists recent decisions.

A manager who is also an employee (has `employee_id`) sees both sets of tabs.

## 6. Design

Match the Hub so the two feel like one product:
- Font **Archivo** (UI) and **JetBrains Mono** (money, times, IDs), from Google
  Fonts.
- Colour tokens: copy the `@theme` block from the Hub's `src/index.css`
  (warm `ink` neutrals, pine `brand`: `brand-600 #195C4B`, saffron for
  warnings, clay for danger). Light and dark mode, dark via a `.dark` class on
  `<html>`, explicit `dark:` classes on every coloured element, **never
  `!important`**.
- Body text ≥ 14 px; secondary text uses `ink-500` (light) / `ink-400` (dark)
  for contrast; status is never shown by colour alone (always a word or icon).
- Loading: skeletons on first load, never a blank screen or a misleading empty
  state; empty states say what to do next.
- Respect `prefers-reduced-motion`; honour safe-area insets on iOS.

## 7. Behaviour rules

- Every screen works on a slow phone connection: show cached data with an
  "Updating…" hint rather than blocking.
- Offline: the shell opens; show "You're offline — showing what was loaded
  last" and disable actions that need the server.
- Errors are sentences a cook can act on ("Couldn't reach the server. Check
  your connection and try again."), never codes or stack traces.
- Time display is always Malaysia time, 12-hour with am/pm on phone
  ("8:52 am"), durations as "8 h 12 m".
- Never show another person's data to staff, even if a query returns it by
  mistake: filter by the signed-in `employee_id` as a second line of defence
  (RLS is the first).

## 8. Quality bar

- TypeScript strict; `npm run build` and `tsc --noEmit` clean.
- Put date/time logic (Malaysia formatting, durations, month ranges, "Absent"
  rule) in pure functions with one runnable check:
  `src/time.selfcheck.ts` (`npx tsx src/time.selfcheck.ts`, assert-based, no
  framework) covering month boundaries, midnight, and a shift crossing midnight.
- Check every screen at 375 px and 1280 px, light and dark, before calling it
  done.
- README: what the app is, env vars, how to run, the role table, and a pointer
  to the Hub repo as the owner of the database.

## 9. Build order

1. Sign in, profile gate, role detection, app shell with tabs, Me (incl. change
   password and sign out).
2. Payslips (read + signed-URL PDF).
3. Attendance (month view from `attendance_days`) and Today.
4. Leave: balances, request, cancel.
5. Manager: Team (on shift now) and Approvals.
6. Realtime refresh, PWA install, offline shell.

Until the Hub ships a table or RPC from section 4, build the screen against
realistic sample data behind a single `USE_SAMPLE_DATA` flag, and list the
missing piece in `docs/NEEDS_FROM_HUB.md`. Remove the flag once it is live.

## 10. Out of scope (do not build)

Clocking in from the phone, editing attendance, computing pay or overtime,
registering kiosks, enrolling fingerprints, creating accounts, company
settings, invoices or quotations. Those belong to the Hub or the kiosk.
