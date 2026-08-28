# ADR-001: DNS Authority Discovery

**Status:** Operationally Complete — Rollback Drill Outstanding
**Date:** 1 July 2026

## Context

Phase 3 of the Cloudflare migration was approved as a simple DNS cutover: 
lower the TTL on flashtap.app's A/CNAME record, flip its value to point 
at Cloudflare, and roll back in under 5 minutes if needed by reverting 
that one value.

That assumption turned out to be wrong. Investigation during execution 
found:

- flashtap.app is registered through Vercel Domains, with Vercel as the 
  authoritative nameserver (ns1/ns2.vercel-dns.com) — not a third-party 
  DNS host with an editable record pointing at Vercel.
- www.flashtap.app and the bare apex are attached to the Vercel project 
  via Vercel's "Connected Projects" mechanism, not a plain A/CNAME 
  record. There was nothing to simply edit.
- Cloudflare Workers Custom Domains require the entire DNS zone to be 
  onboarded to Cloudflare's nameservers — there is no CNAME-only path.
- The zone carries live Resend email DNS records (DKIM, SPF, MX) tied 
  to noreply@flashtap.app, which would be dragged into the migration's 
  blast radius.

This invalidated the approved runbook's core assumptions: propagation 
measured in minutes became propagation measured in hours (worst case), 
and single-value rollback became a full nameserver revert.

## Decision

Execution paused. Three options were evaluated:

- **Option A** — full DNS zone migration to Cloudflare (matches original 
  intent, but a bigger, slower, higher-blast-radius project than "Phase 3")
- **Option B** — keep Vercel as the DNS/edge layer, proxy requests to the 
  Cloudflare Worker via a Vercel rewrite, avoiding any nameserver change
- **Option C** — pause, no immediate action
- **Option D** (added by mentor) — migrate DNS first, leave the app on 
  Vercel, prove email/certs/redirects independently, then migrate the 
  app separately

Mentor guidance: pause (Option C) immediately, investigate Option B as 
the preferred hypothesis (not yet an adopted architecture), and in 
parallel scope Option A as its own project.

**What actually happened:** Investigation 1 (Option B prototype) 
partially validated the hardest unknowns — auth, session, and data 
fetching all survived a Vercel-to-Worker proxy hop correctly. Combined 
with the discovery that Riviera and FNB ChowNow had no live orders in 
flight at the time, the team made a live judgment call to proceed 
directly to Option A that same session, rather than running a second, 
separate investigation first. This deviation was made in the moment, 
not pre-planned, and was reported to the mentor after the fact rather 
than requested in advance.

Execution:

- Full DNS record inventory taken before any change (8 records: DKIM 
  TXT, SPF TXT, MX, 3× CAA, 2× Vercel-managed ALIAS), pulled byte-exact 
  from Vercel's API to avoid UI truncation.
- DNSSEC confirmed off before proceeding.
- flashtap.app onboarded to Cloudflare as a zone; scan results matched 
  the pre-change inventory.
- riviera.flashtap.app (confirmed not live) intentionally left 
  unmigrated.
- Nameservers switched at Vercel to Cloudflare's (itzel.ns.cloudflare.com 
  / jacob.ns.cloudflare.com). Propagation completed in ~5 minutes — 
  far faster than the multi-hour risk originally flagged.
- The flashtap-shadow Worker (the exact code validated through Phase 
  2B.1/2B.2) was renamed in place to flashtap-production, preserving 
  code and bindings. Environment variables updated from shadow/staging 
  to production values and auto-redeployed.
- flashtap.app (bare apex) added as a Custom Domain on flashtap-production, 
  after removing two conflicting Vercel-origin A records.

## Consequences

**Verified:**
- App loads correctly at flashtap.app (valid SSL, correct styling)
- Owner sign-in, session, and real dashboard data all work through the 
  new Worker
- Full page click-through (Orders, Menu, Staff, Stock, Settings) — pass
- Outbound email (Resend/DKIM/SPF/MX) — the single highest-risk item — 
  confirmed working via a real delivered staff invite immediately 
  post-cutover
- www.flashtap.app was initially a known open item (still Vercel-routed 
  DNS records); subsequently confirmed to already redirect cleanly to 
  the Cloudflare-served apex via Vercel's existing redirect. No second 
  live app origin exists. Resolved, no action needed.

**Outstanding:**
- Rollback is no longer a sub-5-minute DNS-value revert, since 
  nameserver authority moved. A documented procedure exists (revert two 
  A records to Vercel's origin IPs within Cloudflare, no nameserver 
  change needed) but has not been drilled end-to-end. Judged low-risk 
  and non-urgent, since the procedure only re-adds records that were 
  stable for years — scheduled as a hardening item, not a blocker.

## Mentor sign-off

Approved. The judgment call to accelerate past the commissioned 
investigation was assessed as reasonable given the documented 
conditions (near-zero production traffic, successful verification, no 
customer impact) — explicitly noted this would have been a different 
answer during active service hours; context was the deciding factor, 
not the deviation itself.

Standing principle adopted for FlashTap: approved implementation plans 
rest on explicit assumptions. If a critical assumption is invalidated 
mid-execution, implementation pauses until the new risk profile is 
understood and documented. Deviating from an approved plan is 
acceptable only when documented with equal rigor to the original plan.
