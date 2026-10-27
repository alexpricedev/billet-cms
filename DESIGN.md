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
Both themes are defined; the CMS follows the operating system setting through
`prefers-color-scheme` (there is no in-app toggle, so no control can drift from
the rendered theme).

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
- Field gap: 16px between fields, 6px between a label, control, help and error.
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
1px `--border`, 8px radius, 13.5px text, 32px height (textarea auto). Hover
raises the border; focus uses a 3px accent ring plus the border, never an
outline that shifts layout. Placeholders use `--text-muted` and never replace a
label. Invalid controls use `--danger` border and `aria-invalid`, with the
message adjacent.

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

Classes kept for compatibility: `.flash-success`, `.flash-warning`,
`.flash-error`. Each is a soft surface with a matching border and text, a
leading status label, and no shadow. They appear directly under the page header.

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
