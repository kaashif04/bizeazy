-- Staff, attendance and leave: what the BizEazy Staff app and the clock-in
-- kiosk read and write. The Hub owns this schema; the Staff app ships no SQL.
-- The contract is docs/staff-app-master-prompt.md, section 4.

-- ── Staff logins ───────────────────────────────────────────────
-- A staff login belongs to one employee record and opens only the Staff app.
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'member', 'staff'));
alter table public.profiles add column employee_id text;
alter table public.profiles add constraint profiles_staff_have_an_employee
  check (role <> 'staff' or employee_id is not null);
create unique index profiles_one_login_per_employee
  on public.profiles (company_id, employee_id) where employee_id is not null;

create function public.current_employee() returns text
language sql stable security definer set search_path = '' as $$
  select employee_id from public.profiles
  where user_id = (select auth.uid()) and active
$$;

create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select role = 'staff' from public.profiles
                   where user_id = (select auth.uid()) and active), false)
$$;

-- Staff hold no Hub module, not even the shared customer list. 'team' is the
-- manager module: attendance, leave and kiosks.
create or replace function public.has_module(m text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid()) and p.active and p.role <> 'staff'
      and (p.role = 'admin' or m is null or m = any (p.modules))
  )
$$;

drop policy "members see their colleagues" on public.profiles;
create policy "members see colleagues, staff see themselves" on public.profiles
  for select to authenticated
  using (company_id = (select public.current_company())
         and (user_id = (select auth.uid()) or not (select public.is_staff())));

-- A person's own employee row and saved payslips; managers read every employee.
create policy "staff read their own record and saved payslips" on public.records
  for select to authenticated
  using (company_id = (select public.current_company()) and (
    (kind = 'employees' and (id = (select public.current_employee()) or (select public.has_module('team'))))
    or (kind = 'payslips'
        and data->>'Employee_ID' = (select public.current_employee())
        and lower(coalesce(data->>'Is_Saved', '')) = 'true')
  ));

-- ── Attendance ─────────────────────────────────────────────────
-- Kiosks authenticate with a token shown once at registration; only its hash
-- is kept. Registered and revoked through the kiosk edge function.
create table public.attendance_devices (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  branch       text not null default '',
  token_hash   text not null unique,
  active       boolean not null default true,
  last_seen_at timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now()
);

-- Raw scans, never edited. A wrong one is voided; a missed one is added by a
-- manager as method 'manual'. client_event_id makes a kiosk's retries harmless.
create table public.attendance_events (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  employee_id     text not null,
  device_id       uuid references public.attendance_devices(id) on delete set null,
  client_event_id text not null default gen_random_uuid()::text,
  event_type      text not null default 'scan' check (event_type in ('in', 'out', 'scan')),
  method          text not null check (method in ('fingerprint', 'face', 'manual')),
  occurred_at     timestamptz not null,
  received_at     timestamptz not null default now(),
  clock_trusted   boolean not null default true,
  note            text not null default '',
  created_by      uuid,
  unique (company_id, device_id, client_event_id)
);
create index attendance_events_day_idx on public.attendance_events (company_id, employee_id, occurred_at);

create table public.attendance_voids (
  event_id   uuid primary key references public.attendance_events(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  reason     text not null check (length(trim(reason)) > 0),
  voided_by  uuid,
  voided_at  timestamptz not null default now()
);

-- The day a scan belongs to, in Malaysia time. The day turns over at 4 am, not
-- midnight, so a late shift (in 22:00, out 01:30) stays one working day.
-- ponytail: fixed zone and cut-off; read them from settings if a branch ever
-- runs outside Malaysia or past 4 am.
create function public.work_date(t timestamptz) returns date
language sql stable set search_path = '' as $$
  select ((t at time zone 'Asia/Kuala_Lumpur') - interval '4 hours')::date
$$;

alter table public.attendance_devices enable row level security;
alter table public.attendance_events  enable row level security;
alter table public.attendance_voids   enable row level security;

create policy "managers see the kiosks" on public.attendance_devices
  for select to authenticated
  using (company_id = (select public.current_company()) and (select public.has_module('team')));

-- No write policies: kiosks write through the kiosk function, managers through
-- add_manual_event and void_event below.
create policy "managers and payroll see every scan, staff their own" on public.attendance_events
  for select to authenticated
  using (company_id = (select public.current_company()) and (
    (select public.has_module('team')) or (select public.has_module('payroll'))
    or employee_id = (select public.current_employee())));

create policy "voids follow the scans" on public.attendance_voids
  for select to authenticated
  using (company_id = (select public.current_company()) and exists (
    select 1 from public.attendance_events e where e.id = event_id));

-- One row per person per working day. Scans that are not voided are taken in
-- time order and paired 1st-2nd, 3rd-4th…; an odd count leaves the day open.
create view public.attendance_days with (security_invoker = true) as
with ev as (
  select e.company_id, e.employee_id, e.occurred_at, e.method, e.clock_trusted,
         public.work_date(e.occurred_at) as work_date
  from public.attendance_events e
  where not exists (select 1 from public.attendance_voids v where v.event_id = e.id)
),
numbered as (
  select ev.*, row_number() over (
    partition by company_id, employee_id, work_date order by occurred_at) as n
  from ev
),
pairs as (
  select company_id, employee_id, work_date,
         min(occurred_at) as t_in,
         case when count(*) = 2 then max(occurred_at) end as t_out
  from numbered
  group by company_id, employee_id, work_date, (n + 1) / 2
),
days as (
  select company_id, employee_id, work_date,
         min(t_in) as first_in, max(t_in) as last_in, max(t_out) as last_out,
         coalesce(sum(extract(epoch from t_out - t_in)), 0) as seconds,
         bool_or(t_out is null) as open
  from pairs
  group by company_id, employee_id, work_date
),
flags as (
  select company_id, employee_id, work_date, count(*) as scans,
         bool_or(method = 'manual') as has_manual, bool_or(not clock_trusted) as untrusted
  from ev
  group by company_id, employee_id, work_date
),
rules as (
  select company_id,
         coalesce(value->'attendance'->>'day_start', '09:00')::time as day_start,
         coalesce((value->'attendance'->>'grace_minutes')::int, 10) as grace
  from public.config where key = 'settings'
)
select d.company_id, d.employee_id, d.work_date, d.first_in, d.last_in,
       case when d.open then null else d.last_out end as last_out,
       floor(d.seconds / 60)::int as worked_minutes,
       f.scans::int as scans, d.open,
       (d.first_in at time zone 'Asia/Kuala_Lumpur')::time
         > coalesce(r.day_start, '09:00'::time) + make_interval(mins => coalesce(r.grace, 10)) as late,
       f.has_manual, f.untrusted as untrusted_clock
from days d
join flags f using (company_id, employee_id, work_date)
left join rules r on r.company_id = d.company_id;

create view public.on_shift_now with (security_invoker = true) as
select d.company_id, d.employee_id,
       coalesce(nullif(r.data->>'Employee_Name', ''), d.employee_id) as employee_name,
       coalesce(nullif(r.data->>'Branch_Location', ''), '') as branch,
       d.last_in as since
from public.attendance_days d
left join public.records r
  on r.company_id = d.company_id and r.kind = 'employees' and r.id = d.employee_id
where d.open and d.work_date = public.work_date(now());

-- A missed scan, added by a manager. It shows as "Corrected by manager".
create function public.add_manual_event(p_employee_id text, p_occurred_at timestamptz, p_note text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company();
  v_id uuid;
begin
  if v_company is null or not public.has_module('team') then
    raise exception 'Only managers can correct attendance.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.records
                 where company_id = v_company and kind = 'employees' and id = p_employee_id) then
    raise exception 'That employee is not in this company.';
  end if;
  if p_occurred_at is null or p_occurred_at > now() + interval '5 minutes' then
    raise exception 'Choose a time that has already happened.';
  end if;
  insert into public.attendance_events (company_id, employee_id, method, occurred_at, note, created_by)
  values (v_company, p_employee_id, 'manual', p_occurred_at, coalesce(trim(p_note), ''), auth.uid())
  returning id into v_id;
  return v_id;
end
$$;

create function public.void_event(p_event_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company();
begin
  if v_company is null or not public.has_module('team') then
    raise exception 'Only managers can correct attendance.' using errcode = '42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Say why this scan is being removed.';
  end if;
  if not exists (select 1 from public.attendance_events where id = p_event_id and company_id = v_company) then
    raise exception 'That scan was not found.';
  end if;
  insert into public.attendance_voids (event_id, company_id, reason, voided_by)
  values (p_event_id, v_company, trim(p_reason), auth.uid())
  on conflict (event_id) do nothing;
end
$$;

-- ── Leave ──────────────────────────────────────────────────────
create table public.leave_types (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  days_per_year numeric not null default 0 check (days_per_year >= 0),   -- 0 = no yearly limit
  paid          boolean not null default true,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (company_id, name)
);

create table public.leave_requests (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   text not null,
  leave_type_id uuid not null references public.leave_types(id),
  start_date    date not null,
  end_date      date not null,
  half_day      boolean not null default false,
  days          numeric not null check (days > 0),
  reason        text not null default '',
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text not null default '',
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  check (end_date >= start_date),
  check (not half_day or start_date = end_date)
);
create index leave_requests_person_idx on public.leave_requests (company_id, employee_id, start_date);

alter table public.leave_types    enable row level security;
alter table public.leave_requests enable row level security;

create policy "everyone reads the leave types" on public.leave_types
  for select to authenticated using (company_id = (select public.current_company()));
create policy "managers set up leave types" on public.leave_types
  for all to authenticated
  using      (company_id = (select public.current_company()) and (select public.has_module('team')))
  with check (company_id = (select public.current_company()) and (select public.has_module('team')));

-- Writes go through request_leave, cancel_leave and decide_leave only.
create policy "managers see all leave, staff their own" on public.leave_requests
  for select to authenticated
  using (company_id = (select public.current_company()) and (
    (select public.has_module('team')) or employee_id = (select public.current_employee())));

-- Working days in a range, by the company's work days (ISO: 1 = Monday).
-- ponytail: public holidays are not excluded; add a holidays table when wanted.
create function public.leave_days(p_company uuid, p_start date, p_end date, p_half boolean)
returns numeric language sql stable security definer set search_path = '' as $$
  with work as (
    select count(*) as n
    from generate_series(p_start, p_end, interval '1 day') as g(d)
    where extract(isodow from g.d)::int in (
      select jsonb_array_elements_text(coalesce(
        (select value->'attendance'->'work_days' from public.config
         where company_id = p_company and key = 'settings'),
        '[1,2,3,4,5,6]'::jsonb))::int)
  )
  select case when p_half then least(n, 1) * 0.5 else n end from work
$$;

-- This year's balance per person and leave type. remaining is null for a type
-- with no yearly limit. Leave counts against the year it starts in.
create view public.leave_balances with (security_invoker = true) as
select e.company_id, e.id as employee_id, t.id as leave_type_id, y.year,
       t.days_per_year as entitled,
       coalesce(sum(r.days) filter (where r.status = 'approved'), 0) as taken,
       coalesce(sum(r.days) filter (where r.status = 'pending'), 0) as pending,
       case when t.days_per_year > 0 then
         t.days_per_year - coalesce(sum(r.days) filter (where r.status in ('approved', 'pending')), 0)
       end as remaining
from public.records e
join public.leave_types t on t.company_id = e.company_id and t.active
cross join (select extract(year from now() at time zone 'Asia/Kuala_Lumpur')::int as year) y
left join public.leave_requests r
  on r.company_id = e.company_id and r.employee_id = e.id and r.leave_type_id = t.id
 and extract(year from r.start_date)::int = y.year
where e.kind = 'employees'
group by e.company_id, e.id, t.id, t.days_per_year, y.year;

create function public.request_leave(p_leave_type_id uuid, p_start date, p_end date,
                                     p_half_day boolean, p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_company uuid := public.current_company();
  v_emp     text := public.current_employee();
  v_half    boolean := coalesce(p_half_day, false);
  v_type    public.leave_types;
  v_days    numeric;
  v_used    numeric;
  v_id      uuid;
begin
  if v_company is null or v_emp is null then
    raise exception 'Only staff linked to an employee record can request leave.' using errcode = '42501';
  end if;
  select * into v_type from public.leave_types
  where id = p_leave_type_id and company_id = v_company and active;
  if not found then raise exception 'That leave type is not available.'; end if;
  if p_start is null or p_end is null then raise exception 'Choose a start and an end date.'; end if;
  if p_end < p_start then raise exception 'The end date is before the start date.'; end if;
  if v_half and p_end <> p_start then
    raise exception 'A half day must start and end on the same date.';
  end if;

  v_days := public.leave_days(v_company, p_start, p_end, v_half);
  if v_days <= 0 then raise exception 'Those dates have no working days.'; end if;

  if exists (select 1 from public.leave_requests
             where company_id = v_company and employee_id = v_emp
               and status in ('pending', 'approved')
               and daterange(start_date, end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'You already have leave on some of those dates.';
  end if;

  if v_type.days_per_year > 0 then
    select coalesce(sum(days), 0) into v_used from public.leave_requests
    where company_id = v_company and employee_id = v_emp and leave_type_id = v_type.id
      and status in ('pending', 'approved')
      and extract(year from start_date) = extract(year from p_start);
    if v_used + v_days > v_type.days_per_year then
      raise exception 'Not enough % left: % of % days remaining.',
        v_type.name, trim_scale(v_type.days_per_year - v_used), trim_scale(v_type.days_per_year);
    end if;
  end if;

  insert into public.leave_requests
    (company_id, employee_id, leave_type_id, start_date, end_date, half_day, days, reason)
  values (v_company, v_emp, v_type.id, p_start, p_end, v_half, v_days, coalesce(trim(p_reason), ''))
  returning id into v_id;
  return v_id;
end
$$;

-- The requester cancels while it is pending, or approved and not yet started.
create function public.cancel_leave(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.leave_requests set status = 'cancelled'
  where id = p_id and company_id = public.current_company()
    and employee_id = public.current_employee()
    and (status = 'pending'
         or (status = 'approved' and start_date > (now() at time zone 'Asia/Kuala_Lumpur')::date));
  if not found then raise exception 'This request can no longer be cancelled.'; end if;
end
$$;

create function public.decide_leave(p_id uuid, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_req public.leave_requests;
begin
  if public.current_company() is null or not public.has_module('team') then
    raise exception 'Only managers can approve or reject leave.' using errcode = '42501';
  end if;
  select * into v_req from public.leave_requests
  where id = p_id and company_id = public.current_company() for update;
  if not found then raise exception 'That leave request was not found.'; end if;
  if v_req.status <> 'pending' then
    raise exception 'This request has already been %.', v_req.status;
  end if;
  -- An admin may decide their own (the owner has no one above them); a manager may not.
  if v_req.employee_id = public.current_employee() and not exists (
       select 1 from public.profiles where user_id = auth.uid() and role = 'admin') then
    raise exception 'Ask another manager to decide your own leave.';
  end if;
  update public.leave_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_by = auth.uid(), decided_at = now(), decision_note = coalesce(trim(p_note), '')
  where id = p_id;
end
$$;

-- ── Function access ────────────────────────────────────────────
revoke execute on function public.current_employee()  from anon, public;
revoke execute on function public.is_staff()          from anon, public;
revoke execute on function public.work_date(timestamptz) from anon, public;
revoke execute on function public.add_manual_event(text, timestamptz, text) from anon, public;
revoke execute on function public.void_event(uuid, text) from anon, public;
revoke execute on function public.leave_days(uuid, date, date, boolean) from anon, public;
revoke execute on function public.request_leave(uuid, date, date, boolean, text) from anon, public;
revoke execute on function public.cancel_leave(uuid) from anon, public;
revoke execute on function public.decide_leave(uuid, boolean, text) from anon, public;
grant execute on function public.current_employee()  to authenticated;
grant execute on function public.is_staff()          to authenticated;
grant execute on function public.work_date(timestamptz) to authenticated;
grant execute on function public.add_manual_event(text, timestamptz, text) to authenticated;
grant execute on function public.void_event(uuid, text) to authenticated;
grant execute on function public.leave_days(uuid, date, date, boolean) to authenticated;
grant execute on function public.request_leave(uuid, date, date, boolean, text) to authenticated;
grant execute on function public.cancel_leave(uuid) to authenticated;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;

-- ── Live updates ───────────────────────────────────────────────
-- Realtime delivers a change only to people whose policies let them read it.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.attendance_events, public.leave_requests;
  end if;
end
$$;

-- ── Payslip PDFs ───────────────────────────────────────────────
-- payslips/{company_id}/{employee_id}/{Payslip_ID}.pdf, written by the Hub
-- when a payslip is saved. Payroll reads and writes them; staff read their own.
insert into storage.buckets (id, name, public) values ('payslips', 'payslips', false)
on conflict (id) do nothing;

create policy "payslip PDFs: payroll and the employee read" on storage.objects
  for select to authenticated
  using (bucket_id = 'payslips'
         and (storage.foldername(name))[1] = (select public.current_company())::text
         and ((select public.has_module('payroll'))
              or (storage.foldername(name))[2] = (select public.current_employee())));
create policy "payslip PDFs: payroll uploads" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'payslips'
              and (storage.foldername(name))[1] = (select public.current_company())::text
              and (select public.has_module('payroll')));
create policy "payslip PDFs: payroll replaces" on storage.objects
  for update to authenticated
  using      (bucket_id = 'payslips'
              and (storage.foldername(name))[1] = (select public.current_company())::text
              and (select public.has_module('payroll')))
  with check (bucket_id = 'payslips'
              and (storage.foldername(name))[1] = (select public.current_company())::text
              and (select public.has_module('payroll')));
create policy "payslip PDFs: payroll deletes" on storage.objects
  for delete to authenticated
  using (bucket_id = 'payslips'
         and (storage.foldername(name))[1] = (select public.current_company())::text
         and (select public.has_module('payroll')));
