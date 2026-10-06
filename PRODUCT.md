# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Restaurant owners in Malaysia** (primary). They open BizEazy Hub on a phone
  for quick checks during the day — who is unpaid, what customers owe, salary
  due — and also do real work on the phone: raising invoices and quotations,
  generating payslips. Month-end payroll, quotations and reports also happen at
  a laptop or desktop.
- **Family members or partners** with full admin access.
- **Office/admin staff** who do invoicing or payroll for the owner, limited to
  the modules they are granted.
- Restaurant floor staff and branch managers are served by a separate Staff app
  (see `docs/staff-app-master-prompt.md`), not by the Hub.

## Product Purpose

One back office for a small restaurant business with one or several branches:
catering quotations, invoices with part payments, Malaysian-statutory payroll
(EPF, SOCSO, EIS, SKBBK from the official schedules), and reports. Success is an
owner who runs the money side of the business from their phone without an
accountant chasing them, and keeps coming back because it is quicker than the
alternative.

## Positioning

Built for the Malaysian restaurant trade specifically: multi-day catering
quotations with sessions and pax, invoices per branch, and payroll that follows
KWSP and PERKESO tables, salary deadlines (Employment Act 7-day rule), part
months, advances and resignations — in one place, multi-user, on a phone.

## Operating Context

- Used between service rushes, on a phone held in one hand, often in a bright or
  noisy restaurant; and at a desk for month-end work.
- Documents leave the app as printed or PDF invoices, quotations, kitchen sheets
  and payslips. **Their design is fixed and outside UI work**: anything marked
  `data-document`, and each branch's document template.
- Data lives in Supabase; every save goes straight to the database.
- A fingerprint clock-in kiosk and a separate Staff app are being built to feed
  attendance into the Hub.

## Capabilities and Constraints

- Modules: Hub overview, Invoicing, Quotations, Payroll, Reports; Users &
  Access, Branches & Documents, Data & Import.
- Multi-tenant: User ID + password logins; access per module; branches per
  company; payroll by whole company or by branch.
- Must stay fast on mid-range phones and patchy restaurant Wi-Fi.
- Stack: React 19, TypeScript, Vite, Tailwind CSS v4, Supabase; deployed on
  Vercel.

## Brand Commitments

- The name **BizEazy** is fixed. There is no logo or brand colour to preserve;
  the visual identity is open.

## Product Principles

1. **The phone is the office.** Every core job must be completable one-handed on
   a phone; the desktop adds room, not features.
2. **Speed is the feature.** Nothing waits on the network that does not have to;
   the app should feel instant.
3. **Money is never ambiguous.** Amounts, statuses and deadlines are always
   legible and never conveyed by colour alone.
4. **Documents are sacred.** What customers and staff receive does not change
   when the app's look does.

## Accessibility & Inclusion

- Readable at arm's length in bright light: body text and secondary labels meet
  WCAG AA contrast in light and dark mode.
- Touch targets at least 44 px on touch devices; respects reduced motion.
