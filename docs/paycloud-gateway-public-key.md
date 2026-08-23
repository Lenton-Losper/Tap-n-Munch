# `PAYCLOUD_GATEWAY_PUBLIC_KEY` — CLOSED. There is no key to find.

**Ruled 2026-08-22 by the owner, from direct contact with Finatic: a merchant-facing public key
does not exist.** Not "not supplied yet", not "blocked on the vendor" — there is no artefact.

**Stop looking. Do not open a ticket, do not chase Sedrick for it, do not try another key.** Every
framing this file has carried before today was wrong in a way that cost time:

| framing | why it was wrong |
|---|---|
| "Finatic cannot supply it, closed as unavailable" | Read as *there is nothing to verify*, so nobody looked. |
| "A live vendor ask — the one artefact that would close it" | Read as *someone just needs to send an email*. Nobody can send what does not exist. |

Undated on purpose. This is the file to update if the position ever changes.

## What this means, and it is structural rather than a defect

**Response signature verification can never succeed.** `payments/paycloud.js` verifies Finatic's
response signature against `PAYCLOUD_GATEWAY_PUBLIC_KEY`; with no such key in existence, the check
fails on every call, forever. The `console.warn` it emits is expected noise, not a symptom.

**Therefore the fallback is not a workaround. It IS the settlement architecture.** On 2026-08-21
every card taken at FNB ChowNow settled through `path: fallback_verified_paid` and not one through
the signed webhook. That is the steady state and it is not going to change.

The security model that follows is the outbound `order.query`, authenticated by our own credentials
over TLS. **The webhook is an untrusted trigger, never evidence.** That was already the written
model; what changed today is that it is now permanent rather than interim.

## The consequence nobody can design around

`queryFinaticOrderPaid` **is** settlement. It opens with:

```ts
const creds = await getRestaurantFinaticCredentials(restaurantId)   // throws if unconfigured
```

Three separate recovery paths read it — the webhook fallback, the stale-order cron, and terminal
verify-payment — so they **all fail together** for a venue with no credentials.

> ### No venue can take a card without `finatic_merchant_no` and `finatic_store_no`. Ever.
>
> Not "should not". **Cannot.** The card clears at the gateway, the signature check fails as it
> always will, the fallback throws for want of credentials, and the order stays unpaid. The money is
> taken and the system has no record that it was.

**Two venues are in exactly that state today: Chownow Nedbank and Digi Cofee.** Digi Cofee still has
a registered, active terminal. The gate is `scripts/check-venue-payment-readiness.mjs`, documented in
`docs/promotion-runbook.md` under *Pre-launch: a venue's first card*.

## What was measured, and still stands

Measured 2026-08-22 against live production `order.query` (FNB ChowNow merchant `342600131153`,
three real paid orders). These observations were correct; only their interpretation was wrong.

- Every response failed verification with `Encryption block is invalid.`, **including in an
  environment whose keys are correctly distinct** (`derived 1e5dcffc` vs `configured fe8000ae`).
- The response **does** carry a `sign` field — 344 characters of standard base64, an RSA-2048
  signature. A signature being present is not evidence that a verifying key is obtainable; it is a
  field in their response format. **Do not treat its presence as a reason to reopen this.**
- The separate finding that the deployed Vercel snapshots carried *our own* public key in the gateway
  slot is real, and is a genuine misconfiguration — it is simply no longer worth fixing, because a
  correctly configured slot would not verify either.

**The fingerprint trap.** `5ea7ef1d` and `fe8000ae` are **not comparable**: the SDK's
`[PayCloud][ENV]` fingerprints digest a different input than a hand-derived one. Only ever compare
values produced by the same method, and say which method produced any fingerprint you write down.

**Do not reopen the canonicalisation family** — sign-string assembly, field ordering, charset.
node-forge throws `Encryption block is invalid.` for a wrong *key* and returns `false` for a wrong
*sign-string*. We get the throw. That question is settled and it is moot anyway.

## What IS still open with Finatic

Not the key. **The meaning of `trans_status`.** `2` is treated everywhere as "paid", and three
production orders (#456, #500, #546) came back PAID at Finatic on N$201 that the owner's records say
was never charged. Whether `2` guarantees a *captured* charge — as opposed to authorised, reserved,
or pending settlement — is unanswered and is a money-correctness question.

The ask is drafted at `docs/finatic-ask-trans-status-semantics.md`.

## Reproducing the measurement, if you ever need to

`qrd-stage/.env.local` is the only one of ~60 `.env.local` files with no `PAYCLOUD_ENDPOINT` /
`PAYCLOUD_PRIVATE_KEY`, so point tsx at a populated one:

```bash
NODE_OPTIONS=--no-network-family-autoselection \
  node node_modules/tsx/dist/cli.mjs --env-file=../restaurant-menu-screen/.env.local <script>
```

Without `--no-network-family-autoselection` every fetch dies `ETIMEDOUT` while curl works. The SDK
floods stdout — filter for your own lines.
