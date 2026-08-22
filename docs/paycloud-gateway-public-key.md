# `PAYCLOUD_GATEWAY_PUBLIC_KEY` — the standing record

**This supersedes any note saying "Finatic cannot supply it, closed as unavailable."** That framing
is wrong in a way that matters: it reads as *there is nothing to verify*, and stops anyone looking.
There is something to verify, we are failing to verify it, and the thing we need has a precise name.

Undated on purpose. This is the file to update when the position changes — not a dated incident doc.

## What the variable is for

Finatic **signs their responses**. `payments/paycloud.js` verifies that signature with
`PAYCLOUD_GATEWAY_PUBLIC_KEY`. When the check fails it is swallowed with a `console.warn`
(`[PayCloud][QUERY] Response signature verification threw (ignored)`) and the response is trusted
anyway. That swallow is why this has been invisible for months.

It is **not** the key used to sign our outbound requests — that is `PAYCLOUD_PRIVATE_KEY`, and it
works. Conflating the two is the origin of the misconfiguration below.

## Measured position, 2026-08-22

Three live production `order.query` calls, FNB ChowNow merchant `342600131153`, real paid orders:

- **No key we hold verifies a live production response.** Every call logged
  `Response signature verification threw (ignored): Encryption block is invalid.`
- **The deployed `fe8000ae` fails against production.** It was in use for these very calls. The
  proposal to "try `fe8000ae` in the deployed secret" is therefore **disproved** — it is already
  there and it does not work.
- **The response genuinely carries a signature.** Top-level keys are
  `["code","data","msg","psn","sign"]`, with `sign` a **344-character standard-base64 string** —
  a 256-byte RSA-2048 signature. So this is not "they don't sign"; there is a real artefact and our
  key is the wrong one for it.
- **The UAT key proves nothing about production.** A UAT key verifying a *UAT-captured* response is
  self-consistent and says nothing about the production endpoint. Do not cite it as progress.
- **This is a wrong-key result, not a canonicalisation bug.** node-forge throws
  `Encryption block is invalid.` for a wrong *key*; a wrong *sign-string* returns `false` instead.
  We get the throw. **Do not reopen the sign-string / field-ordering / charset family.**

The separate finding that the deployed Vercel snapshots carried *our own* public key in the gateway
slot is real, and is a genuine misconfiguration. It is **not** a complete explanation: the env
measured above has correctly *distinct* keys and still fails.

## The fingerprint trap

`5ea7ef1d` and `fe8000ae` **are not comparable.** The SDK's `[PayCloud][ENV]` fingerprints digest a
different input than a hand-derived one. Only ever compare values produced by the same method, and
say which method produced any fingerprint you write down. Two numbers that "obviously differ" may be
the same key, and two that match may not be.

## What would actually close this

Finatic must supply **the production response-signing public key for `order.query` responses on our
merchant account**. Nothing else substitutes. The ask is drafted in
`docs/finatic-ask-response-signing-key.md`.

## What follows from it being open

`fallback_verified_paid` is the **primary** settlement path, not a recovery path — on 2026-08-21
every card taken at FNB ChowNow settled through it and none through the signed webhook. The fallback
needs per-restaurant credentials, so **a venue with NULL `finatic_merchant_no` / `finatic_store_no`
has no settlement path at all.** See the pre-launch gate in `docs/promotion-runbook.md`.

## Reproducing the measurement

`qrd-stage/.env.local` is the only one of ~60 `.env.local` files with no `PAYCLOUD_ENDPOINT` /
`PAYCLOUD_PRIVATE_KEY`, so point tsx at a populated one:

```bash
node node_modules/tsx/dist/cli.mjs --env-file=../restaurant-menu-screen/.env.local <script>
```

Set `NODE_OPTIONS=--no-network-family-autoselection` or every fetch dies `ETIMEDOUT` while curl
works. The SDK floods stdout — filter for your own lines or you will lose them.
