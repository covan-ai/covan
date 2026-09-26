# Covan Application Design System

The application runs on the **Covan design system** — the warm, printed,
editorial surface documented in `DESIGN.md` alongside its reference
implementation (`index.html` + `styles.css` + `script.js`). **That file is the
contract. Read it before touching a component here.**

> The system's own scope note says it is for marketing pages, and that the
> product has a separate dark, blue-accented system. That is no longer true:
> the product was deliberately moved onto the same visual language so a visitor
> who signs up does not land in a different product. This file records what that
> move required — every place the application needs something a marketing page
> never has. Everything not listed here follows the system unchanged, and a
> deviation is a bug rather than taste.

## The three ideas, restated for the app

1. **Warm neutrals, one accent, no second accent.** Surfaces run
   `#f7f7f4` → `#eeede6` → `#e8e6dd` → `#ffffff` (raised), ink is `#251f19`, and
   the single saturated colour is amber `#f48d16`. The amber is a _pointer_: the
   send button, an active status chip, a selection square, a focus ring. If more
   than about five amber elements are in one viewport, or any is larger than
   44px, remove one. **The primary button is ink, not amber** — the amber lives
   in its 36px chip.
2. **Editorial typography, two families.** DM Sans (weight 500/600, `opsz 14`)
   does every display job: `h1`, `h2`, card and row titles, dialog titles, the
   wordmark. Geist does everything else: body, ledes, buttons, labels, chips,
   messages. They never swap — pick by role, not by size.
3. **Squares, not circles.** Bullets, marks, avatars, status indicators and
   selection markers are all squares. Circles appear only as window chrome (the
   three dots on a product panel). A round avatar is the fastest way to drift
   off-system, which is why `UserAvatar` and `AgentAvatar` are rounded squares.

## What the app adds, and why

| Extension                | Why the system has no answer                              | What we did                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Dark mode**            | The system is a light, printed surface with no dark theme | `.dark` in `src/styles.css` derives the same four-step ladder in reverse from the same ink, keeps the identical amber, and inverts only the button fill — the chip stays amber in both themes                |
| **Destructive actions**  | A marketing page has no "delete agent"                    | One `--destructive` token, muted, used for confirmation actions and engine-level failures only. Never for a chip: chips stay neutral-or-amber                                                                |
| **Small / icon buttons** | §6.3 forbids them; an app cannot avoid them               | The full chip-and-roller button is reserved for real CTAs (`default` / `secondary` at default size). `outline`, `ghost`, `link`, `sm`, `icon` render plain but on-system                                     |
| **Headline scale**       | 52px assumes one headline per screenful                   | Section headlines step down to 28/32px and page titles to 38/44px, and the app's working sizes below them are the ladder in **The type ladder**. Weight, leading, tracking and the italic turn are unchanged |
| **Row density**          | The system's rows are illustrations, not working lists    | `DataRow` keeps the §7.8 spec (10px radius, hairline border, canvas background inside a raised panel, `overflow-wrap: anywhere` on the title) at working density                                             |

## The type ladder

Ten steps, and a role for each. **Pick by role, never by how big the box
happens to be**, and never write a size as a literal at the call site — the
tokens live in `src/styles.css` and the `text-*` utilities come from them.

| Step  | Utility         | Family  | Role                                                    |
| ----- | --------------- | ------- | ------------------------------------------------------- |
| 12    | `text-xs`       | Geist   | eyebrows, timestamps, chips, keycaps                    |
| 13    | `text-meta`     | Geist   | supporting text: descriptions, subtitles, row meta      |
| 14    | `text-sm`       | Geist   | interface: nav, buttons, inputs, list rows              |
| 16    | `text-base`     | Geist   | reading: chat replies, ledes, legal prose — 1.6 leading |
| 18    | `text-title`    | DM Sans | card and row titles                                     |
| 22    | `text-title-lg` | DM Sans | dialog titles, auth and error card titles               |
| 28/32 | literal         | DM Sans | section headlines                                       |
| 38/44 | literal         | DM Sans | page titles                                             |

The one place a literal size is still right is a monogram inside an avatar
tile, which is sized by its tile rather than by its role: `text-[10px]` at 24
and 28px, `text-xs` at 36px and up.

What this replaced: the same role written three ways in three files — 17px and
18px card titles side by side, a 15px that was a row title in one file and a
paragraph in the next, and 9/10/11px picked per call site. If a new size feels
necessary, the role is probably one of the ten above.

## Where the primitives live

| Primitive                               | File                            | Use for                                                                           |
| --------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `PageContainer` / `PageHeader`          | `components/page-container.tsx` | page frame and the badge + two-tone headline + lede header                        |
| `Badge` / `Headline` / `SectionHeading` | `components/page-container.tsx` | the section grammar (§5): amber eyebrow, italic turn, split header                |
| `PanelEyebrow`                          | `components/page-container.tsx` | the 12px uppercase label inside a panel                                           |
| `SectionCard`                           | `components/section-card.tsx`   | a card on the canvas — surface step, 1px line, **no shadow**                      |
| `Panel`                                 | `components/section-card.tsx`   | a panel that genuinely floats: white, 20px radius, window-chrome bar              |
| `DataRow` / `Chip`                      | `components/section-card.tsx`   | the §7.8 workhorses; chip colour carries meaning                                  |
| `EmptyState`                            | `components/section-card.tsx`   | "nothing here yet", everywhere it happens                                         |
| `Disclosure`                            | `components/section-card.tsx`   | the sentence somebody needs once: a native `<details>`, closed, inside a card      |
| `UserAvatar` / `AgentAvatar`            | `components/avatars.tsx`        | people (neutral tile) and agents (neutral in lists, amber for the one you are in) |

## The five failure modes

Carried over verbatim, because they are the ones that actually happen:

1. A claim, number, logo, quote, or illustration the code cannot back.
2. A second accent colour introduced to distinguish two things.
3. Shadows on cards instead of a border and a surface step.
4. A child radius smaller than its parent's.
5. A hover-only mechanism with no keyboard or small-screen equivalent.

Radius ladder, since #4 is the easy one to get backwards: **4** chip · **8**
button · **10** row · **12** card · **14** bubble · **20** floating panel ·
**24** painted panel. A child inside a rounded parent takes one step _larger_.

## There is no marketing page here

This build ships no landing page. `src/routes/index.tsx` is a redirect: signed
in goes to `/app`, signed out goes to `/sign-in`. Every rule in this document
therefore applies to everything you will find in `src/` — there is no second
palette or type stack to keep out of the app's way.
