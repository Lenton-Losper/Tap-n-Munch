# Design: a copy registry (Option C) — design only, not built

**Filed:** 2026-08-28. Fixes the CLASS of defect Option A's marker fixes one instance of: a
provisional string that reads as finished and carries no marker at all is invisible to any gate
that only scans for a marker. 31 such strings shipped to terminal staff across three builds
because nothing forced a string to be *registered* before it could render — the gate could only
ever catch what opted in.

Applies to either repo carrying this convention (this session found and signed strings under the
same discipline tonight — `lib/menu/availability-copy.ts`, `lib/stations/copy.ts`); the 31-string
incident that motivates it lives in the terminal repo, outside this session's access.

## The shape

1. **One registry per surface**, typed, e.g. `lib/menu/availability-copy.ts` already *is* one —
   `export const MENU_AVAILABILITY_COPY = { button: '...', title: '...', ... } as const`, and the
   route/component reads `MENU_AVAILABILITY_COPY.button`, never a literal.

2. **A union of signed keys**, generated or hand-maintained per registry:
   ```ts
   type SignedCopyKey = keyof typeof MENU_AVAILABILITY_COPY | keyof typeof STATION_COPY | ...
   ```

3. **The build fails on an unregistered string literal in a render path.** Not a runtime check —
   a static one, in the same family as `check-nocheck-imports-resolve.mjs` and
   `check-menu-copy-sourced.mjs` already wired into `production-worker.yml` tonight. Walks JSX
   text nodes and string-typed props (`title=`, `label=`, button children, etc.) under whatever
   directory the convention covers, and fails any that is not a member access on a registered
   registry object — `MENU_AVAILABILITY_COPY.button` passes, `'Mark unavailable'` written inline
   does not, regardless of whether it carries a `PENDING COPY:` prefix.

## Why this is stronger than Option A alone

Option A (the marker the gate can see but a reader cannot) still depends on the AUTHOR remembering
to mark a string provisional. A string that was written to look finished — because someone forgot,
or because it seemed obviously fine — carries no marker and is invisible to a marker-scanning gate
by construction. That is exactly the 31-string incident.

A registry-and-union check does not ask "did this string remember to announce itself." It asks
"is this string a member of something that was registered at all" — an unregistered literal fails
whether or not anyone thought to flag it, which is the same shift `check-menu-copy-sourced.mjs`
already made for `app/menu/**` specifically (source every string from `lib/customer-copy`, no
exceptions, no opt-in). This generalizes that pattern rather than inventing a new one.

## Cost, stated plainly, so this is not treated as free

- Every render-path string literal in scope needs to already be a member of a registry before this
  can be switched on, or the check starts red across the whole existing surface. `check-menu-copy-
  sourced.mjs`'s own history names this: "188 call sites were moved to lib/customer-copy before
  switching it on, so it starts green rather than starting with a backlog nobody will clear."
- The checker itself has to walk JSX correctly (text nodes, several prop shapes, template
  literals with no interpolation) without false-positiving on genuinely non-copy strings (CSS
  class names, `data-testid` values, aria attribute keys). `check-menu-copy-sourced.mjs` and the
  `@ts-nocheck` name-resolution checkers already solved equivalent parsing problems in this repo;
  this is not a new class of problem, but it is real work, not a config flag.
- Scope has to be decided per surface (which directories/components this applies to) before
  wiring it in -- applying it repo-wide on day one is how a good idea starts red and stays
  ignored, the exact failure `check-menu-copy-sourced.mjs`'s own docblock warns against.

## Not attempted here

No implementation, no wiring into CI, no scope decision. This is the shape only, per the
instruction that item 9/10-class work in tonight's queue is design, not build.
