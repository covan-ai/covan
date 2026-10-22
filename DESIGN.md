# Covan Application Design System

The application is a **clean team tool**: white surfaces, lines between things,
one ink and one pointer colour, in the manner of the work tools it sits beside.
**This file is the contract. Read it before touching a component.** Everything
not listed here follows it unchanged, and a deviation is a bug rather than taste.

> This replaces the graphite system the app ran on until October 2026: a grey
> canvas with white cards on it, a 56px rail beside a 240px panel, an amber
> primary button, Settings as a card over the app and emoji for agents. The
> approved redesign (40 boards; the local copy lives outside the repository)
> keeps the graphite ink and the amber, and moves everything else toward a
> page somebody works in for hours: white, flat, dense, and identical from one
> screen to the next.

## 1. The six foundations

1. **White surfaces, lines between things.** The page is white. Things are
   separated by a 1px line, not by a card on a grey canvas. A border goes only
   around what truly stands apart: a stat, a chart, an ask card, a dialog. Grey
   is for the sidebar, wells, chips and the question bubble, and nowhere else.
2. **One shadow, the hairline one, and only on what floats.** The composer,
   the ask bar, menus, dialogs, toasts and the floating browser panel. Nothing
   else has a shadow; nothing glows; there are no gradients.
3. **Amber is a pointer.** The 8px status dot, the 2px focus ring and the
   breathing edge of the browser an agent is holding. Never text, never a fill
   larger than a dot, never a button. **The primary button is ink.**
4. **Radii 4 · 6 · 8 · 12.** 4 chip and checkbox · 6 button, input, tile, nav
   row · 8 row, menu, ask bar · 10 stat and chart card · 12 composer, dialog,
   question bubble. The browser panel is 14 and is the one exception. Nothing
   in the app is above 14.
5. **Heights 32 · 44 · 48.** 32 button, input and select · 44 list and table
   row · 48 top bar. Nothing on screen is smaller than 12px.
6. **Identity by shape.** Agents are ink marks on white tiles; workspaces and
   third-party apps are grey monogram tiles; people are round initials. No
   emoji anywhere in the interface. Every screen opens with work, not a
   greeting card: the ask bar, then what needs you.

## 2. The palette

All values live in `src/styles.css` and reach components only through the
semantic tokens. Never write a hex at a call site.

| Role                          | Light                 | Dark                  | Token                         |
| ----------------------------- | --------------------- | --------------------- | ----------------------------- |
| Page                          | `#ffffff`             | `#0f1012`             | `background`                  |
| Floating surface              | `#ffffff`             | `#151619` / `#1a1b1f` | `card`, `popover`             |
| Well, chip, bubble            | `#eeeef1`             | `#1e1f24`             | `surface`, `bubble`           |
| Hover of a well               | `#e4e5e9`             | `#222328`             | `surface-hover`               |
| Panel title bar, selected row | `#f6f6f8`             | `#121316`             | `surface-muted`               |
| Sidebar                       | `#f6f6f8`             | `#121316`             | `sidebar`                     |
| Active nav row                | `#e4e5e9`             | `#222328`             | `sidebar-accent`              |
| Hovered nav row               | `#eaeaee`             | `#1a1b1f`             | `sidebar-hover`               |
| Nav row text                  | `#3c3f47`             | `#c9ccd3`             | `nav-foreground`              |
| Ink, primary                  | `#15171c`             | `#ececef`             | `foreground`, `primary`       |
| Secondary text                | `#626671`             | `#9a9ca5`             | `muted-foreground`            |
| Eyebrows, axis labels         | `#6b6f7a`             | `#8a8e99`             | `micro-foreground`            |
| Chip text                     | `#4b4f59`             | `#c9ccd3`             | `chip-foreground`             |
| Monogram tile                 | `#e6e7eb` / `#3c3f47` | `#222328` / `#c9ccd3` | `tile`, `tile-foreground`     |
| Round initials                | `#dfe1e6` / `#3c3f47` | `#2a2b31` / `#c9ccd3` | `avatar`, `avatar-foreground` |
| Done dot, idle ring           | `#c9ccd3`             | `#3a3c44`             | `dot-done`                    |
| Chart bar, previous period    | `#4b4f59` / `#b7bac2` | `#b7bac2` / `#4b4f59` | `bar`, `bar-prev`             |
| Border                        | `#e2e3e7`             | `#26272d`             | `border`                      |
| Hairline between rows         | `#ebecef`             | `#1f2025`             | `hairline`                    |
| Input border                  | `#d7d9df`             | `#2d2e35`             | `input`                       |
| The pointer                   | `#f48d16`             | `#f59e2b`             | `brand`, `ring`               |
| Destructive (text only)       | `#b42318`             | `#f0695a`             | `destructive`                 |

Dark mode is the same ladder in reverse: the ink inverts, so the primary button
becomes a light fill with dark text, and the amber is one step lighter. Chart
bars swap: the current period is light, the previous one dark.

## 3. The type ladder

Geist is the only family. Roles are told apart by size and weight; there is no
second face, no italic device, no muted second clause in a headline, and
nothing above 24px. Pick by role, never by the size of the box, and never write
a size as a literal at the call site.

| Step | Utility         | Weight  | Role                                                                                                  |
| ---- | --------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| 12   | `text-xs`       | 500     | eyebrows (uppercase, `0.06em`), chips, keycaps, chart labels: the floor                               |
| 13   | `text-meta`     | 400–500 | descriptions, timestamps, row detail, sub-nav rows of an agent                                        |
| 14   | `text-sm`       | 400–500 | interface: nav, buttons, inputs, rows, table cells                                                    |
| 15   | `text-lead`     | 400–600 | the top-bar title, the question bubble, what you type into the composer or ask bar, the home sentence |
| 16   | `text-title`    | 600     | card, row and thread titles                                                                           |
| 16   | `text-base`     | 400     | reading: replies, documents, legal prose, at 1.6–1.65 leading                                         |
| 18   | `text-title-lg` | 600     | dialog, auth and error titles                                                                         |
| 20   | `text-xl`       | 600     | section and settings-page titles                                                                      |
| 24   | `text-2xl`      | 600     | the greeting and stat values, tracked `-0.02em`: the ceiling                                          |

A glyph sized by its box is not a type role: a monogram in a tile is 10–11px
at 16–24, 12px at 32, 14px at 36. Those are the only sizes under 12, and they
are letters on a tile, not text.

## 4. Controls

- **`Button`**: 32px tall, 6px radius, 14px medium. `default` is the ink fill
  and the one button a screen leads with. `secondary` is white with the input
  border. `ghost` is transparent with muted text, for toolbars and rows.
  `danger` is red **text** on a white button: never a red fill. `link` is
  inline. Sizes: `sm` 28px/13px, `icon` 32 square, `icon-sm` 28 square, `lg`
  36px for the auth cards only.
- **Inputs** match buttons: 32px, 6px radius, white, `border-input`, no shadow.
  A textarea is the same with 10px/12px padding and 1.55 leading.
- **`Select`** is a bordered button (`sel`): the value and a chevron, 32px.
- **Switch** is 32×18, ink when on, `input`-grey when off. **Checkbox** is a
  16px, 4px-radius square: ink with a white check when on, white with a
  `dot-done` border when off.
- **Chips** are 22px, 4px radius, 12px medium: `neutral` (surface grey) is the
  default label; `ink` marks the one thing that is yours or selected ("Owner");
  `code` is an id, a cron string, a file or model name in mono.
- **Filter pills** are 28px, 6px radius, 13px; the active one is ink with
  white text. A count rides inside the pill.
- **`StatusDot`** is 8px and has exactly five states (§12). It is never used
  for decoration and always sits beside a word or inside a labelled control.
- **`Kbd`** is 11px on white with the input border, 4px radius.
- **Focus** is a 2px amber outline offset 2px, on every interactive element,
  in both themes. No glow, no border change.
- **Continue with Google / GitHub** is a full-width `secondary` `lg` button
  with the provider's own mark at 18px. It is the one place a third-party mark
  sits outside `AppLogo`'s tile.

## 5. Identity

- **`AgentMark`** (`components/agent-mark.tsx`) is the agent's face: one of
  eight brush-drawn marks (headset, fox, owl, bear, cat, robot, penguin, blob)
  in the ink colour on a white tile with a 1px border. The mark fills 72% of
  the tile at every size. Sizes and radii: 16 (4) chip · 24 (6) sidebar and
  tables · 36 (8) headers, pickers in dialogs · 40 (10) inbox rows · 64 (12)
  the welcome picker. No mark picked, or an unknown one: the two-letter
  monogram on the same tile. Never an empty box, never a colour, never emoji.
- **`Avatar`** (`components/avatar.tsx`) is a person: round, initials on the
  `avatar` grey, or their photo. 20 in charts and tables, 24 in rows, 32–40 in
  headers, 64 on the profile page. `AvatarStack` overlaps them by 6px.
- **`Tile`** (`components/tile.tsx`) is a workspace or a source: a square
  monogram, `neutral` grey or `ink` for the workspace you are in.
- **`AppLogo`** renders a third party's own mark at half the width of the
  neutral tile it sits in (22 in 44, 18 in 36, 14 in 28); a mark that fails to
  load becomes a monogram, never a broken image.
- **`BrandLockup`** (`components/brand-mark.tsx`) is the ink "C" tile and the
  word "Covan". It appears on the auth pages, the welcome flow, the legal
  pages and nowhere inside the shell: inside the app the sidebar shows the
  workspace's tile, not ours.

## 6. The shell

`components/app-shell.tsx`, rendered once in `routes/_authed.tsx`:

- **The sidebar** is 248px, `sidebar` grey, a right border, 8px padding, 4px
  gaps. Top to bottom: the workspace switcher (36px: ink tile, name 14/600,
  up-down chevrons); Search (32px, muted, `Kbd ⌘K`); the pages (Home, Inbox
  with its unread count, Threads, Knowledge, Routines, Team) as 32px rows with
  a 16px icon; the eyebrow **Agents** with a 20px "+"; one 32px row per agent
  (`AgentMark 24`, name, and on the right an unread count or a running dot).
  The agent you are in expands in place: New thread, its eight newest threads
  as 30px rows indented to 40px with a dot each, and All threads. At the
  bottom: the credits row (hosted only: "1,240 credits · Buy more" and a 3px
  ink bar), Settings, and the account row (`Avatar 24`, name, chevrons).
  Active row: `sidebar-accent` and ink text; hover: `sidebar-hover`. Nothing
  else marks it.
- **The top bar** is 48px, white, a bottom border, 20px side padding. Its
  grammar: title (15/600, with an `AgentMark 24` inside an agent) · meta in
  13px muted · tabs (2px ink underline on the active one) · actions on the
  right, the primary one last. A child route fills its parent's bar through
  `TopBarPortal`.
- **Settings** is a page in the shell: the top bar says "Settings", a 220px
  sub-nav (30px rows, `surface` on the active one, eyebrows Workspace / My
  account / Help) and the page at 800px. Integrations live under Settings;
  Team is top level.
- **Below `lg`** the sidebar is a drawer behind a 56px bar that carries the
  page title and up to two icon actions; tables scroll inside the page; the
  settings sub-nav becomes a horizontal scroller.

## 7. Page grammar

| Primitive                 | File                                        | Use for                                                                                                  |
| ------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `TopBar` / `TopBarPortal` | `components/top-bar.tsx`                    | the 48px bar every page opens with                                                                       |
| `PageBody`                | `components/page.tsx`                       | padding 32px 40px; widths home 1120 · table 1160 · list 1000 · settings 800 · form and reading 760       |
| `SectionLabel`            | `components/section.tsx`                    | the 12px uppercase eyebrow (28px tall) with an optional link on the right                                |
| `SectionTitle`            | `components/section.tsx`                    | 20/600 page-section title with a 14px muted lede                                                         |
| `Field` / `FieldStack`    | `components/field.tsx`                      | a settings row: 220px label column (14/500 + 13px help), 24px gap, 20px vertical padding, hairline below |
| `DataTable`               | `components/data-table.tsx`                 | 36px uppercase header on a border, 44px rows on hairlines, numbers right-aligned and tabular             |
| `Row`                     | `components/list-row.tsx`                   | the 44px list row: leading mark, title 14/500, meta 13px muted                                           |
| `Pills`, `Segmented`      | `components/pills.tsx`, `segmented.tsx`     | filters above a list                                                                                     |
| `StatCard`                | `components/stat-card.tsx`                  | label 13px muted, value 24/600, detail 13px, 10px radius, border                                         |
| `BarChart`, `HBarList`    | `components/bar-chart.tsx`, `hbar-list.tsx` | the two chart forms; bars in `bar`, previous period in `bar-prev`, 4px data ends, ink tooltip            |
| `EmptyPage`, `EmptyWell`  | `components/empty-page.tsx`                 | nothing here yet: a sentence and one action; a dashed well for a drop target                             |
| `Disclosure`              | `components/disclosure.tsx`                 | the sentence somebody needs once: a native `<details>`, closed                                           |

Lists are grouped under date eyebrows (Today, Yesterday, a weekday, Earlier).
A row's title takes `overflow-wrap: anywhere` when it can carry a filename.

## 8. The conversation

- **The title line** sits inside the transcript, not in the bar: the thread
  title 16/600 and "Started by you · 12 min ago · Private" in 13px muted, a
  hairline under it.
- **The question** is the only thing in a bubble: `bubble` grey, 12px radius,
  10px/14px padding, 15/1.5, right-aligned, 80% max width.
- **A reply** is a short document: 16px prose at 1.65 leading, 16px between
  blocks, no bubble. Sources follow as `code` chips after the word "Sources".
- **The step line** is one muted 13px toggle above the reply, "› Searched
  Knowledge · 3 sources · 6 s", that opens the trail. While a turn is running
  it reads "step N · reading pages" with a running dot.
- **The ask card** is how an agent asks: a bordered 10px box, the waiting ring
  dot, "Support is asking you" in 14/500, the question in muted text, then the
  primary answer and the secondary one as buttons.
- **The composer** is a 12px-radius white box with the input border and the
  hairline shadow; the text on top (15px, "Reply to Support…"); under it `+`
  and the microphone on the left, the Model chip, the Thinking chip and the ink
  Send square on the right. While a reply is being written a `secondary` Stop
  replaces Send. Under the composer, centred, 12px: "Enter to send · Shift +
  Enter for a new line".
- **The browser beside the thread** is a 580px panel, 14px radius, the floating
  shadow and a 1px amber edge that breathes while the agent holds it; a 44px
  header (running dot, "Finance is browsing", the URL, Take over, close) and a
  36px footer (step, saved sign-in, timer).
- **A document beside the thread** has a header strip (title, agent chip,
  folder chip, Open in Knowledge, Print, Download, close), the page on a
  `surface-muted` frame, and a footer line (who wrote it, what it cost, what it
  read).

## 9. Knowledge, Routines, Team, Settings

**Knowledge** is a file manager: a full-bleed white window with a 240px column
(Folders with counts, Sources with their sync state, "Add a source", the drop
hint), the contents as a table (Name, Kind, Size, Added by, Modified, Used by)
and a 36px status line along the bottom. The pane is the drop target. A bundle
is called a folder on screen and nowhere else.

**Routines** is a list beside a detail: a 340px pane (48px header, pills, one
item per routine with its agent, schedule prose, last or next run and a dot)
and the selected routine on the right (Schedule, Instructions, Delivers to,
Recent runs). Creating or editing a routine is a page, never a dialog.

**Team** is a page of three tabs (Members, Invitations, Roles) under one top
bar. Per-person numbers are counts only, never titles or contents.

**Settings** pages are `SectionTitle` + `Field` rows + eyebrow groups. A
destructive field ends the page and its button is red text.

## 10. Dialogs and menus

A dialog is one box: white, 12px radius, the border, the floating shadow.
Widths `sm` 420 · `md` 520 · `lg` 640, full width below `sm`. Header: title
18/600 left-aligned (with an `AgentMark` or icon when it is about one thing) and
a ghost close button. Body: 14px with 14px between blocks. Footer: buttons on
the right, the primary one last; a destructive confirmation is a `danger`
button, red text. Menus are 8px-radius boxes with 6px padding and 36px items;
an eyebrow may head a group; the footer may carry one 12px sentence.

## 11. Empty states, errors, banners, toasts

- **Empty**: one sentence saying what will appear here and one or two actions;
  a status dot where it helps ("Nothing needs you", grey). A drop target is a
  dashed well. Never an illustration.
- **Errors**: "There is nothing here" for a missing page and "Something went
  wrong on this page" for a crash, each with two actions and, for a crash, the
  request id as a `code` chip with Copy. A crash inside the app keeps the
  sidebar.
- **Banners** sit at the top of the main column, under nothing: an invitation
  (44px, sidebar grey, Accept / Ignore), low credits (36px, waiting dot, Buy
  credits), offline (Retry). One line each; they never stack more than two.
- **Toasts** are ink with white text, bottom right; an error toast is white
  with a red word. An undo lives in the toast that announced the change.
- **The coach mark** is a small floating panel with an eyebrow ("Try · 2 of
  5"), one sentence, Got it / Skip the tour and `Kbd esc`.

## 12. Motion and live state

The five states of a dot, everywhere:

| State   | Mark                                | Means                    |
| ------- | ----------------------------------- | ------------------------ |
| running | filled amber, breathes (`dot-live`) | an agent is working      |
| waiting | amber ring                          | waiting on you           |
| done    | filled `dot-done`                   | finished                 |
| idle    | `dot-done` ring                     | nothing going on         |
| failed  | filled red                          | it stopped with an error |

Fill against ring is the distinction, and it survives with motion switched
off. Colour and opacity move on the standard curve over 150–200ms; transforms
on the spring curve; nothing bounces. The browser's amber edge breathes
(`browser-live`) only while an agent holds it. Every animation is listed in the
`prefers-reduced-motion` block of `styles.css` and every base state reads
correctly without it.

## 13. Dark mode

Every token has a dark value (§2). The sidebar goes to `#121316`, the page to
`#0f1012`; an agent's tile is the page colour with the dark border and a light
mark; the primary button is the light ink with dark text; amber is `#f59e2b`.
Check every new screen in both themes.

## 14. The six failure modes

1. A claim, number, logo, quote, or illustration the code cannot back.
2. Amber as a fill, as text or on a button; a second accent colour.
3. A shadow on something that does not float, a glow, a gradient, two shadows.
4. A radius above 12 (except the browser panel's 14), or a child radius
   larger than its parent's.
5. Text under 12px, a control that is not 32 / 44 / 48 tall without a reason
   written here, or a hover-only mechanism with no keyboard or small-screen
   equivalent.
6. An emoji, a second typeface, an italic device, or a size above 24px.

## There is no marketing page here

This build ships no landing page. `src/routes/index.tsx` is a redirect: signed
in goes to `/app`, signed out goes to `/sign-in`. Every rule in this document
therefore applies to everything you will find in `src/`.
