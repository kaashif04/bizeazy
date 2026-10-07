-- Each person's own shift, per weekday. A weekday with no row is a day off;
-- someone with no rows at all works the company's default hours
-- (settings.attendance). Shifts decide lateness and how many days leave takes.

create table public.employee_shifts (
  company_id    uuid not null references public.companies(id) on delete cascade,
  employee_id   text not null,
  weekday       smallint not null check (weekday between 1 and 7),   -- ISO: 1 = Monday
  start_time    time not null,
  end_time      time not null,                                      -- earlier than start = ends after midnight
  break_minutes int not null default 0 check (break_minutes >= 0),
  primary key (company_id, employee_id, weekday)
);

alter table public.employee_shifts enable row level security;

create policy "managers and payroll see every shift, staff their own" on public.employee_shifts
  for select to authenticated
  using (company_id = (select public.current_company()) and (
    (select public.has_module('team')) or (select public.has_module('payroll'))
    or employee_id = (select public.current_employee())));
create policy "managers set shifts" on public.employee_shifts
  for all to authenticated
  using      (company_id = (select public.current_company()) and (select public.has_module('team')))
  with check (company_id = (select public.current_company()) and (select public.has_module('team')));

-- Replace a person's whole week in one step. p_days: [{weekday, start, end, break}];
-- an empty list puts them back on the company's hours. Runs as the caller, so
-- the policy above decides.
create function public.set_shift(p_employee_id text, p_days jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_company uuid := public.current_company();
begin
  if v_company is null or not public.has_module('team') then
    raise exception 'Only managers can set shifts.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.records
                 where company_id = v_company and kind = 'employees' and id = p_employee_id) then
    raise exception 'That employee is not in this company.';
  end if;
  delete from public.employee_shifts where company_id = v_company and employee_id = p_employee_id;
  insert into public.employee_shifts (company_id, employee_id, weekday, start_time, end_time, break_minutes)
  select v_company, p_employee_id, (d->>'weekday')::smallint, (d->>'start')::time, (d->>'end')::time,
         coalesce((d->>'break')::int, 0)
  from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) d;
end
$$;

-- Is this a working day for this person, and when does it start? Their own
-- shift if they have one, otherwise the company's hours and work days. Runs as
-- the caller, so it sees only shifts the caller may read.
create function public.shift_on(p_company uuid, p_employee text, p_day date)
returns table (scheduled boolean, start_time time, end_time time)
language sql stable security invoker set search_path = '' as $$
  with own as (
    select s.start_time, s.end_time from public.employee_shifts s
    where s.company_id = p_company and s.employee_id = p_employee
      and s.weekday = extract(isodow from p_day)::int
  ),
  has_own as (
    select exists (select 1 from public.employee_shifts s
                   where s.company_id = p_company and s.employee_id = p_employee) as yes
  ),
  co as (
    select coalesce(c.value->'attendance', '{}'::jsonb) as a
    from (select 1) one
    left join public.config c on c.company_id = p_company and c.key = 'settings'
  )
  select
    case when h.yes then exists (select 1 from own)
         else extract(isodow from p_day)::int in (
           select jsonb_array_elements_text(coalesce(co.a->'work_days', '[1,2,3,4,5,6]'::jsonb))::int)
    end,
    case when h.yes then (select start_time from own) else coalesce(co.a->>'day_start', '09:00')::time end,
    case when h.yes then (select end_time from own)   else coalesce(co.a->>'day_end', '18:00')::time end
  from has_own h, co
$$;

-- attendance_days, now judged against each person's own shift. Same columns as
-- before, plus scheduled / shift_start / shift_end at the end.
create or replace view public.attendance_days with (security_invoker = true) as
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
grace as (
  select company_id, coalesce((value->'attendance'->>'grace_minutes')::int, 10) as minutes
  from public.config where key = 'settings'
)
select d.company_id, d.employee_id, d.work_date, d.first_in, d.last_in,
       case when d.open then null else d.last_out end as last_out,
       floor(d.seconds / 60)::int as worked_minutes,
       f.scans::int as scans, d.open,
       -- Late only on a working day, against that day's start (a start before
       -- 4 am belongs to the small hours after the working date).
       coalesce(sh.scheduled and d.first_in >
         ((d.work_date + sh.start_time + case when sh.start_time < '04:00' then interval '1 day' else interval '0' end)
            at time zone 'Asia/Kuala_Lumpur') + make_interval(mins => coalesce(g.minutes, 10)), false) as late,
       f.has_manual, f.untrusted as untrusted_clock,
       sh.scheduled, sh.start_time as shift_start, sh.end_time as shift_end
from days d
join flags f using (company_id, employee_id, work_date)
left join grace g on g.company_id = d.company_id
cross join lateral public.shift_on(d.company_id, d.employee_id, d.work_date) sh;

-- Leave counts the person's own working days.
drop function public.leave_days(uuid, date, date, boolean);
create function public.leave_days(p_company uuid, p_employee text, p_start date, p_end date, p_half boolean)
returns numeric language sql stable security definer set search_path = '' as $$
  with work as (
    select count(*) as n
    from generate_series(p_start, p_end, interval '1 day') as g(d)
    cross join lateral public.shift_on(p_company, p_employee, g.d::date) sh
    where sh.scheduled and p_company = public.current_company()
  )
  select case when p_half then least(n, 1) * 0.5 else n end from work
$$;

create or replace function public.request_leave(p_leave_type_id uuid, p_start date, p_end date,
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

  v_days := public.leave_days(v_company, v_emp, p_start, p_end, v_half);
  if v_days <= 0 then raise exception 'You are not working on those dates.'; end if;

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

revoke execute on function public.set_shift(text, jsonb) from anon, public;
revoke execute on function public.shift_on(uuid, text, date) from anon, public;
revoke execute on function public.leave_days(uuid, text, date, date, boolean) from anon, public;
grant execute on function public.set_shift(text, jsonb) to authenticated;
grant execute on function public.shift_on(uuid, text, date) to authenticated;
grant execute on function public.leave_days(uuid, text, date, date, boolean) to authenticated;
