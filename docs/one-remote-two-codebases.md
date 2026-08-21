# One remote, two codebases

**The React Native terminal app and the Next.js web app push to the same GitHub repository, with
disjoint histories.** This is deliberate as of the 2026-08-21 ruling (#319, option A: record it
rather than split it). It is written down because it is invisible until it bites, and it bites in
ways that look like something else.

```
C:\RN\FlashTapTerminal          origin -> Lenton-Losper/Tap-n-Munch.git   (React Native terminal)
Desktop\mvp\...                 origin -> Lenton-Losper/Tap-n-Munch.git   (Next.js web app)
```

`git log --all --max-parents=0` in the **terminal** clone returns **three root commits**, one of
them titled *"Initialized repository for chat Restaurant menu screen"* — a web-app root sitting in a
terminal clone's history. That is the tell.

## What it costs, measured

- **`git fetch --all` in either clone pulls the other's branches.** The terminal clone sees ~199
  branches, including `sprint/qr-state`, `docs/adr-setup` and every `wt/*` worktree branch from the
  web side.
- **History-wide searches traverse both projects.** `git log --all -S'…'` in the terminal repo
  walks web-app commits and vice versa. #149's search stayed correct, but by luck rather than by
  construction — a `-S` hit in the *other* project reads exactly like a hit in yours.
- **Issue numbers are shared.** `#318`, `#164`, `#163`, `#162`, `#161`, `#148`, `#137`, `#136`,
  `#230`, `#231` and `#181`–`#184` are terminal issues in the same tracker as the web ones. That is
  actually convenient and is part of why splitting is not urgent.

## Working with it

- **Scope every history-wide search.** Prefer `git log <ref>..<ref>` or a pathspec over `--all`. If
  you must use `--all`, check that each hit's file path belongs to the project you are in.
- **Never assume a branch you can see is yours.** Branch names do not carry a project prefix.
- **`git worktree list` in one clone will not show the other's worktrees.** Worktrees are per-clone
  even when the remote is shared, so this is one place the two genuinely do not interfere.
- **A commit in one project cannot break the other's build**, because the histories never meet.
  This is why the situation is tolerable: it is a discovery and search problem, not a correctness
  one.

## Why not split (yet)

Splitting is the real fix and it is option B, deferred. It costs about a day and it touches:

- every terminal clone's remote,
- the APK build path,
- and issue references across both trackers, which have to keep resolving.

The measured cost today is confusion during searches. That does not justify a day, and it does not
justify doing it in a week where a new venue is opening. **Revisit when the terminal next needs its
own release cycle** — that is the point at which a shared remote stops being merely confusing and
starts constraining tagging and release automation.

Ruled 2026-08-21. Recorded per #319.
