# BizEazy

Restaurant operations app: invoicing, catering quotations, and Malaysian-statutory payroll.
React + Vite frontend on Vercel; Supabase (Postgres, Auth, one Edge Function) backend.

## Run locally

Prerequisites: Node.js

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint       # tsc --noEmit
npm run build
```

The Supabase URL and publishable key are built in (`src/supabase.ts`); set
`VITE_SUPABASE_URL` / `VITE_SUPABASE_KEY` to point a build at another project.

## Architecture

- **Frontend** — `src/`, deployed to Vercel (auto-deploys on push to `main`).
- **Database** — Supabase project `BizEazy` (`rtleeehglawquekygfoh`, Singapore). Schema
  and access rules in `supabase/migrations/`.
- **Accounts** — `supabase/functions/accounts`, the only code holding the service key:
  company registration, user-ID availability, and admin user management.

Every business record lives in one `records` table, keyed by company, kind and id, with
the record stored whole as JSON. A field the app adds later is kept without a schema
change, so no save can silently drop one. Settings (branch profiles) are rows in
`config`, one per key.

**Saving** (`src/db.ts`) sends only what changed since this device last loaded or saved:
rows added or edited here, rows deleted here — one call, one transaction. Rows nobody
touched on this device are never written, so a stale device cannot revert another's
work and nothing is rewritten wholesale. Two devices editing the *same* record: the later
save wins.

### Accounts and access

People sign in with a **User ID** and password. Supabase Auth holds the real account;
each User ID maps to an internal address on the reserved `.invalid` domain, which can
never receive mail. User IDs are unique across all companies.

**Access is enforced by the database**, with row-level security: a user only ever reads
or writes their own company, and only the record kinds their modules cover (customers
are shared by invoicing and quotations). A user without Payroll never receives an
employee row; the hidden nav item is cosmetic on top of that. Deactivating a user both
blocks sign-in and hides every row.

Admins manage their company's users under **Users & Access**: create accounts, tick
modules, reset passwords, disable or delete. The last active admin cannot be demoted,
disabled or deleted.

## Backend setup (one time)

1. **Schema** — Supabase dashboard ▸ SQL Editor ▸ paste
   `supabase/migrations/20261005000000_bizeazy_core.sql` ▸ Run.
2. **Accounts function** — with the Supabase CLI:
   ```bash
   supabase login
   supabase functions deploy accounts --project-ref rtleeehglawquekygfoh --no-verify-jwt
   ```
   (`--no-verify-jwt` because registration is public; the admin actions check the
   caller's token themselves.)
3. In the app, **Register a new company** — this creates your admin login.

### Moving data over from Google Sheets

1. In the old Apps Script project, open `Code.gs`, paste your spreadsheet link into
   `SPREADSHEET` at the top of `exportForBizEazy()`, and Run it. It is read-only and
   saves `bizeazy-export-<date>.json` to your Drive.
2. In the app, sign in as the admin ▸ **Data & Import** ▸ choose that file.

Branches, invoices, payments, quotations, customers, employees and payslips are copied
in, decoding every legacy encoding older builds left in the sheet. Running it again
updates rather than duplicates. Staff logins are not carried over (old password hashes
cannot be): recreate them under Users & Access.

### Closing public registration

Anyone can register a company. To require an invite code, set a secret
`REGISTRATION_CODE` on the `accounts` function (dashboard ▸ Edge Functions ▸ Secrets).

### Branches

A company has as many branches (brands, outlets, stores) as it likes, managed under
**Branches & Documents**. Each carries its own name, address, logo, invoice series and
document design.

An outlet's **id is its key in the company's settings**, which is why lifting the original
two-branch cap needed no data migration: the first company keeps `Bistro` and
`Nasi Kandar` as ids, invisibly, while branches added since get a generated
`outlet-xxxx`. Stored rows go on naming their branch in the `Company` column exactly as
before, and `resolveOutletId` in `src/utils/outlets.ts` maps that back to an id on read —
by name, then by invoice-series prefix, then by the legacy `LEG-BIS`/`LEG-NK` shapes.

Two consequences worth knowing:

- **Renaming a branch does not rewrite history.** Older rows keep the old name in their
  `Company` column and are re-attached by their invoice prefix, so give every branch a
  distinct series and avoid changing it afterwards.
- **A branch cannot be removed while records point at it.** The modal counts the
  attached invoices, quotations and employees and refuses, rather than orphaning them.

## Reminders

Two halves, one rule.

**In the app** — a bell in the header, counting what needs attention. Every item is
derived from the loaded rows on each render (`src/utils/notifications.ts`), so there is
nothing to mark read and nothing stored: an item disappears when the thing it is about
is dealt with, and cannot be dismissed into hiding a real problem. It covers unpaid
salary for the most recent ended month, invoices unsettled past 30 days, and quotations
lapsing within 3 days that were never billed.

**By email** — not available since the move to Supabase. The old Apps Script scanner
(`sendDueReminders()` in `Code.gs`) read the Google Sheets, which are no longer
written. Rebuilding it is a scheduled Supabase function sharing
`src/utils/notifications.ts`.

The salary rule is the **Employment Act s.19** 7-day window, defined once in
`src/utils/notifications.ts` and used by the payslip generator's countdown, the bell and
the bell.

## Design system

Tokens live in [src/index.css](src/index.css); that file is the place to change how
the app looks.

- **One neutral ramp.** `gray-*` and `slate-*` were both in use, in the same
  components, so a light-mode border and a dark-mode surface disagreed about their
  undertone. Everything now resolves to one warm `ink` ramp. The legacy names are
  still defined with the same values, so a class the rename missed still lands right.
- **Pine brand, saffron warning, clay danger.** The accent is reserved for primary
  actions, current selection and state — not decoration.
- **Archivo** carries the app. Inter and JetBrains Mono stay loaded because they are
  *document* faces, selectable per branch for printed invoices and payslips.
- `ink-400` is a non-text tone: it passes contrast on dark grounds, not light ones.
  Use `ink-500` for secondary text in light mode.
- Elements inside a `data-document` subtree opt out of app theming. An invoice or
  payslip is a white sheet whatever the app theme is.

### Phone first

The real work happens on a phone, so:

- A bottom tab bar ([BottomNav](src/components/ui/BottomNav.tsx)) carries the four
  modules. The off-canvas sidebar keeps the rare things: branch, refresh, settings,
  users, theme, sign out.
- Every dialog is a [Sheet](src/components/ui/Sheet.tsx): a bottom sheet with pinned
  header and actions on a phone, a centred dialog from `sm` up. It portals to
  `<body>`, locks the page behind it, traps Tab, and closes on Escape.
- Lists become cards below `md`; the tables remain above it.
- Controls meet 44px on touch pointers, 38px everywhere else.

## Checks

| What | How |
|---|---|
| Row-level security: companies, modules, deactivation, signed-out access | `npx tsx supabase/rls.selfcheck.ts` |
| What a save writes; the Google Sheets import parser | `npx tsx src/db.selfcheck.ts` |
| Session / keep-me-signed-in rules | `npx tsx src/auth.selfcheck.ts` |
| Outlet resolution, incl. legacy rows | `npx tsx src/utils/outlets.selfcheck.ts` |
| Wage periods, EPF, reminder rules | `npx tsx src/utils/notifications.selfcheck.ts` |
| Types | `npm run lint` |

## Known limits

- Two devices editing the same record at the same moment: the later save wins.
- Email reminders are not available on Supabase yet (see Reminders).
- Branch names must be unique within a company, because rows are stamped with the name.
- Supabase's free plan pauses a project after 7 days with no use; daily use keeps it awake.
- `Code.gs` / `Auth.gs` remain only for `exportForBizEazy()`, the one-time move.
