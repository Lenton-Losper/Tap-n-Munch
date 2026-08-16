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

The **tab-less** path is a separate, still-open hole — see **#305**. `session_id` is scrubbed
there correctly, but the raw id reaches the client via `member_session_id`, and it still works as
an edit credential because the token requirement is scoped to `if (tabId)`. Do not assume
promoting #302 closes it.

---

## How to add an entry

An entry belongs here when **half of a change, deployed alone, is worse than none of it**. State
the two commits, name the branch that carries only one half, and give the one check that tells a
split deploy from a whole one.
