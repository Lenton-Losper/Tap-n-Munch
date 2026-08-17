# Promotion constraints — commit pairs that must not be split

Some fixes are **two commits that are not independently shippable**. Promoting one half is not a
weaker version of the fix; it is a new, live defect. This file exists because the natural
promotion move — cherry-pick the branch named for the issue — is exactly the move that splits them.

Read this before cutting any `promote/*` branch or cherry-picking onto `main`.

---

## #302 — edit-route session token (server + client)

**Both halves must reach production in the same deploy. Server alone breaks editing for every
customer on a tab.**

| half | commit | what it does |
| --- | --- | --- |
| server | `5b99b81` | `edit/route.ts` calls `requireSessionToken` + `assertSessionMatchesResource` when the order has a `tab_id`; `session_id` stops leaking from the guest read paths |
| client | `4bc3b2d` | `editRequest` in `lib/guest-orders/client.ts` actually **sends** `x-session-token` |

Before the client half, the app's own client sent no token. So the server half alone means every
legitimate diner on a tab is refused on every edit. This is not a hypothetical — it is what
staging did in the window between the two merges.

### The hazard, by name

```
origin/fix/302-edit-auth-session-token    server guard: YES   client sends token: NO    <-- DO NOT PROMOTE ALONE
origin/fix/302b-client-sends-token        server guard: YES   client sends token: YES   <-- the safe unit
```

The branch named for the issue is the broken one. **Promote `fix/302b-client-sends-token`, or
promote both merges, or promote neither.**

### How to tell, after deploying

`scripts/probe-302-edit-auth-chain.ts` — **step 1b, the positive control**, is the only step that
distinguishes "the attack is closed" from "the feature is dead":

```
OK       step 1b OWNER can still edit    lock=200 patch=200
```

If step 1b reports BROKEN, the client half is missing — no matter how green steps 2–5 look.
Steps 2–5 all reporting REFUSED is *also* precisely what a total lockout looks like from the
attacker's side. A check that only asserts the attack fails cannot tell the two apart.

### Not covered by this pair

The **tab-less** path was a separate hole — **#305**, now fixed on staging. Do not assume
promoting #302 closes it; see the ordering constraint below.

---

## #305 — tab-less `member_session_id` (ORDER, not pairing)

**No split hazard: the fix is server-side only, and there is no client half.** But it **must not
be promoted before #302**, because it builds directly on it.

| commit | what it does |
| --- | --- |
| `d2b5cfd` | `lib/tab-member-key.ts` withholds raw `member_session_id` from non-owners on tab-less rows; probe extended with T0/T1/T2/T3/T4 |
| `ce44ac2` | the guest-route order-id invariant test |
| `74d1673` | tab-member-key tab-less unit cases |

The one-line fix reads `ownsRow`, which is computed from the `callerSessionIds` parameter that
**#302 added** (`5b99b81`) and that #302 made the four call sites in `lib/guest-orders/queries.ts`
actually pass. Promote #305 onto a base without #302 and the parameter is not there.

**Order: #302 (both halves) first, then #305.** Promoting them together is fine.

### How to tell, after deploying

Same probe, the tab-less phase, and again the positive controls are what distinguish a fix from a
lockout:

```
OK       step T0 OWNER still sees own member_session_id
OK       step T1 SOLO diner can edit own order            lock=200 patch=200
REFUSED  step T2 OBTAIN the raw owner id
```

If T1 reports BROKEN, solo diners — customers with no tab at all — cannot edit their own orders.

---

## How to add an entry

An entry belongs here when **half of a change, deployed alone, is worse than none of it**. State
the two commits, name the branch that carries only one half, and give the one check that tells a
split deploy from a whole one.

---

## STANDING RULE — `main` being ahead of `cloudflare-staging` is a DEFECT, not a state

Staging fell **23 commits behind main** and nobody saw it. Looking would not have helped: the one
number on offer overstated the gap 2.4x — 250 commits by `rev-list`, 106 by patch-id — so the
figure carried no information. Inside that gap was a **live PostgREST `.or()` injection** in the
payment webhook resolver (#242) that main had fixed and staging had not, which means the QR
redesign was built and verified for two weeks on a base weaker than the one customers run.

**Staging ahead of main is normal.** That is what staging is for. **Main ahead of staging is a
defect**, and it is the dangerous direction: it is a production security fix that a merge can
silently revert, and nothing in the repo was watching for it.

### The check

`scripts/check-branch-drift.mjs`, wired **blocking** into `build-verification` in
`.github/workflows/staging.yml`. `deploy` needs that job, so a failure blocks the staging deploy.

    node scripts/check-branch-drift.mjs [baseRef] [headRef]     # defaults: origin/main, origin/cloudflare-staging

    exit 0  no NEW drift
    exit 1  commits on main that staging lacks and the baseline does not cover
    exit 2  could not run (missing refs, shallow clone) — never a silent pass

**It measures twice, and the second measurement is what makes it survivable.** `git cherry` gives
candidates by patch-id; each candidate's patch is then reverse-applied against the tree, so a fix
PORTED under a different patch-id is reported PRESENT rather than missing. Of the 23 measured on
2026-08-17, **13 were already present by content**. A check that cried wolf on thirteen ported
commits would have `continue-on-error: true` bolted onto it within a week — which is exactly what
happened to the migration drift check three steps above it in the same file.

**It is baselined, so it can be blocking from day one.** The ten genuinely-absent commits as of
2026-08-17 are listed in `KNOWN_ABSENT` inside the script, printed loudly on every run, and the
check fails only on drift that is NEW. Stale baseline entries are reported so the list cannot rot.
**The baseline is a debt, not a licence. It should only ever shrink.**

### The nuance that must not be lost

The check is per **commit**, not per **behaviour**. A commit reads ABSENT when its whole patch is
not present — its key guard may already have been ported while a test file alongside it was not.
Four of the ten on 2026-08-17 were exactly that: the `?ref=` guard is byte-identical on both
branches, and #122's route code differs only in comments. **Read the decisive line before
concluding a fix is missing.**

### The one that needs a human

`07b4737` (#223, the stale-POS cron) does not cherry-pick cleanly. The conflict is one hunk in
`lib/orders/auto-cancel-stale-pos-orders.ts` where two rulings collide:

    staging (#268)  amount: finaticResult.amount ?? Number(order.total)   + gatewayAmount recorded separately
    main    (#223)  amount: gatewayAmount                                 quarantine, never fall back to the order total

That is a payments decision, not a merge. It is not resolved unattended.
