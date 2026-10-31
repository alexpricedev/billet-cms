# Billet CMS design system

The CMS is a working editorial tool, not a marketing site or an admin template.
The visual language follows Vercel's dashboard and Geist guidelines: neutral
surfaces, hairline borders, one restrained accent, compact type, and precision
over decoration. This file is the source of truth for decisions; the tokens
live in `app/src/client/base.css` and components consume them.

## Principles

1. **Borders before shadows.** Separation is a 1px line and a surface step. A
   shadow means the element genuinely floats (menu, dialog, popover).
2. **Quiet chrome, loud content.** Navigation and toolbars recede. The page
   title, the editor, and the primary action are the only things that compete.
3. **One accent.** Blue marks links, focus and selection. It never fills a
   large surface, and status is never carried by colour alone.
4. **Compact by default.** This is a CMS used for hours. 14px interface type,
   32px controls, 40px table rows, tight gutters. Density is a feature.
5. **Honest states.** Disabled, saving, saved, unpublished and error states are
   real, visible and specific. No fake success, no dead controls.
6. **System, then page.** Shared tokens and components first; a page may add
   layout, never a second palette or type scale.

## Colour tokens

Semantic tokens only. A component never introduces an arbitrary hex value.
Both themes are defined; the theme follows the user's setting, System (the OS)
by default.

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--canvas` | `#fafafa` | `#090909` | Page background, navigation rail |
| `--surface` | `#ffffff` | `#111111` | Cards, panels, popovers, main content |
| `--surface-subtle` | `#f5f5f5` | `#161616` | Inputs, code, inset blocks |
| `--surface-hover` | `#f2f2f2` | `#1c1c1c` | Hover and selected-neutral |
| `--surface-selected` | `#f0f0f0` | `#1f1f1f` | Current nav item, selected row |
| `--text` | `#171717` | `#ededed` | Primary text |
| `--text-secondary` | `#525252` | `#a3a3a3` | Supporting copy, labels |
| `--text-muted` | `#737373` | `#8f8f8f` | Metadata, helper text |
| `--text-disabled` | `#a3a3a3` | `#5c5c5c` | Disabled labels |
| `--border` | `#e5e5e5` | `#292929` | Default hairline |
| `--border-strong` | `#d4d4d4` | `#3a3a3a` | Hover border, dividers that must read |
| `--accent` | `#0070f3` | `#3291ff` | Links, focus, selection |
| `--accent-hover` | `#005cc5` | `#5ba8ff` | Link hover |
| `--accent-soft` | `#eef6ff` | `#0f2237` | Selected hint background |
| `--focus-ring` | `--accent` | `--accent` | Every focus-visible outline |
| `--input-bg` | `--surface` | `--surface` | Form control fill |
| `--input-placeholder` | `--text-muted` | `--text-muted` | Placeholder text |
| `--success` | `#067647` | `#3dd68c` | Live / saved / success text |
| `--success-soft` | `#ecfdf3` | `#0d231a` | Success surface |
| `--warning` | `#b54708` | `#f5b544` | Draft / attention text |
| `--warning-soft` | `#fffaeb` | `#241a08` | Warning surface |
| `--danger` | `#b42318` | `#ff6b6b` | Errors and destructive actions |
| `--danger-soft` | `#fef3f2` | `#2a1110` | Error surface |
| `--button-primary-bg` | `#171717` | `#ededed` | Primary button fill |
| `--button-primary-fg` | `#ffffff` | `#0a0a0a` | Primary button text |

Legacy aliases (`--color-bg`, `--color-surface`, `--color-text`, `--color-primary`
and so on) map onto these tokens so older component CSS cannot drift into a
private palette. New CSS uses the semantic names.

### Status colours

Status always pairs colour with a word or a shape. Badges use a soft surface, a
1px border and the status text colour; they are never a solid saturated pill.
The single exception is the draft badge in a slot list, whose filled treatment
is there to pull the eye to unpublished work. It still carries the words
"Draft since".

## Typography

No webfont is loaded. The CMS is served from its own origin under a strict CSP,
so the stack is the system UI face (San Francisco on macOS, Segoe on Windows),
with `Geist` first for a host that installs it. Mono is the system mono stack.

| Role | Size / line | Weight | Notes |
|---|---|---|---|
| Page title | 24px / 1.25 | 600 | `letter-spacing: -0.02em`, one per page |
| Section heading | 16px / 1.4 | 600 | `h2`, groups and panels |
| Component heading | 14px / 1.4 | 600 | block legend, field group |
| Body | 14px / 1.6 | 400 | interface copy |
| Reading body | 15px / 1.65 | 400 | rich-text editing surface |
| Form label | 13px / 1.4 | 500 | `--text`, not muted |
| Helper / metadata | 12px / 1.5 | 400 | `--text-muted` |
| Table header | 12px / 1.4 | 500 | sentence case, muted; no uppercase tracking |
| Code / identifier | 12px / 1.5 | 400 | mono, `--surface-subtle` chip |
| Eyebrow / breadcrumb | 12px / 1.4 | 500 | `--text-muted` |

Uppercase is reserved for the 11px "group label" in the sidebar. No other
micro-label is uppercased.

## Spacing, sizing, radii

4px base scale: `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16,
`--space-5` 20, `--space-6` 24, `--space-8` 32, `--space-10` 40, `--space-12` 48,
`--space-16` 64.

- Sidebar width: `--sidebar-width` 248px; item height 32px; rail padding 8px.
- Top bar / mobile bar height: 56px.
- Content max width: `--content-max` 1120px; vertical padding 32px desktop.
- Control height: 32px default, 28px compact, 40px large. Icon button 32×32.
- Card padding: 16px (20px on large panels).
- Field gap: `--field-gap` (16px) between fields, 6px between a label, control,
  help and error.
- Table row height: 40–44px; cell padding 10px 12px.
- Radius: `--radius-sm` 6px (controls, badges), `--radius` 8px (cards,
  inputs, panels), `--radius-lg` 12px (dialogs, large overlays).
- Borders are 1px at `--border`; a focused or hovered control moves to
  `--border-strong`.
- Icons: 16px inline, 18px in the sidebar, 20px for the mobile toggle. Stroke
  width 1.75; no emoji, no mixed icon families.

## Elevation

`--shadow-sm` is for popovers and menus, `--shadow-lg` for dialogs. Nothing
else. There are no gradients, glass effects, coloured glows or animated
backgrounds.

## Components

### Buttons

One `.btn` base with explicit variants. Every variant has default, hover,
active, focus-visible, disabled and (where used) loading states.

| Class | Use |
|---|---|
| `.btn` / `.btn-secondary` | Default action: white/subtle surface, hairline border |
| `.btn-primary` | The one committing action in a region |
| `.btn-ghost` | Quiet action in a toolbar or nav |
| `.btn-danger` | Destructive confirm |
| `.btn-sm` / `.btn-lg` | 28px / 40px heights |

Icon-only buttons need `aria-label`. A button that navigates is an `<a>` with
`class="btn"`, never a styled `div`.

The legacy `.cms-save`, `.cms-publish-button`, `.cms-preview-button`,
`.cms-restore-button` and `.cms-delete-button` classes are kept where markup
tests pin them, and are styled through the same variant rules so they cannot
diverge.

### Form controls

Inputs, selects and textareas share one box: `--surface-subtle` background,
1px `--border`, 8px radius, 13.5px text, 32px height (`--control-height`,
textarea auto). In the page and slot editors every single-line input and select
is `--field-height` (44px) instead. Hover raises the border; focus uses a 3px
accent ring plus the border, never an outline that shifts layout. Placeholders
use `--text-muted` and never replace a label. Invalid controls use `--danger`
border and `aria-invalid`, with the message adjacent.

A choice row — a radio or checkbox wrapped in its own `label` — is one flex
row: `display: flex; align-items: center; gap: var(--space-2)`, with the
control's margin removed, so the control centres on its text and the row shares
the card's left edge. Group rows in a `.choice-group` fieldset, with one
`--space-2` gap between them.

**Decision (2026-10-30).** Every single-line input and select in the page and
slot editors uses `--field-height` (44px), so a text box, an image's alt input
and a link's text input are the same height; a textarea keeps its own height.
Fields are `--field-gap` (16px) apart, from one token, and a field's label,
control, help and error stay 6px apart.

### Page editor blocks

A block is a bordered card. Its 44px legend band is `--surface-subtle` across
the top, a hairline `--border` below, carrying "Block N · " in `--text-muted`
and the block type's **label** in `--text` at 13.5/500 — one heading, never the
developer slug and never a second type scale. The move and remove controls ride
at the right of the band.

**Add block** is the one action under the last block: full width of the blocks
column at `--field-height` (44px), on `--surface` with a dashed
`--border-strong` edge and a leading `+`, secondary-button hover and focus, and
a 13px label — not a 12.5px chip in a row of per-type buttons. It opens a menu of the
page type's allowed block types in their declared order, each item full width
and left-aligned at 13px, on `--surface` with `--surface-hover` for hover and
focus and no visible border of its own. The menu is a popover — `--surface`, a
hairline `--border`, `--radius` and `--shadow-sm` — and it opens **upward** from
the button: the editor's save bar is sticky over the bottom of the viewport and
would clip a downward menu at every width. The button carries `aria-haspopup`,
`aria-expanded` and `aria-controls`; the menu is `role="menu"` and its items
`role="menuitem"`. Arrow keys move, Enter picks, Escape closes and returns focus
to the button, and a click outside closes it.

A type the page already holds at its `max` is left out of the menu, and the
button is hidden when no type is left. There is no disabled item and no "off"
sentence: a limit is expressed by absence. The empty state, "This page has no
blocks yet. Add one below.", is muted 13px directly above the button.

### Image picker

A field that holds one library image: a bordered `--surface` row with a 75×56
thumbnail (or a `--surface-subtle` placeholder carrying the alt text when there
is no image), the alt at 13/500, the pixel size in muted 11.5px, then *Choose
image* and *Remove* — secondary and ghost, wrapping below the image at narrow
widths. The field's value is a hidden media id, so the row submits without
JavaScript.

*Choose image* opens the library dialog: `--surface`, `--radius-lg`,
`--shadow-lg`, at most 960px wide and the viewport tall; below 640px it fills
the width minus 24px, and the overlay scrolls rather than the page behind it.
The dialog runs top to bottom as drop zone, upload tiles, search, grid, status,
*Load more*. The drop zone is `--surface-subtle` with a dashed
`--border-strong` edge and turns `--surface-selected` on drag-over; each
uploaded file gets a row with a 4px progress bar in `--text`, a success border,
or the `--danger-soft` error surface with the handler's message. The grid is
`auto-fill minmax(min(9rem, 100%), 1fr)` (two columns below 640px); tiles carry
the 4:3 thumbnail, alt and size, and the selected tile is ringed in `--text` —
the primary button's foreground, not the accent, so selection stays monochrome.
Escape and Close leave the value unchanged. The dialog's fade and rise are
160ms and are removed under `prefers-reduced-motion`.

### Cards and panels

`.panel` is a bordered surface for a group of controls. `.panel-header` carries
a title and optional action. Cards are for content items, not for every
paragraph; plain sections with a heading and a divider are preferred when the
content does not need a boundary.

### Tables and lists

Collection pages use a compact table (`data-table`) or, where the markup is a
list with per-row actions, a row that reads as a table row: hairline separators,
40px height, title on the left, metadata and status on the right. Header cells
are muted sentence case. Numbers are tabular.

### Badges

`.badge` with `data-tone="success" | "warning" | "danger" | "neutral"`. Soft
surface, hairline border, 11.5px medium. Pairs with text, never colour alone.

### Alerts

One `.flash` banner, with `data-tone="success" | "info" | "warning" | "error"`.
Each tone is a soft tinted surface with a matching hairline border and icon
colour, built from the `--banner-<tone>-{bg,border,icon}` tokens (defined for
light, dark and System), and its own 20px line icon — circle-check, circle-i,
triangle-!, circle-! — so the four states are distinguishable without colour.
Title and detail use `--text` and `--text-secondary` on every tint. The banner
palette is separate from the badge's `--success-soft` and friends so the
designed tints stay exact in both themes.

A banner has a title (14/20, 600, ending in a full stop), and optionally a
detail line, a wrapping row of underlined action links (`margin-top: 8px`,
16px apart), and an error field list whose entries link to the invalid
control. The × is opt-in (`dismissible` on `Flash`, off by default) and only
a banner reporting the result of an action the editor just took — a save, a
publish, an upload, a copy — carries it. It is an icon-only button with
`aria-label="Dismiss"`, a 44×44 hit area and a negative block margin so it
does not make the banner taller. A banner with the button keeps `4px` right
padding, its hit area supplying the rest; a banner without one gets `14px` on
the right, to match the left.

Banners that describe the page's own state — no page types published, a page
type or slot no longer declared, a block type no longer published, a
cookie-failure on handoff or consent — never carry a ×: closing one would
leave the page empty, and a reload brings it back.

Success, info and warning are `role="status"`; error is `role="alert"`. In the
page and slot editors the banner sits inline below the title, above Blocks; on
other pages it stays where that page's notice already sat. A banner with a ×
stays until the × closes it — no auto-hide — and nothing is remembered across
loads; a state banner without one stays for as long as its state does. The ×
ships hidden and is revealed by the client script, so with JavaScript off the
banner still renders unchanged, just without a close button. There is no
shadow.

**Decision (2026-10-30).** The × is opt-in for banners that report the result
of an action; state banners have none, and take `14px` of right padding in its
place.

### Empty states

A bordered, centred block with a quiet title, one sentence of explanation and a
next action when one exists. Never a bare "No results".

### Loading

The CMS renders on the server, so a first paint is never a blank shell. There
are no skeleton screens for page loads. In-place actions communicate progress
through the disabled + label treatment on their own control. `prefers-reduced-
motion` removes all transitions.

## Application shell

Desktop (≥ 900px): a 248px navigation rail on the left and a scrolling content
column. The rail holds the brand, grouped destinations, and the account actions
pinned to the bottom. It has a hairline right border and the canvas colour, so
the surface-coloured content reads as the page.

Mobile (< 900px): the rail collapses to a 56px top bar with the brand and a
menu button. The panel drops below the bar at full width, rows are 44px, and
Escape or an outside click closes it. Without JavaScript the toggle stays
hidden and the panel is simply not shown; pages remain usable because the
content is reachable from the CMS home.

Every page has the same content hierarchy:

1. Breadcrumb (12px, one line, the final crumb is plain text).
2. Page title (24px) and a one-sentence description, or the editor's status.
3. Header actions on the right at the same baseline as the title.
4. The page body.
5. Publishing / metadata / pagination where the page has them.

Content is capped at 1120px and left-aligned inside the column; forms cap at
720px so lines do not run long. The page editor is the one two-column layout:
blocks in the main column, settings in a 320px aside, stacking below 1024px.

## Interaction states

- Hover: background step (`--surface-hover`) or border step; no movement.
- Active: one step darker than hover.
- Focus-visible: 2px `--accent` outline, 2px offset, on every interactive
  element. Mouse focus does not show the ring.
- Disabled: `--text-disabled`, 0.6 opacity on the control, cursor default, and
  `aria-disabled` where the control must stay focusable (list limits).
- Selection: `.is-selected` or `[aria-current="page"]` uses
  `--surface-selected` and primary text.
- Transitions: 120ms for colour and border, 160ms for panels. Reduced motion
  disables them.

## Responsive behaviour

- 1120px+: content max width, sidebar visible.
- 1024px: page editor columns collapse.
- 900px: sidebar becomes the top bar and panel.
- 640px: page padding 16px, header actions wrap under the title, tables and
  row lists reflow to two lines rather than scrolling horizontally, dialogs
  fill the width minus 24px.
- 320px: no horizontal overflow. Every long unbroken token (URLs, ids, emails,
  export tokens) wraps.

## Accessibility

- Semantic landmarks: `<nav>`, `<main>`, `<header>`, `aria-label` on each.
- A skip link is the first focusable element.
- Every form control has a label; icon-only controls have `aria-label`; groups
  use fieldset/legend.
- Errors are `role="alert"`, linked with `aria-describedby`, and repeated next
  to the field.
- Text and controls meet WCAG AA. Muted text is validated against both themes.
- Status is never colour alone.
- Keyboard order follows visual order; the mobile panel traps nothing and
  closes on Escape.
- `prefers-reduced-motion` is respected.

## Anti-patterns

- New hard-coded colours or a second palette in one page's CSS.
- Gradients, glassmorphism, glows, animated blobs.
- Shadows on cards or inputs.
- Uppercase tracked labels beyond the sidebar group label.
- Pills for everything; 999px radius outside true badges.
- Wrapping every block of content in a card.
- Placeholder controls, dead links, faux loading spinners.
- Replacing server-rendered forms with client-side application state.
- Hiding errors behind visual polish or relying on colour alone.
