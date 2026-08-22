# Ask for Finatic — what does `trans_status` actually mean?

Drafted for Lenton to send to Sedrick. He is not the engineer, so the message below is written to be
forwarded to one without needing a translation.

**This replaces the earlier draft, which asked for a response-signing public key.** That question is
dead: Finatic has no merchant-facing public key, so signature verification can never work and we do
not need one. Do not send the old version. Background: `docs/paycloud-gateway-public-key.md`.

**Why this question instead.** With no signature to verify, the reply to `order.query` **is** our
settlement decision — we mark an order paid on the strength of `trans_status` and nothing else. So
what that field guarantees is now a money-correctness question rather than a curiosity.

---

**Subject: What does `trans_status` mean on `order.query`? — three orders that concern us**

Hi Sedrick,

A question for your technical team, and three real transactions that prompted it.

**The question.** When we call `order.query`, the reply contains `trans_status`. We treat **`2`** as
"this card was charged and the money is ours". We would like that confirmed, precisely:

1. **What values can `trans_status` return?** We have only ever seen `1` and `2` across our live
   traffic, so we are working from two observations rather than from a list. If there are others, we
   are currently treating every one of them as "not paid", which may be wrong.
2. **Does `2` mean the money is CAPTURED — settled and ours?** Or can `2` also mean the card was only
   **authorised**, or the amount **reserved**, or the payment **pending settlement** in a batch that
   has not run yet? These are very different things for us and we cannot tell them apart from the
   reply.
3. **If `2` can mean any of those,** which field distinguishes a captured charge from one that is
   merely authorised?

**Why we are asking — three orders from 24 July at FNB ChowNow.** For each of these, `order.query`
told us the payment succeeded, and our records show **no money was taken**:

| our order | amount | your `merchant_order_no` | when |
|---|---|---|---|
| 456 | N$36 | `FT17848784961220102` | 2026-07-24 07:34 |
| 500 | N$125 | `FT17848903230492229` | 2026-07-24 10:52 |
| 546 | N$40 | `FT17848931629389904` | 2026-07-24 11:39 |

**Total N$201.** All three on merchant `342600131153`.

Two things we would like your team to tell us about them specifically:

- **Was the card actually charged for each of these three?** If yes, the money did not reach us and
  we need to trace it. If no, then `order.query` reported a success for a payment that never
  completed — which is the thing we most need to understand, because we settle on that reply.
- **Was each one refunded, reversed, or simply never captured?** We have no record of a refund.

**What this affects.** Because there is no way for us to verify your response signature, this reply
is the only evidence we have that a payment happened. If `2` can appear before the money is actually
captured, then we are marking orders paid too early, and we need to know what to wait for instead.

Thanks,
Lenton
