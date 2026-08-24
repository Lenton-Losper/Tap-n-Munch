# Contributing — database safety

## Linked Supabase CLI commands (mandatory guard)

**Never run these directly** (by hand, in scripts, or via agents):

```bash
supabase db query --linked ...
supabase migration repair --linked ...
```

These commands target whatever project is in `supabase/.temp/linked-project.json`, which is **independent** of `.env.test` / `.env.production.local`. A staging env check in a script does **not** protect `--linked` commands.

### Always use the guarded wrapper

```bash
npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> db query --linked ...
npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> migration repair --linked ...
```

Or on Unix:

```bash
./scripts/safe-db.sh <expected-project-ref> db query --linked ...
```

### Project refs

| Environment | Ref |
|-------------|-----|
| Staging | `mdqjpxwczrhkxkbqatqa` |
| Production | `ihlmmpmolnpchzgwyhgh` |

### What the guard does

1. Requires an explicit `expected-project-ref` argument (no default).
2. Reads `supabase/.temp/linked-project.json` **immediately before** running the CLI command.
3. **Aborts** (non-zero exit, clear error) if `ref` ≠ `expected-project-ref`.
4. Only allows `db query --linked` and `migration repair --linked`.
5. Appends an audit line to `supabase/.temp/safe-supabase-linked-audit.log` on success.

### Before any linked DDL

```bash
npx supabase link --project-ref <expected-project-ref>
# optional: cat supabase/.temp/linked-project.json
npx tsx scripts/safe-supabase-linked.ts <expected-project-ref> db query --linked -f ...
```

### TypeScript scripts

Import and call `runSafeSupabaseLinked` from `scripts/lib/safe-supabase-linked.ts` instead of shelling out to raw `supabase db query --linked`.

# Contributing -- git worktrees on Windows

## Never run `git worktree remove` directly. Use the wrapper.

    powershell -File scripts/worktree-teardown.ps1 -Path ../i220 [-Force]

`git worktree remove` **descends into an NTFS junction instead of unlinking it** and recursively
deletes the contents of the target. Measured on this repo, git 2.51.2.windows.1: a junction target
went from 7 entries to 0, the command exited **0**, and nothing in its output mentioned
`node_modules`.

On 2026-08-11 that destroyed roughly 530 packages in the shared install -- `jest`, `next`,
`eslint`, `react` -- while other agents were running tests against it.

**The deletion is not the real cost; it is recoverable.** The cost is the window before anyone
notices, during which every `jest` / `tsc` / `eslint` result is unreliable, and any *baseline*
measured in it is silently wrong. A corrupted baseline makes a real regression look like a wash,
or a clean branch look broken.

## Why the junction exists, and why it must stay

A fresh worktree has no `node_modules`. Without one, `npx tsc --noEmit` does **not** fail --
`npx` silently downloads and runs `tsc@2.0.4`, which exits 0 on essentially any input. That is a
false green on the most load-bearing gate there is.

So the setup is:

    cmd /c mklink /J "<worktree>
ode_modules" "<repo>
ode_modules"
    node node_modules/typescript/bin/tsc --version    # must print 5.9.3 before you trust a gate

The junction is the fix for a worse problem. **Removing the practice is not the answer -- the
ordering is.**

## If you tear one down by hand anyway

1. Drop the link **link-only**: `cmd /c rmdir "<worktree>
ode_modules"`.
   Never `Remove-Item -Recurse` and never `rm -rf` -- both follow the junction, which is the
   defect wearing different clothes.
2. `git worktree remove <worktree>`
3. `git worktree prune`

## If it has already happened

`npm ci`, then **re-run the entire gate** on the restored toolchain. Do not report a result
measured in the damaged window; re-measure it.

## Confirming the hazard on your own git version

Do not take this file's word for it:

    powershell -File scripts/worktree-teardown.ps1 -Path <throwaway> -Force -SimulateUnsafeRemoval

That skips the unlink on purpose and reports the damage. Point it at a throwaway worktree
junctioned to a throwaway directory -- never at the real `node_modules`.

# Contributing -- one remote, two codebases

**The React Native terminal app and this Next.js web app share one GitHub remote, with disjoint
histories.** `git fetch --all` in either clone pulls the other's ~199 branches, and
`git log --all -S'…'` searches both projects at once — so a hit can belong to a codebase you are
not in.

Scope history-wide searches with a ref range or a pathspec rather than `--all`. Neither project can
break the other's build, because the histories never meet; this is a search and discovery hazard,
not a correctness one.

Full detail, the measured costs, and why splitting is deferred: [docs/one-remote-two-codebases.md](docs/one-remote-two-codebases.md).

## PostgREST fails the ENTIRE query on an ungranted column

Adding one column to a guest-facing `.select()` is a **site-wide outage risk**, not a tidy-up.

PostgREST does not silently omit a column the caller lacks a grant for — it fails the **whole
query** with `42501`. `contexts/restaurant-context.tsx` wraps every guest-facing page, so a single
ungranted column there takes out the menu, the cart, the tab and the receipt at once.

This has bitten twice. Its own comment records `owner_id` doing it, and on 2026-08-24
`is_counter_service` and `card_payments_available` were both verified denied to `anon` *before* they
were added to that select — the grant migration (`20260824130000`) was mandatory, not housekeeping.

**Before adding a column to any anon-key `.select()`:**

```ts
// prove it, do not assume — an ungranted column is indistinguishable from a typo until it 500s
const { error } = await anon.from('restaurants').select('id, your_new_column').limit(1)
// error?.code === '42501'  ->  you need a column grant first
```

Grant it explicitly, in a migration, alongside the column that needs it.

## Card capability is a GENERATED column so credentials never reach the browser

`restaurants.card_payments_available` is `GENERATED ALWAYS AS (finatic_merchant_no IS NOT NULL AND
finatic_store_no IS NOT NULL AND ...) STORED`.

**Do not "simplify" this by selecting `finatic_merchant_no` / `finatic_store_no` client-side and
comparing them there.** That puts merchant identifiers in every customer's browser to answer a
yes/no question, and those two columns are deliberately outside the anon grant.

It is the same mistake #279 made with `session_id`: the client asked "is this mine?" by receiving
the identifier and comparing it, so when the server correctly stopped sending the identifier, two
customer-facing banners silently went dark for two days.

**The rule both cases teach: when a client needs an answer, send the ANSWER, not the data it would
be derived from.** Generated columns are the cheapest way to do that for a row-level fact — the
database computes it, it cannot drift from its inputs, and there is no code path that can set it
inconsistently.
