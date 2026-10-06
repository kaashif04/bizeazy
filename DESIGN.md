---
name: BizEazy Hub
description: A restaurant back office where every figure reads like a payment-success screen.
colors:
  payment-blue: "#1463FF"
  payment-blue-deep: "#0A4FD6"
  payment-blue-wash: "#DCE7FF"
  payment-blue-tint: "#EEF4FF"
  paid-mint: "#008A62"
  paid-mint-dot: "#00A877"
  paid-mint-bright: "#4AD6A7"
  paid-mint-text: "#006E4F"
  waiting-amber: "#F09A00"
  waiting-amber-text: "#7A4800"
  late-coral: "#F04438"
  late-coral-strong: "#D92D20"
  late-coral-text: "#B42318"
  navy-ink: "#0B1B3F"
  night-ground: "#060F26"
  night-surface: "#0B1B3F"
  cool-paper: "#F4F6FB"
  surface-white: "#FFFFFF"
  hairline: "#EAEEF6"
  border: "#D9E0EC"
  non-text-ink: "#8F9BB3"
  secondary-ink: "#5B6B8C"
  body-ink: "#33405F"
typography:
  display:
    fontFamily: "Manrope, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "2.75rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.025em"
    fontFeature: "\"tnum\", \"cv11\", \"ss01\""
  headline:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.025em"
    fontFeature: "\"tnum\""
  title:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.43
    letterSpacing: "-0.008em"
  label:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "-0.008em"
  micro:
    fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.09
rounded:
  lg: "8px"
  xl: "12px"
  2xl: "16px"
  sheet: "20px"
  3xl: "24px"
  full: "9999px"
spacing:
  row-x: "16px"
  row-y: "14px"
  gutter-phone: "16px"
  gutter-desktop: "24px"
  section-gap: "24px"
  touch-target: "44px"
components:
  button-primary:
    backgroundColor: "{colors.payment-blue}"
    textColor: "{colors.surface-white}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.payment-blue-deep}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.body-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "44px"
  input:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.navy-ink}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.surface-white}"
    rounded: "{rounded.2xl}"
    padding: "16px"
  status-pill-paid:
    backgroundColor: "#E6FAF3"
    textColor: "{colors.paid-mint-text}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  status-pill-waiting:
    backgroundColor: "#FFF7E6"
    textColor: "{colors.waiting-amber-text}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  status-pill-late:
    backgroundColor: "#FFF1F0"
    textColor: "{colors.late-coral-text}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  money-field:
    backgroundColor: "{colors.payment-blue}"
    textColor: "{colors.surface-white}"
    typography: "{typography.display}"
    padding: "24px 20px 64px"
  quick-action:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.payment-blue}"
    rounded: "{rounded.full}"
    size: "56px"
  nav-item-active:
    backgroundColor: "{colors.payment-blue}"
    textColor: "{colors.surface-white}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "10px 12px"
  confirm-card:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.navy-ink}"
    typography: "{typography.headline}"
    rounded: "{rounded.3xl}"
    padding: "28px 24px"
    width: "320px"
---

# Design System: BizEazy Hub

## Overview

**Creative North Star: "Payment Confirmed"**

Every figure in BizEazy reads like the success screen of a DuitNow or e-wallet payment: one confident amount, set large in tabular figures, confirmed with a tick that draws itself. The Hub opens on a committed blue money field that owns the top of the screen and ends in a scalloped receipt tear; everything below it sits on cool paper in white, softly lifted cards. The system refuses the category default of grey stat tiles in a white grid.

Density is phone-first: one column, thumb-height actions, 44px touch floors, a bottom tab bar on phones and a sidebar from `md` up. Desktop adds room, never features. One geometric workhorse face (Manrope) carries everything; weight, not a second family, separates an amount from its label.

Motion is quick and additive: 150 to 300ms, ease-out-quint, transform and opacity only, never blocking input, and fully suppressed under reduced motion. Content is visible by default; motion only confirms.

Printed and PDF documents (anything marked `data-document`: invoices, quotations, kitchen sheets, payslips, branch templates) are outside this system. They keep the previous warm palette and Archivo / JetBrains Mono faces, restored by a token override in `src/index.css`.

**Key Characteristics:**
- A blue money field with a scalloped receipt edge as the Hub's single ornament.
- Oversized extra-bold tabular amounts with the currency and cents set smaller.
- Mint means paid, amber means waiting, coral means late, always with a dot and a word.
- Big rounded white cards on cool paper; pills for status and secondary actions.
- A drawn tick as the one confirming gesture (toasts, the confirmed moment, "All clear").

## Colors

A cool, committed palette: one saturated payment blue, three status hues, and a navy ink ramp that never reaches black.

### Primary
- **Payment Blue** (payment-blue): the money field, primary buttons, the active sidebar item, the brand mark, the focus ring family and the caret. Deepens to **Payment Blue Deep** for hover and for the money field in dark mode.
- **Blue Wash / Blue Tint** (payment-blue-wash, payment-blue-tint): labels set on the money field, the active bottom-tab pill, and the "just so you know" info pill.

### Secondary (status)
- **Paid Mint** (paid-mint, paid-mint-dot, paid-mint-bright, paid-mint-text): paid, done, saved. The drawn tick, the paid dot, the collected-progress bar on the blue field, paid pill text.
- **Waiting Amber** (waiting-amber, waiting-amber-text): partially paid, due soon. Amber text is 700 or darker on light grounds; the 500 tone is for dots only.
- **Late Coral** (late-coral, late-coral-strong, late-coral-text): unpaid, overdue, errors, the count badge on the Payroll tab.

### Neutral
- **Cool Paper** (cool-paper): the app ground in light mode.
- **Surface White** (surface-white): cards, rows, header, sidebar, tab bar, toasts.
- **Navy Ink** (navy-ink): primary text. Also the dark-mode card surface.
- **Night Ground** (night-ground): the dark-mode app ground, header and tab bar.
- **Hairline / Border** (hairline, border): dividers inside cards, header and tab-bar rules; input and sidebar borders.
- **Secondary Ink** (secondary-ink): secondary text in light mode.
- **Non-text Ink** (non-text-ink): chevrons, placeholder glyphs, scrollbar hover. Secondary text in dark mode only.

### Named Rules
**The Dot-and-Word Rule.** Money state is never conveyed by colour alone. Every status pill pairs a 4 to 6px dot with a word ("Paid", "Partial", "Unpaid", "3 days left"); every coloured figure sits under a text label ("Collected", "Owed to you").

**The Never-Black Rule.** Text is navy ink, not black; shadows are tinted from navy ink, not black.

**The Legacy-Alias Rule.** `gray-*`, `slate-*`, `indigo-*`, `purple-*` and `red-*` resolve to the ink, brand and coral ramps. New code uses `ink-*`, `brand-*`, `emerald-*`, `amber-*`, `rose-*`; the aliases exist only so a missed class still lands on the right colour.

## Typography

**Display Font:** Manrope (with ui-sans-serif, system-ui, -apple-system, Segoe UI)
**Body Font:** Manrope
**Label/Mono Font:** Manrope with tabular figures (`--font-mono` deliberately resolves to Manrope)

**Character:** One geometric face does all the work: extra-bold for amounts and headings, semibold for labels, with a hair of negative tracking (-0.008em) and stylistic sets cv11 and ss01 on the body.

### Hierarchy
- **Display** (800, 2.75rem phone / 3.75rem from `sm`, line-height 1, tight tracking): the money-field amount only.
- **Headline** (800, 2.25rem): the amount in the confirmed moment.
- **Title** (800, 1rem, tight tracking): section headings ("Needs you", "Latest invoices") and the header view title. Secondary amounts on the field step up to 1.25 to 1.5rem at the same weight.
- **Body** (600 to 700, 0.875rem): row titles, nav items, toast messages.
- **Label** (600, 0.75rem, sentence case): figure labels and row detail lines.
- **Micro** (700, 0.6875rem): status pills, tab labels, the header branch line. This is the small-text floor.

### Named Rules
**The Receipt Figure Rule.** Amounts render through `Money`: tabular figures, the currency at 0.5em raised, the cents at 0.55em, both at 80% opacity. Money columns, IDs and dates use tabular figures everywhere.

**The Count-Up Rule.** A headline amount counts up over 300ms (quartic ease-out) when it arrives, and appears instantly under reduced motion.

## Layout

Phone-first single column with a 16px gutter (24px from `sm`), content capped at `max-w-5xl` on the Hub. The money field bleeds edge to edge and its content sits on the same cap. Quick actions ride the field's edge with a -40px overlap in a four-column grid. Below, "Needs you" and "Latest invoices" stack on phone and split 1.2fr / 1fr from `lg`; on desktop the field's figures become a 1.4fr / 1fr / 1fr row.

Navigation: a fixed 64px bottom tab bar under `md`, with content padded by 5rem plus the safe-area inset; a 240px sidebar from `md` up (off-canvas on phone for rare actions). The header is 56px on phone, 64px from `md`.

Touch: on coarse pointers every button, select and input holds a 44px minimum; form controls hold a 38px minimum everywhere; inputs stay at 16px text under 768px so iOS never zooms.

## Elevation & Depth

Soft, navy-tinted layered shadows: every shadow pairs an offset with a soft blur and is mixed from navy ink, never black. Cards sit at the small shadow at rest and rise one step on hover; floating things (quick-action buttons, toasts, the confirmed card) carry large and extra-large shadows. Bottom sheets cast upward.

### Shadow Vocabulary
- **sm** (`0 1px 3px -1px navy 10%, 0 1px 2px -1px navy 6%`): cards and list rows at rest.
- **md** (`0 4px 12px -3px navy 12%, 0 2px 4px -2px navy 8%`): row hover, the active sidebar item, the brand mark.
- **lg** (`0 12px 28px -8px navy 18%, 0 4px 10px -4px navy 10%`): round quick-action buttons.
- **xl** (`0 24px 56px -16px navy 26%, 0 8px 20px -8px navy 14%`): toasts and the confirmed card.
- **sheet** (`0 -10px 40px -12px navy 30%`): bottom sheets, lit from the content they cover.

### Named Rules
**The Tinted Shadow Rule.** Shadows are `color-mix` of navy ink (#0B1B3F) with transparent; no hard offsets, no black.

## Shapes

Big, friendly radii and full pills. Cards, list rows, banners and toasts are 16px; the confirmed card is 24px; bottom sheets 20px. Buttons and inputs are 8px; sidebar items and compact buttons 12px. Status pills, secondary outline actions, quick actions, avatars and the bottom-tab active marker are fully round.

**The Receipt Edge Rule.** The money field ends in a scalloped tear line (7px radius circles on an 18px repeat, applied as a mask so it works on any colour beneath). It is the one ornament the world allows; nothing else gets decorative edges.

## Components

### Buttons
Confident and compact.
- **Shape:** gently rounded (8px); 12px on some toolbar actions.
- **Primary:** payment blue, white extra-small bold text, small shadow; hover deepens to payment blue deep.
- **Outline / secondary:** fully round, hairline border, body-ink text, paper hover; 44px tall via the tap utility.
- **Text link:** blue-deep bold label with underline on hover, 44px hit area ("See all").
- **Press:** quick actions lift 2px on hover and scale to 95% on press over 150ms.

### Status pills
- **Style:** fully round, micro type, 50-tint ground with 700/800 text (950 at 60% ground with 300 text in dark), a 4 to 6px solid dot before the word.
- **States:** paid (mint), partial or due soon (amber), unpaid or late (coral), info (blue).

### Cards / Containers
- **Corner Style:** 16px.
- **Background:** white on cool paper; navy-ink in dark mode.
- **Shadow Strategy:** sm at rest, md on hover (see Elevation).
- **Border:** none on cards; hairline dividers between rows inside them. Warning and error banners use a 200-tone border on a 50 ground.
- **Internal Padding:** 16px horizontal, 14px vertical for rows.

### Inputs / Fields
- **Style:** 8px radius, 1px border-tone stroke, white ground (navy-ink with 700 border in dark), 12px leading icon inset.
- **Focus:** a 1px payment-blue ring on the field; elsewhere keyboard focus gets the global 2px blue outline at 2px offset (300 tone in dark), never on mouse click.

### Navigation
- **Sidebar (md+):** white, 240px, bold 14px items at 12px radius; the active item is solid payment blue with white text and the md shadow; inactive items take a paper hover.
- **Bottom tab bar (phone):** white with a hairline top rule, 64px tabs, micro labels; the active tab wears a blue-wash pill (56x32) behind a heavier-stroked icon, with blue-deep label. A coral count badge marks Payroll.

### Money Field (signature)
Payment blue band (payment blue deep in dark), white display amount counted up, blue-wash labels, a 6px mint progress bar on a 20% white track for "paid of this month's invoices", and the receipt edge. Modules repeat its figure language in a single white summary band of three labelled figures, not in stat tiles.

### Quick Actions (signature)
Four 56px (64px from `sm`) white circles with lg shadow and blue icons, labelled underneath in bold 12px, overlapping the money field's edge. Labels are verbs ("New invoice", "New quote").

### Confirmed Moment and Toasts (signature)
Money recorded or paid out triggers the confirmed moment: a centred 24px-radius white card with a 64px drawn tick in paid mint, a label and the amount in headline type, entering with `confirm-in` (200ms scale from 94%) and gone after 1.4s. It never takes focus or blocks a tap. Other saves use a toast: 16px-radius white card with xl shadow, a drawn tick for success, rising in over 220ms, sitting just above the tab bar on phone and bottom-right on desktop.

## Do's and Don'ts

### Do:
- **Do** write every dark-mode colour as an explicit `dark:` class beside its light counterpart.
- **Do** pair every status colour with a dot and a word, and every coloured figure with a text label.
- **Do** render amounts through `Money` (or the same currency/cents treatment) in tabular figures.
- **Do** keep motion between 150 and 300ms on ease-out-quint, animating only transform and opacity: `view-enter` 180ms for screens, `row-enter` 260ms with 40ms stagger for lists, `toast-in` 220ms, `confirm-in` 200ms, `tick-draw` 300ms after 60ms, `progress-grow` 220ms.
- **Do** honour reduced motion: the global override collapses animation and transition, and count-ups render the final value at once.
- **Do** use skeletons, not spinners, for loading content.
- **Do** use `ink-500` (not `ink-400`) for secondary text on light grounds; `ink-400` is a non-text tone there.

### Don't:
- **Don't** use `!important` in component or UI styling. The only sanctioned instances are the global reduced-motion override and print rules, which must beat every component.
- **Don't** restyle anything inside `[data-document]`: invoices, quotations, kitchen sheets, payslips and branch templates keep their own palette and faces.
- **Don't** convey money state by colour alone.
- **Don't** add ornaments beyond the receipt edge, or a second type family to the app UI.
- **Don't** use pure black for text or shadows.
- **Don't** set text below the 0.6875rem micro floor.
- **Don't** let motion block input or hide content by default.
