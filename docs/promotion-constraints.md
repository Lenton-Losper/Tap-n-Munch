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
