# Design: the venue setup flow — design only, not built

**Filed:** 2026-08-28. Ties together items 1–3 of tonight's queue, all of which shipped or were
prepped tonight and each already has its own real, working control — this design is only about
sequencing them into one guided flow, not inventing any of the underlying mechanisms.

## What already exists, after tonight

| Step | Control, as of tonight | Where |
|---|---|---|
| Enable the waiter-led flow | `station_screens_enabled` switch, super_admin only | Platform admin, `app/admin/restaurants/[id]` (item 2) |
| Route categories to kitchen/bar/both | Per-category selector + bulk-select panel with the live split visible | Menu Management (item 1) |
| Pair a kitchen/bar screen | Activation-code pairing flow | Restaurant settings (built earlier tonight, confirmed live on production) |
| Add waiter staff | `staff_members.name` + `user_id`, `public.users.email` nullable | Schema prepped (item 3/Deploy 3), no UI yet — see that item's own note that nothing lets a manager actually CREATE a staff row without an email today |

Today these are four unconnected screens in two different admin surfaces (platform admin for the
flag, restaurant admin for everything else), discoverable only by knowing each exists. Riviera
onboarding Sunday is the forcing case: nobody should need this session's own knowledge of where
each control lives to bring up a new venue.

## The shape: a checklist, not a wizard

Explicitly NOT a linear multi-step wizard that blocks step 2 until step 1 is "done" — a manager
setting up Riviera mid-week might route categories before staff exist, or pair a screen before
every category is routed. A checklist with independent, revisitable items matches how the four
prerequisites are actually reached in practice tonight (three different people did three of them
in whatever order the incident allowed).

1. **A `restaurant_setup_status` view** (computed, not stored — every fact it reports already
   lives somewhere): `station_screens_enabled` (read from `restaurant_features`), category
   routing completeness (the same "71 kitchen / 124 bar / 3 both" split tonight's UI already
   computes, plus a flag for "any category still at the unconfigured default"), screen pairing
   count (terminals with `station_kind` set, from tonight's pairing work), staff count (staff_
   members rows with `active = true`, once the add-staff UI exists).

2. **One page, four cards**, each showing: done / not done / partially done, a one-line summary
   (the actual split numbers, the actual pairing count), and a button that navigates to the
   existing control for that step — NOT a reimplementation of any of the four. This page is a
   dashboard and a router, not a fifth place that owns the underlying state.

3. **Gating is advisory, not enforced**, at least for a first version. A venue can go live with
   three of four steps done; the page's job is making the fourth VISIBLE, not blocking service
   over it. `station_screens_enabled` itself is the one hard gate that already exists (nothing
   works without it) — the checklist should probably surface that one FIRST and most prominently,
   since the other three are inert without it (a paired screen with the flag off shows nothing;
   a routed category matters only once the flag is on and lines start flowing).

## Where it lives

Given item 2 put the flag switch on the PLATFORM admin surface deliberately (super_admin only,
"a rollout control, not a venue preference") and items 1/3 are restaurant-admin-facing, this
checklist has an ownership question the other three don't: is it platform-admin (so the person
turning on the whole rollout also sees the venue's own progress) or restaurant-admin (so an owner
mid-onboarding sees their own checklist without needing platform access)? Likely BOTH read the
same computed status, rendered differently — a platform admin sees it as one more fact about a
restaurant in the ops panel; a restaurant owner/manager sees it as their own onboarding page. That
is two render surfaces over one shared status computation, not two systems.

## What this explicitly does not attempt to solve

- The add-staff-without-email UI itself (item 3's own gap, noted there, not re-solved here).
- Whether `station_screens_enabled` should ever become self-serve for an owner (item 2's own
  docblock is explicit that it stays super_admin-only "until... it belongs to every super_admin,
  not one operator's deliberate call" — this design does not reopen that ruling).
- Any change to how the four underlying controls work. This is purely a discovery/sequencing
  layer over mechanisms that already exist or are already prepped.

## Not attempted here

No schema (the status view is computed, not stored, so none is needed), no route, no UI. Shape
only, per the instruction that this item is design, not build.
