-- BizEazy on Supabase: tenants, logins, settings and every business record.
-- Access is decided here, by row-level security, not by the app.

-- ── Tenants and people ─────────────────────────────────────────
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  owner_email text not null default '',
  created_at  timestamptz not null default now()
);

-- One row per login. user_code is the lower-cased User ID people type; it is
-- unique across every company, which is what makes "taken" mean taken.
create table public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_code  text not null unique check (user_code ~ '^[a-z0-9._-]{3,32}$'),
  display_id text not null,
  full_name  text not null default '',
  email      text not null default '',
  role       text not null default 'member' check (role in ('admin', 'member')),
  modules    text[] not null default '{}',
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index profiles_company_idx on public.profiles (company_id);

-- Branch profiles and other settings: one row per key, as the Config tab was.
create table public.config (
  company_id uuid not null references public.companies(id) on delete cascade,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (company_id, key)
);

-- Every business record, stored whole. A field the app adds later is kept
-- without a schema change, so no save can silently drop one.
create table public.records (
  company_id uuid not null references public.companies(id) on delete cascade,
  kind       text not null check (kind in (
               'invoices', 'invoice_items', 'payments', 'customers',
               'employees', 'payslips', 'quotations', 'quotation_days', 'quotation_items')),
  id         text not null check (length(id) > 0),
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (company_id, kind, id)
);

-- ── Who may see what ───────────────────────────────────────────
create function public.current_company() returns uuid
language sql stable security definer set search_path = '' as $$
  select company_id from public.profiles
  where user_id = (select auth.uid()) and active
$$;

-- Which module owns a record kind. Customers belong to none: invoicing and
-- quotations both create them, so every member may read the list.
create function public.kind_module(k text) returns text
language sql immutable set search_path = '' as $$
  select case
    when k in ('invoices', 'invoice_items', 'payments')           then 'invoicing'
    when k in ('quotations', 'quotation_days', 'quotation_items') then 'quotations'
    when k in ('employees', 'payslips')                           then 'payroll'
  end
$$;

-- Admins hold every module, so no admin can lock themselves out.
create function public.has_module(m text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid()) and p.active
      and (p.role = 'admin' or m is null or m = any (p.modules))
  )
$$;

alter table public.companies enable row level security;
alter table public.profiles  enable row level security;
alter table public.config    enable row level security;
alter table public.records   enable row level security;

create policy "members see their company" on public.companies
  for select to authenticated using (id = (select public.current_company()));

-- Read-only from the app: accounts are created and changed by the accounts
-- edge function, which checks the caller is an admin of the same company.
create policy "members see their colleagues" on public.profiles
  for select to authenticated using (company_id = (select public.current_company()));

create policy "members read settings" on public.config
  for select to authenticated using (company_id = (select public.current_company()));
create policy "settings module writes settings" on public.config
  for all to authenticated
  using      (company_id = (select public.current_company()) and (select public.has_module('settings')))
  with check (company_id = (select public.current_company()) and (select public.has_module('settings')));

create policy "members use the records their modules cover" on public.records
  for all to authenticated
  using      (company_id = (select public.current_company()) and public.has_module(public.kind_module(kind)))
  with check (company_id = (select public.current_company()) and public.has_module(public.kind_module(kind)));

-- ── Saving ─────────────────────────────────────────────────────
-- One call, one transaction: the rows this device changed, and the ones it
-- deleted. Runs as the caller, so the policies above decide every row.
create function public.apply_changes(p_upserts jsonb, p_deletes jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_company uuid := public.current_company();
begin
  if v_company is null then
    raise exception 'No active account for this sign-in.' using errcode = '42501';
  end if;

  insert into public.records (company_id, kind, id, data)
  select v_company, u->>'kind', u->>'id', u->'data'
  from jsonb_array_elements(coalesce(p_upserts, '[]'::jsonb)) u
  on conflict (company_id, kind, id)
  do update set data = excluded.data, updated_at = now(), updated_by = auth.uid();

  delete from public.records r
  using jsonb_array_elements(coalesce(p_deletes, '[]'::jsonb)) d
  where r.company_id = v_company and r.kind = d->>'kind' and r.id = d->>'id';
end
$$;

-- Settings are saved as a whole set of keys: keys left out are removed.
create function public.replace_config(p_config jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_company uuid := public.current_company();
begin
  if v_company is null then
    raise exception 'No active account for this sign-in.' using errcode = '42501';
  end if;
  -- Said out loud: the policies alone would just hide the rows, and a refused
  -- save would then look like one that worked.
  if not public.has_module('settings') then
    raise exception 'Your account cannot change settings.' using errcode = '42501';
  end if;

  insert into public.config (company_id, key, value)
  select v_company, e.key, e.value from jsonb_each(coalesce(p_config, '{}'::jsonb)) e
  on conflict (company_id, key) do update set value = excluded.value, updated_at = now();

  delete from public.config c
  where c.company_id = v_company
    and not (coalesce(p_config, '{}'::jsonb) ? c.key);
end
$$;

revoke execute on function public.apply_changes(jsonb, jsonb) from anon, public;
revoke execute on function public.replace_config(jsonb)        from anon, public;
grant  execute on function public.apply_changes(jsonb, jsonb) to authenticated;
grant  execute on function public.replace_config(jsonb)        to authenticated;

-- The two lookups run with the definer's rights; only signed-in users need them.
revoke execute on function public.current_company() from anon, public;
revoke execute on function public.has_module(text)  from anon, public;
grant  execute on function public.current_company() to authenticated;
grant  execute on function public.has_module(text)  to authenticated;
