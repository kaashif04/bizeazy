---
name: BizEazy Hub
description: A restaurant back office in soft relief, ivory raised and pressed with one cobalt accent.
colors:
  cobalt: "#1450E6"
  cobalt-deep: "#0E40C2"
  cobalt-focus: "#2F64F0"
  cobalt-bright: "#5A86F7"
  cobalt-light: "#8DADFF"
  cobalt-wash: "#DCE6FF"
  cobalt-tint: "#EEF3FF"
  paid-mint: "#008A62"
  paid-mint-dot: "#00A877"
  paid-mint-text: "#006E4F"
  waiting-amber: "#F09A00"
  waiting-amber-text: "#7A4800"
  late-coral: "#F04438"
  late-coral-strong: "#D92D20"
  late-coral-text: "#B42318"
  ivory-paper: "#F2EFE9"
  ivory-card: "#FBFAF7"
  pressed-track: "#E9E5DD"
  border: "#DCD6CB"
  non-text-ink: "#9C958A"
  secondary-ink: "#6A645B"
  body-ink: "#3E3A35"
  charcoal: "#1C1B19"
  night-ground: "#121110"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "2.75rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.03em"
    fontFeature: "\"tnum\""
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.025em"
    fontFeature: "\"tnum\""
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "-0.011em"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.09
    letterSpacing: "0.14em"
  micro:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 700
    lineHeight: 1.09
rounded:
  lg: "12px"
  xl: "16px"
  sheet: "20px"
  2xl: "24px"
  hero: "28px"
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
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.ivory-card}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.cobalt-deep}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.body-ink}"
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "44px"
  input:
    backgroundColor: "{colors.ivory-card}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.lg}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.ivory-card}"
    rounded: "{rounded.2xl}"
    padding: "16px"
  hero-card:
    backgroundColor: "{colors.ivory-card}"
    textColor: "{colors.charcoal}"
    typography: "{typography.display}"
    rounded: "{rounded.hero}"
    padding: "24px 20px 64px"
  progress-track:
    backgroundColor: "{colors.pressed-track}"
    rounded: "{rounded.full}"
    height: "10px"
  quick-action:
    backgroundColor: "{colors.ivory-card}"
    textColor: "{colors.cobalt}"
    rounded: "{rounded.full}"
    size: "56px"
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
  nav-item-active:
    backgroundColor: "{colors.cobalt}"
    textColor: "{colors.ivory-card}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "10px 12px"
  tab-active-pill:
    backgroundColor: "{colors.cobalt-wash}"
    textColor: "{colors.cobalt-deep}"
    rounded: "{rounded.full}"
    width: "56px"
    height: "32px"
  confirm-card:
    backgroundColor: "{colors.ivory-card}"
    textColor: "{colors.charcoal}"
    typography: "{typography.headline}"
    rounded: "{rounded.2xl}"
    padding: "28px 24px"
    width: "320px"
---

# Design System: BizEazy Hub

## Overview

**Creative North Star: "Soft System"**

BizEazy is ivory paper shaped into relief. Surfaces are not drawn with lines; they are raised off the paper or pressed into it, lit from the top-left with a pale highlight and shaded to the bottom-right with a warm umber shade. Cards, the Hub's hero and the round quick actions float; fields and progress tracks sit in. Charcoal ink carries every figure, and cobalt is the single accent: primary actions, the active place, progress, focus.

Density is phone-first: one column, 44px touch floors, a bottom tab bar on phones and a sidebar from `md` up. Desktop adds room, never features. One face (Inter) carries everything; weight, size and a tracked uppercase label role separate an amount from its name.

Motion is quick and additive: 150 to 300ms on ease-out-quint, transform and opacity only, never blocking input, fully suppressed under reduced motion.

Printed and PDF documents (anything marked `data-document`: invoices, quotations, kitchen sheets, payslips, branch templates) are outside this system. Inside `[data-document]` the stylesheet restores the previous warm palette, pure white paper, and Archivo / JetBrains Mono, and the raised/pressed shadows do not apply.

**Key Characteristics:**
- Ivory on ivory: depth comes from paired light/shade shadows, not borders or tonal cards.
- Raised cards and pressed fields; the same two gestures everywhere.
- Charcoal figures; cobalt only where something is primary, active or in progress.
- Pill primary buttons, round raised quick actions, fully round status pills.
- Small uppercase tracked labels name sections and figures.
- Mint means paid, amber waiting, coral late, always with a dot and a word.

## Colors

Warm ivory neutrals, charcoal ink, one cobalt accent and three status hues.

### Primary
- **Cobalt** (cobalt): primary pill buttons, the active sidebar item, the brand mark, quick-action icons, the hero's progress bar, the caret and `accent-color`. Hover deepens to **Cobalt Deep** (cobalt-deep), which also sets active tab labels and "See all" links. **Cobalt Focus** (cobalt-focus) is the focus outline.
- **Cobalt Wash / Tint** (cobalt-wash, cobalt-tint): the active bottom-tab pill and the "just so you know" info pill.
- **Cobalt Bright / Light** (cobalt-bright, cobalt-light): the dark-mode progress bar, and dark-mode accent text, icons, caret and focus outline.

### Secondary (status)
- **Paid Mint** (paid-mint, paid-mint-dot, paid-mint-text): paid, done, saved; the drawn tick and paid pills.
- **Waiting Amber** (waiting-amber, waiting-amber-text): partial, due soon. Text is 700 or darker on light grounds; 500 is for dots.
- **Late Coral** (late-coral, late-coral-strong, late-coral-text): unpaid, overdue, errors, the Payroll count badge.

### Neutral
- **Ivory Paper** (ivory-paper): the app ground in light mode.
- **Ivory Card** (ivory-card): every raised surface: cards, rows, the hero, quick actions, header, sidebar, tab bar, toasts. It is `--color-white`, so `bg-white` and `text-white` mean ivory in the app.
- **Pressed Track** (pressed-track): progress tracks, row dividers, hairline rules on header and tab bar.
- **Border** (border): sidebar edge and outline-button strokes.
- **Secondary Ink** (secondary-ink): labels and secondary text on light grounds.
- **Non-text Ink** (non-text-ink): chevrons, scrollbar hover; secondary text in dark mode only.
- **Body Ink** (body-ink): quick-action labels, outline-button text.
- **Charcoal** (charcoal): primary text and figures; also the dark-mode card and hero surface.
- **Night Ground** (night-ground): the dark-mode app ground, header, sidebar and tab bar.

### Named Rules
**The One Accent Rule.** Cobalt is the only accent. It marks what is primary, active or in progress; it never fills a hero, a card or a figure.

**The Dot-and-Word Rule.** Money state is never conveyed by colour alone. Every status pill pairs a 4 to 6px dot with a word ("Paid", "Partial", "Unpaid", "3 days left"); every coloured figure sits under a text label ("Collected", "Owed to you").

**The Never-Black Rule.** Text is charcoal ink, never black; light-mode shade is warm umber, never grey.

**The Legacy-Alias Rule.** `gray-*`, `slate-*`, `indigo-*`, `purple-*` and `red-*` resolve to the ink, cobalt and coral ramps. New code uses `ink-*`, `brand-*`, `emerald-*`, `amber-*`, `rose-*`; the aliases exist only so a missed class still lands.

## Typography

**Display Font:** Inter (with ui-sans-serif, system-ui, -apple-system, Segoe UI)
**Body Font:** Inter
**Label/Mono Font:** Inter with tabular figures (`--font-mono` deliberately resolves to Inter)

**Character:** One neutral workhorse face, slightly tightened (-0.011em) on the body. Large figures are semibold rather than heavy, so the relief, not the ink weight, gives the screen its presence.

### Hierarchy
- **Display** (600, 2.75rem phone / 3.75rem from `sm`, line-height 1, -0.03em): the hero amount only.
- **Headline** (700, 2.25rem): the amount in the confirmed moment.
- **Title** (700, 1rem, tight tracking): the header view title and brand name. Secondary hero figures step to 1.25 to 1.5rem at 600.
- **Body** (400 to 700, 0.875rem): row titles (700), nav items, toast messages.
- **Label** (600, 0.6875rem, 0.14em tracking, uppercase): section names ("Needs you", "Latest invoices") and hero figure names ("Owed to you"). A label names the thing beneath it; it never decorates a heading.
- **Micro** (700, 0.6875rem): status pills, tab labels. This is the small-text floor.

### Named Rules
**The Receipt Figure Rule.** Amounts render through `Money`: tabular figures, the currency at 0.5em raised, the cents at 0.55em, both at 80% opacity. Money columns, IDs and dates use tabular figures everywhere.

**The Count-Up Rule.** The hero amount counts up over 300ms (quartic ease-out) when it arrives, and appears instantly under reduced motion.

## Layout

Phone-first single column with a 16px gutter (24px from `sm`), content capped at `max-w-5xl` on the Hub. The hero is an inset card within the gutter, not a full-bleed band; on desktop its figures become a 1.4fr / 1fr / 1fr row. Quick actions overlap the hero's bottom edge with a -40px offset in a four-column grid capped at `max-w-md`. Below, "Needs you" and "Latest invoices" stack on phone and split 1.2fr / 1fr from `lg`.

Navigation: a fixed 64px bottom tab bar under `md`, content padded by 5rem plus the safe-area inset; a 240px sidebar from `md` up (off-canvas on phone for rare actions). The header is 56px on phone, 64px from `md`.

Touch: on coarse pointers every button, select and input holds 44px; form controls hold 38px everywhere; inputs stay at 16px text under 768px so iOS never zooms.

## Elevation & Depth

Soft relief. Every shadow pairs a highlight offset up-left (`--nm-hl`, white at 85%) with a shade offset down-right (`--nm-sh`, warm umber `rgb(122 104 78)` at 20%). Under `:root.dark` the pair switches to white at 3.5% and black at 55%. A base-layer rule gives every ivory `rounded-2xl` card (and bordered `rounded-xl` card) the small raised shadow, and every text field, select and textarea the pressed shadow, so new surfaces inherit relief without opting in; any shadow utility on the element still wins.

### Shadow Vocabulary
- **xs** (`-1px -1px 2px hl, 1px 1px 3px sh`): the faintest lift.
- **sm** (`-3px -3px 8px hl, 4px 4px 10px sh`): cards, rows, primary buttons at rest.
- **md** (`-5px -5px 12px hl, 6px 6px 16px sh`): row hover, quick actions, the active sidebar item, the brand mark.
- **lg** (`-8px -8px 20px hl, 10px 10px 26px sh`): the Hub hero.
- **xl** (`-10px -10px 28px hl, 16px 16px 40px sh`): toasts and the confirmed card.
- **pressed** (`inset 2px 2px 5px sh, inset -2px -2px 5px hl`): inputs, selects, textareas.
- **pressed-track** (`inset 1px 1px 3px sh, inset -1px -1px 3px hl`): progress tracks.
- **sheet** (`0 -10px 40px -12px` warm umber 22%): bottom sheets, cast upward from the content they cover.

### Named Rules
**The Raised-and-Pressed Rule.** Things you read or tap are raised; things you type into or that fill are pressed. A surface is one or the other, never both, and never flat-with-a-border when it is a card.

**The Paired Light Rule.** Every relief shadow is a highlight and a shade from the same light (top-left). A one-sided drop shadow or a hard offset breaks the world.

## Shapes

Generous, soft radii. Cards, rows and toasts are 24px; the Hub hero 28px; bottom sheets 20px; the confirmed card 24px. Inputs and small icon buttons are 12px; sidebar items and the brand mark 16px. Primary buttons, outline buttons, status pills, quick actions, avatars, progress bars and the active tab marker are fully round.

## Components

### Buttons
Soft and decisive.
- **Shape:** full pill (9999px).
- **Primary:** cobalt with ivory micro-bold text, 8px 16px, small raised shadow; hover deepens to cobalt deep over 150ms.
- **Outline / secondary:** pill, 1px border stroke, body-ink text, ivory-paper hover, 44px tall.
- **Text link:** cobalt-deep bold label, underline on hover, 44px hit area ("See all").
- **Press:** quick actions lift 2px on hover and scale to 95% on press; rows scale to 99%.

### Status pills
- **Style:** fully round, micro type, 50-tint ground with 700/800 text (950 at 60% ground with 300 text in dark), a 6px solid dot before the word.
- **States:** paid (mint), partial or due soon (amber), unpaid or late (coral), info (cobalt).

### Cards / Containers
- **Corner Style:** 24px.
- **Background:** ivory card on ivory paper; charcoal in dark mode.
- **Shadow Strategy:** sm raised at rest, md on hover (see Elevation).
- **Border:** none; rows inside a card are divided by pressed-track hairlines.
- **Internal Padding:** 16px horizontal, 14px vertical for rows.
- **Summary band:** module headers repeat the hero's figure language in one raised card of three labelled figures, never stat tiles.

### Inputs / Fields
- **Style:** 12px radius, pressed inset shadow, ivory ground, 12px leading icon inset.
- **Focus:** keyboard focus gets the global 2px cobalt-focus outline at 2px offset (cobalt-light in dark), never on mouse click.

### Navigation
- **Sidebar (md+):** ivory, 240px, bold 14px items at 16px radius; the active item is solid cobalt with ivory text and the md shadow; inactive items take a pressed-track hover. The brand mark is a 36px cobalt tile with a tick.
- **Bottom tab bar (phone):** ivory with a hairline top rule, 64px tabs, micro labels; the active tab wears a cobalt-wash pill (56x32) behind a heavier-stroked icon, with a cobalt-deep label. A coral count badge marks Payroll.

### Hub Hero (signature)
A raised ivory card (28px radius, lg shadow; charcoal in dark) holding the month's collected amount in charcoal display type, counted up, with tracked uppercase labels over each figure. Under the amount, a cobalt progress bar fills a pressed track (10px, fully round) for "paid of this month's invoices", growing in over 220ms.

### Quick Actions (signature)
Four 56px (64px from `sm`) raised ivory circles with md shadow and cobalt icons, labelled underneath in 12px medium body-ink, overlapping the hero's bottom edge. Labels are verbs ("New invoice", "New quote").

### Confirmed Moment and Toasts (signature)
Money recorded or paid out triggers a centred 24px-radius ivory card with xl shadow, a 64px drawn tick in paid mint, a label and the amount in headline type, entering with `confirm-in` (200ms from 94% scale) and gone after 1.4s. It never takes focus or blocks a tap. Other saves use a toast: 24px-radius ivory card with xl shadow, drawn tick for success, rising in over 220ms.

## Do's and Don'ts

### Do:
- **Do** write every dark-mode colour as an explicit `dark:` class beside its light counterpart.
- **Do** build depth from the shadow tokens (`shadow-sm` to `shadow-xl`) and the pressed inset pair, so dark mode follows `--nm-hl` / `--nm-sh` automatically.
- **Do** pair every status colour with a dot and a word, and every coloured figure with a text label.
- **Do** render amounts through `Money` (or the same currency/cents treatment) in tabular figures.
- **Do** keep motion between 150 and 300ms on ease-out-quint, animating only transform and opacity: `view-enter` 180ms, `row-enter` 260ms with 40ms stagger, `toast-in` 220ms, `confirm-in` 200ms, `tick-draw` 300ms after 60ms, `progress-grow` 220ms, `sheet-up` 280ms.
- **Do** honour reduced motion: the global override collapses animation and transition, and count-ups render the final value at once.
- **Do** use skeletons, not spinners, for loading content.
- **Do** use `ink-500` (not `ink-400`) for secondary text on light grounds; `ink-400` is a non-text tone there.

### Don't:
- **Don't** use `!important` in component or UI styling. The only sanctioned instances are the global reduced-motion override and print rules, which must beat every component.
- **Don't** restyle anything inside `[data-document]`: invoices, quotations, kitchen sheets, payslips and branch templates keep their own palette, white paper and faces.
- **Don't** convey money state by colour alone.
- **Don't** fill a hero or card with cobalt, or add a second accent hue outside the status trio.
- **Don't** use one-sided drop shadows or hard offsets; relief is always a highlight and shade pair.
- **Don't** add a second type family to the app UI.
- **Don't** use pure black for text.
- **Don't** set text below the 0.6875rem floor.
- **Don't** let motion block input or hide content by default.
