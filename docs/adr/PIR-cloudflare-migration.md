# Post-Implementation Review: Cloudflare DNS & Application Migration

**Date:** 1 July 2026
**Related:** ADR-001

## Objectives

Move flashtap.app from Vercel to Cloudflare Workers, originally scoped 
as a straightforward Phase 3 DNS cutover following successful 
infrastructure (Phase 2A) and application (Phase 2B.1/2B.2) validation 
on Cloudflare.

## What happened

The "simple DNS flip" assumption was wrong: flashtap.app's domain and 
apex/www hostnames were managed through Vercel's proprietary Connected 
Projects mechanism, not an editable DNS record. A real migration 
required moving the entire nameserver zone to Cloudflare — a bigger, 
slower operation than planned, with email deliverability (Resend 
DKIM/SPF/MX) newly in scope.

Execution paused on discovery, was documented (ADR-001), and a revised 
plan was reviewed with the mentor: investigate a lower-risk proxy 
approach (Option B) and separately scope the full migration (Option A) 
before deciding.

Mid-session, two new facts changed the plan: the proxy prototype 
validated its hardest unknowns (auth/session/data through a Vercel→Worker 
hop all worked), and it turned out there was no live customer traffic 
at the time. Given both, the team made a live call to execute the full 
migration (Option A) directly rather than running a second investigation 
first — a deviation from the commissioned plan, reported to the mentor 
after the fact with full reasoning, and approved retroactively given 
the specific conditions.

The migration itself executed cleanly: DNS zone onboarded, nameservers 
switched, propagation unusually fast (~5 minutes vs. the hours 
originally feared), Worker renamed and repointed, application verified 
end-to-end including the highest-risk item (outbound email).

## What surprised us

- **Vercel's domain management isn't "just DNS."** Connected Projects 
  is an abstraction layer that made a normally-trivial DNS change 
  impossible without understanding its internals first.
- **CAA records and DNSSEC were real, checkable risks** that could have 
  silently broken HTTPS or made the domain unresolvable — worth 
  verifying explicitly on any future domain-level change, not assumed.
- **Nameserver propagation was much faster than expected** (~5 minutes, 
  not the hours-to-48h range typically cited) — good in this instance, 
  but not something to rely on as a rule for future changes.
- **A generic client-side error message ("signed up with Google") 
  nearly caused real confusion** during post-cutover verification — it 
  fired for an unrelated cause (wrong email typed) and initially looked 
  like a migration-caused auth failure. Misleading error UX can cost 
  real debugging time even when the underlying system is fine.
- **The riskiest-sounding item (email) was the one that just worked** — 
  the byte-exact DNS inventory taken before any change paid off directly 
  here.

## What we'd change next time

- Verify a platform's domain-management model (plain DNS vs. a 
  proprietary abstraction like Connected Projects) *before* writing a 
  runbook that assumes simple record edits, not after starting execution.
- Take a full, byte-exact DNS inventory as a standard first step for 
  any future domain-level change, not something added ad hoc mid-session.
- When a live judgment call deviates from an approved plan, still pause 
  briefly to write the one-paragraph "why" before proceeding — it was 
  captured well after the fact here, but doing it in the moment would 
  be even more reliable.
- Fix misleading generic error messages (like the Google-signup hint) 
  proactively — they cost debugging time during exactly the moments 
  (post-change verification) when a false signal is most costly.
- Schedule a rollback drill for any migration where rollback mechanics 
  changed, even if judged low-urgency — better to prove it in a calm 
  moment than assume it under pressure.

## Lessons learned

1. Runbooks are built on assumptions about how a system works underneath 
   — those assumptions deserve direct verification, not inference from 
   how the system behaves for other tasks.
2. A pause-and-document response to an invalidated assumption is a sign 
   of a healthy process, not a failure of planning.
3. Deviating from an approved plan is acceptable when justified by new, 
   specific evidence (not urgency or fatigue) and documented with the 
   same rigor as the original plan.
4. The highest-perceived-risk item isn't always the one that breaks — 
   careful inventory work up front (email DNS, in this case) is what 
   made that true here, not luck.
5. Documentation that reflects what actually happened — including 
   deviations, mistakes, and false alarms — is more valuable long-term 
   than documentation that only reflects the original plan.
