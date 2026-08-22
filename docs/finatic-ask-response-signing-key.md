# Ask for Finatic — production response-signing public key

Drafted for Lenton to send to Sedrick. He is not the engineer, so the message below is written to be
forwarded to one without needing a translation. Everything technical is in the example, not the prose.

Background and evidence: `docs/paycloud-gateway-public-key.md`.

---

**Subject: Request — production response-signing public key for our merchant account**

Hi Sedrick,

We need one item from your technical team.

**What we need:** the **public key that Finatic uses to sign its API responses** on our production
merchant account `342600131153` — specifically the responses to `order.query`.

**Why:** every response you send us carries a `sign` field. We are supposed to check that signature
to confirm the response genuinely came from Finatic. We do not have the matching public key, so that
check fails on every call and we currently accept the response unverified. We would rather not keep
doing that on live card payments.

**To be precise about which key**, because there are several in play and only one is the right one:

- This is **not** the key we use to sign requests *to* you — that one works.
- This is **not** the sandbox / UAT key. We have one that works against UAT; it does not work against
  production.
- It is the **production** key, for **your** signature on **your** responses, on **our** account.

**Here is a real response from us so your team can see exactly what we are trying to verify.** This
is order reference `FT17872970116626363` on our account, queried on 22 August 2026 — your team can
pull the same one up their side:

```json
{
  "code": "SUCCESS",
  "msg": "...",
  "psn": "...",
  "data": {
    "trans_status": 2,
    "paid_amount": "81",
    "order_amount": "81"
  },
  "sign": "GLx/ERToQt75uv... [344 characters, standard base64] ...Dey9dWXPEA=="
}
```

It is the `sign` field at the bottom we cannot verify. It is 344 characters of standard base64,
which is a 2048-bit RSA signature — so the key we are asking for is the 2048-bit RSA public key that
corresponds to whatever private key produced it.

**One note that may save your team time:** when we try our current key, the failure is a *key*
mismatch rather than a formatting mismatch. So we do not think this is about field ordering,
character set, or how the string is assembled before signing — we think we simply have the wrong
key. If your team believes the key we hold *should* be correct, then that assumption is the thing to
check first.

Please send it as a `.pem` file or plain base64 text — whichever is normal for you.

Thanks,
Lenton
