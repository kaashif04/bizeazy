# BizEazy

Restaurant operations app: invoicing, catering quotations, and Malaysian-statutory payroll.
React + Vite frontend on Vercel; Google Apps Script + Google Sheets backend.

## Run locally

Prerequisites: Node.js

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint       # tsc --noEmit
npm run build
```

## Architecture

- **Frontend** — `src/`, deployed to Vercel (auto-deploys on push to `main`).
- **Backend** — `Code.gs` + `Auth.gs`, a Google Apps Script web app. **Not deployed by
  pushing to git.** Paste the files into the Apps Script editor and redeploy manually.
- **Data** — one Google Sheet per company, created on registration. A separate
  *directory* spreadsheet holds companies, users and sessions.

### Accounts and access

Sign-in is a user ID and password checked against the `Users` tab of the directory
spreadsheet (salted SHA-256, iterated — see `PW_ITERATIONS` in `Auth.gs`). The web app
is deployed "Anyone", so **every action except login/registration is gated on a session
token inside `Auth.gs`** — and the session, not the client, decides which spreadsheet is
read or written. A user without the Payroll module never receives employee or payslip
rows at all; the hidden nav item is cosmetic on top of that.

Admins manage their own company's users under **Users & Access**: create accounts, tick
which modules each can open, reset passwords, disable or delete. The last active admin
cannot be demoted, disabled or deleted.

## Backend setup (one time)

1. Open the Apps Script project bound to the deployment.
2. Paste `Code.gs` over the existing `Code.gs`.
3. **File ▸ New ▸ Script**, name it `Auth`, and paste `Auth.gs` into it.
4. Run `runAuthSelfCheck()` once — it verifies the password hashing and the permission
   filters without touching any sheet.
5. Edit the four constants at the top of `bootstrapExistingCompany()` (your existing
   spreadsheet id, company name, admin user ID, admin password) and run it once. It
   registers your current sheet as company #1 and creates the admin login. Clear the
   password out of the file afterwards.
6. **Deploy ▸ Manage deployments ▸ Edit ▸ New version.** Execute as *me*, access
   *Anyone*. Redeploy after any change to either `.gs` file.

The directory spreadsheet is created automatically on first use; its URL is logged by
`bootstrapExistingCompany()`.

### Closing public registration

Anyone with the `/exec` URL can register a company, and each registration creates a
spreadsheet in the script owner's Drive. To require an invite code, add a script
property `REGISTRATION_CODE` (Project Settings ▸ Script Properties). Leave it unset to
keep sign-ups open.

### Branches

A company has as many branches (brands, outlets, stores) as it likes, managed under
**Branches & Documents**. Each carries its own name, address, logo, invoice series and
document design.

An outlet's **id is its key in the Config tab**, which is why lifting the original
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

**By email** — `sendDueReminders()` in `Code.gs` scans every company daily and emails
its active admins when salary for the last ended month is not marked paid. Install the
8am trigger once:

1. Select `installReminderTrigger` in the function dropdown and Run (it asks for the
   Gmail scope the first time). `removeReminderTrigger` undoes it.
2. Optional: set a script property `APP_URL` to put a link to the app in the email.
3. A company opts out by setting its Config tab row `notifications` to
   `{"salary_email":false}`.

Admins only receive mail if their user row has an email address — set those under
**Users & Access**.

The salary rule is the **Employment Act s.19** 7-day window, defined once in
`src/utils/notifications.ts` and used by the payslip generator's countdown, the bell and
the email. Apps Script cannot import TypeScript, so `Code.gs` re-derives it — and
`notifications.selfcheck.ts` loads `Code.gs` and fails if the two ever disagree about
the deadline or about who is owed a payslip.

## Checks

| What | How |
|---|---|
| Backend auth logic | `runAuthSelfCheck()` in the Apps Script editor |
| Session / remember-me rules | `npx tsx src/auth.selfcheck.ts` |
| Outlet resolution, incl. legacy rows | `npx tsx src/utils/outlets.selfcheck.ts` |
| Reminder rules + Code.gs mirror drift | `npx tsx src/utils/notifications.selfcheck.ts` |
| Reminder date rules, in Apps Script | `runReminderSelfCheck()` in the editor |
| Types | `npm run lint` |

## Known limits

- Email reminders cover salary only. Overdue invoices and lapsing quotations appear in
  the app but are not emailed.
- There is no UI toggle for email reminders; it is the `notifications` row in the
  company's Config tab.
- Branch names must be unique within a company, because rows are stamped with the name.
- `saveInvoice` and `updateInvoiceStatus` were removed from the backend: the app has
  always written invoices through `syncData`, so both were unreachable.
