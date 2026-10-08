# Third-party notices

Covan is distributed under FSL-1.1-ALv2 (`LICENSE`). Some files in this
repository are derived from third-party projects published under the MIT
licence. MIT permits redistribution under other terms and requires only that
the copyright notice and permission notice survive in the copies. This file is
where they survive.

Nothing here changes the licence of Covan's own code, and nothing in Covan's
licence changes the terms below for the files they cover.

---

## shadcn/ui

- Project: https://ui.shadcn.com — https://github.com/shadcn-ui/ui
- Licence: MIT
- Copyright (c) 2023 shadcn

**Files derived from it:** everything under `src/components/ui/`. Several are
heavily rewritten against this repository's own design system — `button.tsx`
most of all, which carries a chip-and-roller treatment shadcn/ui has no notion
of — and `src/components/ui/reachable.test.ts` is entirely ours. The rewriting
changes nothing about the obligation: the files started as copies and the
notice is owed.

These files predate this notice. The gap is closed here rather than argued
about.

## prompt-kit

- Project: https://www.prompt-kit.com — https://github.com/ibelick/prompt-kit
- Licence: MIT
- Copyright (c) 2025 Julien Thibeaut

**Files derived from it:** everything under `src/components/prompt-kit/`. Each
file opens with a header naming the upstream component it was copied from and
recording every local edit and the reason for it. Read that header before
re-copying anything from upstream: the edits are not drift, and at least one of
them (`prompt-input.tsx`'s keyboard ordering) is load-bearing for input-method
composition and for the mobile composer.

---

## The MIT licence, in full

Both notices above are governed by the same text.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
