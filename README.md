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

## Checks

| What | How |
|---|---|
| Backend auth logic | `runAuthSelfCheck()` in the Apps Script editor |
| Session / remember-me rules | `npx tsx src/auth.selfcheck.ts` |
| Types | `npm run lint` |

## Known limits

- An outlet id is still one of two legacy slots (`Bistro` / `Nasi Kandar`), so a company
  is capped at two branches and a newly registered one starts with a single outlet
  parked in the first slot. Adding, renaming and removing branches freely is the next
  piece of work, and it is a type change in `src/types.ts` plus the `isBistro ? …` sites.
- Notifications (salary due, payment reminders) are not built yet.
