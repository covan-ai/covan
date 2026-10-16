# Covan Application Design System

The application runs on the **graphite** system: a cool, neutral, product-grade
surface in the manner of a serious work tool, not a marketing page. **This file
is the contract. Read it before touching a component.** Everything not listed
here follows it unchanged, and a deviation is a bug rather than taste.

> This replaces the warm, printed, editorial system the app used to share with
> the marketing site. That system was built for one headline per screenful and
> a reader who is browsing; the app is read for hours by somebody who is
> working, and its amber button chips, italic turns, square bullets and window-chrome
> panels read as a toy next to the tools it sits beside. Every rule below was
> chosen to make the app look **settled**: dense enough to work in, quiet
> enough to stay out of the way, and consistent enough that nothing on screen
> asks to be looked at twice.

## 1. The four ideas

1. **Neutral surfaces, one ink, one pointer colour.** The canvas is a quiet
   grey (`#f6f6f8`), a card is white on it, and the ink is graphite
   (`#15171c`). The single saturated colour is an amber (`#f48d16`), and it
   is a _pointer_: a focus ring, a selected dot, a live indicator, an "on"
   chip's text, and the primary button. **The primary button is amber with ink
   text; everything else is ink or grey.** If more than a handful of amber elements are in one
   viewport, or any is larger than a button, remove one.
2. **One face, told apart by weight.** Geist does everything — display,
   interface, body. A headline is the same face one weight up (600) and
   tracked tight (`-0.02em`); a card title is 16px semibold; interface text is
   15px medium; reading text is 16px at 1.6 leading. Nothing on screen is smaller than 13px. There is no second family,
   no italic device and no display size above 24px.
3. **Depth is a line and one step, then a shadow only for what floats.** A
   card is white on the grey canvas with a 1px border and the hairline shadow
   (`shadow-xs`). A menu, a dialog, the composer and a product panel float, and
   they take the one floating shadow (`shadow-card`). Nothing glows, nothing
   has a gradient, and no two shadows stack.
4. **Small radii, concentric corners.** The ladder is **4** chip · **6** button,
   input, avatar tile · **8** row, menu · **10** card · **12** dialog · **14**
   floating panel · **16** painted panel, question bubble · **20** the composer
   and nothing else. A child inside a rounded parent takes one step _larger_,
   never smaller. Dots and progress bars are round; tiles and avatars are
   rounded squares.

## 2. The palette

All values live in `src/styles.css` and reach components only through the
semantic tokens (`bg-card`, `text-muted-foreground`, `border-hairline`,
`bg-brand`, …). Never write a hex at a call site.

| Role                             | Light     | Dark      | Token                |
| -------------------------------- | --------- | --------- | -------------------- |
| Canvas                           | `#f6f6f8` | `#0f1012` | `background`         |
| Card, popover (raised)           | `#ffffff` | `#151619` / `#1a1b1f` | `card`, `popover` |
| Inset well, code chip            | `#eeeef1` | `#17181c` | `surface`            |
| Hover of a well                  | `#e8e8ec` | `#1e1f24` | `surface-hover`      |
| Question bubble                  | `#eeeef1` | `#1c1d22` | `bubble`             |
| Sidebar                          | `#f0f0f3` | `#121316` | `sidebar`            |
| Ink                              | `#15171c` | `#ececef` | `foreground`, `primary` |
| Secondary text                   | `#626671` | `#9a9ca5` | `muted-foreground`   |
| Micro labels, eyebrows           | `#8a8e99` | `#6e717b` | `micro-foreground`   |
| Card border                      | `#e2e3e7` | `#26272d` | `border`             |
| Row hairline                     | `#ebecef` | `#1f2025` | `hairline`           |
| Input border                     | `#d7d9df` | `#2d2e35` | `input`              |
| The pointer colour               | `#f48d16` | `#f59e2b` | `brand`, `ring`      |
| Destructive                      | `#b42318` | `#f0695a` | `destructive`        |

Dark mode is the same ladder in reverse, with the ink inverted and the amber
one step lighter. The primary button inverts with the ink; the amber keeps its
role.

## 3. The type ladder

Eight steps, and a role for each. **Pick by role, never by how big the box
happens to be**, and never write a size as a literal at the call site — the
tokens live in `src/styles.css` and the `text-*` utilities come from them.

| Step | Utility         | Weight   | Role                                                    |
| ---- | --------------- | -------- | ------------------------------------------------------- |
| 13   | `text-xs`       | 500–600  | eyebrows (uppercase, `0.06em`), timestamps, chips, keycaps |
| 14   | `text-meta`     | 400      | supporting text: descriptions, subtitles, row meta      |
| 15   | `text-sm`       | 400–500  | interface: nav, buttons, inputs, list rows              |
| 16   | `text-title`    | 600      | card and row titles                                     |
| 16   | `text-base`     | 400      | reading: chat replies, ledes, legal prose — 1.6 leading |
| 18   | `text-title-lg` | 600      | dialog titles, auth and error card titles               |
| 20   | `text-xl`       | 600      | section headlines (`Headline`)                          |
| 24   | `text-2xl`      | 600      | page titles (`Headline as="h1"`)                        |

A headline may carry a second clause (`turn`) in the muted display grey. It is
the same face and weight on the same line, so the two halves read as one
sentence with its emphasis in the first half. Use it on roughly two-thirds of
headings; if every one has it, the device stops registering.

The one place an off-ladder size is still right is a glyph sized by the box it
sits in — a monogram inside an avatar tile (`text-[10px]` at 24–28px, `text-xs`
at 36px and up), an emoji in a tile (`text-lg` in a 36–40px tile, `text-3xl` in
the 64px one the empty chat opens with). Neither is a type role.

## 4. Buttons and controls

- **`Button`** is plain: 36px tall, 6px radius, 14px medium label, nothing
  inside it that moves. `default` is the amber fill and the one button a screen
  leads with; `secondary` is white with a border beside it; `outline` and
  `ghost` are the quiet ones for toolbars and rows; `destructive` is the muted
  red for the confirming action in a dialog and nowhere else. `sm` is 32px and
  `icon` is a 36px square.
- **Inputs** match buttons: 36px, 6px radius, white, `border-input`, hairline
  shadow. A textarea is the same at its own height. Placeholders are the micro
  grey.
- **Focus** is a 2px amber ring offset 2px from the control, on every
  interactive element, in both themes. No glow, no border change.
- **Switch** is a round pill; on is amber. **Checkbox** is a 4px square; checked
  is ink.
- **Chips** carry meaning by tone: neutral grey = off, pending, coming soon;
  `on` = the amber fill with ink text; `ink` =
  the one thing you are in; `code` = an id, a cron string, a model name in
  mono. There is no red chip.
- **Selection** is marked by a dot, not a square: 8px, round, amber when on
  and `border`-coloured when off. The row you are on in a nav is marked by its
  background alone.
- **Send** is an amber square at icon size, the primary button at icon size,
  and the brand mark is the bare logo in the ink colour, with no tile.

## 5. Page grammar

| Primitive                               | File                            | Use for                                                                                   |
| --------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `PageContainer` / `PageHeader`          | `components/page-container.tsx` | page frame (40px vertical padding) and the eyebrow + headline + lede header               |
| `Badge` / `Headline` / `SectionHeading` | `components/page-container.tsx` | the section grammar: muted uppercase eyebrow, 20/24px headline, muted second clause       |
| `PanelEyebrow`                          | `components/page-container.tsx` | the 12px uppercase label inside a panel                                                   |
| `SectionCard`                           | `components/section-card.tsx`   | a card on the canvas — white, 1px line, 10px radius, hairline shadow                      |
| `Panel`                                 | `components/section-card.tsx`   | a panel that genuinely floats: white, 14px radius, a line, the floating shadow, a plain title bar |
| `DataRow` / `Chip`                      | `components/section-card.tsx`   | the list workhorses; chip tone carries meaning                                            |
| `EmptyState`                            | `components/section-card.tsx`   | "nothing here yet", everywhere it happens: a dashed well                                  |
| `Disclosure`                            | `components/section-card.tsx`   | the sentence somebody needs once: a native `<details>`, closed, inside a card             |
| `UserAvatar` / `AgentAvatar`            | `components/avatars.tsx`        | people and agents on 6px tiles — neutral in lists, ink for the one you are in             |
| `AppLogo`                               | `components/integrations/app-logo.tsx` | a third party's own mark in the neutral tile, with a monogram when it does not load |

The **eyebrow** (`Badge`) is a label, not a pointer: 12px, uppercase, muted.
The **shell** (`components/app-shell.tsx`) is two columns on the sidebar grey
and no header strip. The 56px **rail** holds the brand, then search, settings
and the account; nothing on it changes. The 240px **panel** beside it changes
with where you are: inside an agent it is the agent's name, New thread, its
pages and its threads; on a workspace page it is the workspace switcher, the
pages and the agents as plain rows (emoji and name, never a face); threads
are listed only under the agent they belong to. Both end in credits and Send feedback. The
active row has the sidebar-accent background and nothing else; the panel
collapses from the rail. Below `lg` the two columns are one drawer behind a
56px bar that says where you are.

**Settings** is a card over the app, not a page in it (`routes/_authed.settings.tsx`):
the canvas dims, a 1180px card with a 240px column on the left (Back to app, the
heading, the pages under Workspace / My account / Help) and the page on the
right. Escape, Back to app and the dimmed canvas all close it.

The **front door** is the same on the home page and an empty thread: "Hi, I'm" the agent
(its name in amber, no emoji), "What can I do for you this
morning?" at 28/34px semibold, one muted line, then the composer with a round
amber send button.

A **reply** is a short document, not a message: 16px prose at 1.65 leading with
16px between blocks, headings a step up with more air above than below, lists
at 1.5 spacing, and no bubble around any of it. The **question** is the only
thing in a bubble (`bubble`, 16px radius, 80% max width, right-aligned). The
**composer** is a 20px-radius white box: the text on top with the row of
controls under it — attach, report, dictate on the left; the turn dial and the
round amber Send on the right. Its placeholder says "Reply to {agent}" once
the thread has a message in it.

**Knowledge** is a file manager, not a page about files (`knowledge-explorer.tsx`):
one window with a toolbar (Back, the path, search, list/grid, Upload), a 240px
column of folders down the left, the contents in the middle and a status line
along the bottom. The root shows the folders as folders; opening one shows its
files with a kind icon each. The pane is the drop target. A bundle is called a
folder on screen and nowhere else. The workspace page has no heading over the
window; the toolbar already says where you are.

## 6. Rows and density

`DataRow` is a 14px medium title over a 13px meta line, 12px of vertical
padding, an 8px radius and a hairline border, sitting on the canvas colour
inside a white card so it reads as a well. `overflow-wrap: anywhere` on the
title is not optional: these rows carry filenames.

A third-party logo renders at half the width of the neutral tile it sits in and
nowhere else (`AppLogo`): 22px in 44, 18px in 36, 14px in 28, and 44 is the
ceiling. A mark that fails to load becomes a monogram, never a broken image.

## 7. Motion and live state

- Colour and opacity move on the standard curve over 150–200ms; transforms and
  heights on the spring curve. Nothing bounces.
- The step that is running is a round 8px mark with an amber outline and a fill
  that sweeps through it (`.step-running`); a filled amber dot means "this one
  is waiting on you". Outline against fill is the distinction, and it survives
  with motion switched off.
- The browser beside a conversation, while an agent holds it, has a 1px amber
  edge that breathes (`.browser-live`). It is the one amber element allowed
  over chip size, and it is a hairline, never a glow or a fill.
- Every animation is switched off under `prefers-reduced-motion`, and every
  base state reads correctly without it.

## 8. The six failure modes

1. A claim, number, logo, quote, or illustration the code cannot back.
2. A second accent colour introduced to distinguish two things, or amber used
   as a fill.
3. A shadow on a card, a glow on anything, or two shadows stacked.
4. A child radius smaller than its parent's, or a radius above 16px.
5. A hover-only mechanism with no keyboard or small-screen equivalent.
6. A second typeface, an italic device, or a display size above 24px.

## There is no marketing page here

This build ships no landing page. `src/routes/index.tsx` is a redirect: signed
in goes to `/app`, signed out goes to `/sign-in`. Every rule in this document
therefore applies to everything you will find in `src/`.
