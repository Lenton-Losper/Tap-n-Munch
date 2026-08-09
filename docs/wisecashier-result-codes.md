# WiseCashier return contract and result-code table

**Not in the SDK4 documentation.** Recovered on 2026-08-09 by decompiling WiseCashier itself
(`com.wiseasy.finatic.cashier` v2.1.6.42). Recorded here so nobody has to do it again.

Where the SDK4 package was checked and came up empty:

| Source | Result |
|---|---|
| `2.WPOS EMV Process Guide_all_V2.2.02.210208.pdf` | extracts clean; no K-codes, no intent contract |
| `3.WPOS SDK Development Reference Part I_V1.7.9.pdf` | extracts clean; a *hardware* API reference (card reader, PIN pad, printer, crypto, scanner). No K-codes. |
| `Demo/CashierDemo` (SDK4 and SDK6) | `com.wiseasy.cashier.demo` — the direct-EMV demo, where the integrator IS the payment app. Never calls the intent surface. Irrelevant to us. |
| `Wiseasy_SmartPOS_Development_Guide.txt` | 255 bytes; four Feishu wiki links, no content |

> Filename trap: the reference PDF's name contains U+00A0 non-breaking spaces, not spaces.
> Tools fail to open it while `ls` renders the name normally, which reads as "the document
> won't extract" rather than "you never opened it". Glob the name (`3.WPOS*Reference*.pdf`).

## The return contract

`AppInvokeUtilKt.onAppInvokeFail(context, exceptionCode, exceptionMsg)` — every failure path:

```
intent.putExtra("result",    exceptionCode)
intent.putExtra("resultMsg", exceptionMsg)
intent.putExtra("version",   "A01")
activity.setResult(-1, intent)   // RESULT_OK. Hardcoded.
activity.finish()
```

Three consequences, all load-bearing:

1. **`RESULT_CANCELED` is never returned.** Every failure — cancel, timeout, flat battery —
   arrives as `RESULT_OK`. An `onActivityResult` branch keyed on `RESULT_CANCELED` cannot fire
   for anything WiseCashier does. (It is still worth keeping for an Android-level back-out,
   which does not go through WiseCashier's own code at all.)
2. **`result` is the contract field.** It is assigned `exceptionCode` verbatim — it *is* the
   code, not a string containing it.
3. **`resultMsg` is a composed display string, not a parallel contract.**
   `CommonException.getExceptionMessage()` builds `'[' + exceptionCode + ']' + message`, where
   `message` is a *localised string resource*. Its text changes with device language and with
   any vendor edit. **Never match on it.**

Verified against a live UAT P5 (vc82 wiretap, 2026-08-09): `resultCode = -1 (RESULT_OK)`,
`action = (none)`, exactly three extras — `result=K026`,
`resultMsg=[K026]Manual cancellation by operator`, `version=A01`.

## The transaction code family

From `com.wiseasy.cashier.comm.exception.mapper.TransactionExceptionMapper.getExceptionMessage`,
with the English text from WiseCashier's own `resources.arsc`.

The **Bypass** column is FlashTap's judgement, not Wiseasy's: may this code take the
`noGatewayAttempt` fast-cancel that skips Finatic verification?

| Code | Resource | Message | Bypass |
|---|---|---|---|
| K026 | `exception_manual_cancel` | Manual cancellation by operator | **YES — the only one** |
| K027 | `exception_time_out` | Transaction timeout. Reconnect to the network, then check transaction status before making another payment | **NEVER** |
| K017 | `exception_processing` | Transaction processing | **NEVER** |
| K036 | `bankcard_reversal_status_success` | Auto Reversal Successful | **NEVER** |
| K037 | `bankcard_reversal_status_fail` | Auto Reversal Failed | **NEVER** |
| K009 | `exception_unknown_transaction` | Unknown Transaction Exception | **NEVER** |
| K024 | `exception_batch_upload` | Settlement failed, need to perform batch upload | no |
| K025 | `exception_need_sign_in` | Need Sign In | no |
| K029 | `exception_low_battery` | Battery too low to trade. Please charge your device first. | no |
| K030 | `exception_remote_reader_not_connect` | The remote card reader is not connected! | no |
| K031 | `exception_need_settlement` | Please settle first | no |
| K032 | `exception_need_load_emv_parameters` | Please load emv parameters | no |
| K033 | `exception_key_not_exist` | Key Not Injected | no |
| K015 | `exception_not_exist` | Transaction records do not exist | no |
| K016 | `exception_not_match` | Transaction types do not match | no |
| K018 | `exception_card_not_match` | Please use the same card you used for the original transaction | no |
| K019 | `exception_no_settlement_data` | No data to be settled | no |
| K020 | `exception_refund_amount_wrong` | The amount entered cannot be greater than the refundable amount | no |
| K021 | `exception_origin_trans_no_complete` | The original transaction has not been completed and cannot be followed up | no |
| K028 | `exception_origin_trans_not_bankcard` | The original transaction was not a card transaction | no |
| K035 | `exception_refund_able_amount_wrong` | This order has been fully refunded | no |
| K039 | `exception_cashback_exceeds_limit` | Cash back amount exceeds the limit. | no |

K022, K023, K034 and K038 are absent from this build — not reserved, just not present.

### Why the four NEVERs matter more than the rest

They arrive on the **identical** `RESULT_OK` + `result` path as K026. A wildcard on `K0*`, or any
match on the word "cancel", bypasses verification on exactly the codes most likely to be sitting
on top of a real charge. K027 is the worst case: its own message tells the operator to check
transaction status before retrying, and it is a *timeout*, which is the canonical
money-may-have-moved outcome. K036/K037 imply an authorisation existed, because a reversal
must have something to reverse — and K037 says the reversal failed.

The "no" group (K024/K025/K029–K033) genuinely cannot have charged: they are pre-transaction
device and configuration failures, raised before a card is read. They are held on the
verification path anyway, because they are **not cancellations** and the fast-cancel writes
`cancellationReason: terminal_cancelled_by_user_pre_gateway` into the ledger. Recording
"operator cancelled" for a flat battery would be false. Giving them a *distinct* reason
requires a server change: the bypass is an exact string match with adjacent values pinned as
non-bypassing (see `TERMINAL_USER_CANCELLED_REASON` in `src/lib/payment.ts`).

### K024 and K031 are not ordinary config errors — the harm is to OTHER orders

Worth separating out, because the reason is non-obvious and the general "not a cancellation"
argument undersells it.

K031 "Please settle first" and K024 "Settlement failed, need to perform batch upload" are the
only two codes in the "no" group that say something about **money that has already been taken**.
An unsettled batch is a set of prior transactions that were authorised but not yet submitted to
the acquirer. For the order in front of you they mean the same thing as a flat battery — no card
was read, no charge is possible. The difference is what they imply about everything else.

If these silently fast-cancel, staff see an order vanish, shrug, and retry. Nothing tells them a
batch is sitting unsettled, so nothing gets settled. Unsettled authorisations expire. The
merchant loses revenue **on completed sales that already happened**, and the loss is invisible
in FlashTap because those orders are already marked paid — the failure is entirely on the
acquirer side. K024 is the sharper of the two: a settlement was attempted and *failed*, so
something is already wrong rather than merely pending.

So the case for holding these on the verification path is not just ledger hygiene. Suppressing
them converts a recoverable operational alert into silent revenue loss, and the order that
triggers the alert is the least important thing about it.

The same logic is the strongest argument for #182 (surfacing the real message to staff): "Please
settle first" is actionable at the till in a way that "gateway result=K031" is not.

## K026 means operator abort, and only that

All 14 raise sites in v2.1.6.42, every one an abort **before authorisation**:

- `AuthorizationCloudPageKt.AuthorizationCloudPage$onCancel` — the operator cancel we captured
- `CheckCardPageKt` ×2, `CheckCardViewModel.onAction` ×3 — cancel while waiting for the card
- `CheckCardViewModel$startCheckCard$1$2$1.onInformTransResult` ×2 — card-read abort, routed
  through `showReadCardFail`; card reading precedes authorisation
- `ManualInputPageKt` — manual PAN entry cancelled
- `ConfirmOrderPageKt.ConfirmOrderPage$onBackClicked`, `DebiCheckSubmitPage$onBackClicked`,
  `QrCodePage$onBackClicked`, `ScanPage$onBackClicked` — back out of a pre-payment screen
- `EcrMainViewModel` / `EcrOrderPageKt` — ECR protocol cancel

Not one is a gateway response handler. K026 is never a decline.

## Other code families

The space is wider than K. `A`, `C`, `G`, `K` and `N` families all exist — `G000`, `G004`,
`C000`, `C009`, `C014`, `A008` appear in the card-read path alone, and our own
`KNOWN_DECLINE_CODES = setOf("N003")` is a single member of the N family, inferred from one
observed decline under the since-disproven assumption that `RESULT_OK` meant the gateway had
responded. Each family has its own `*ExceptionMapper` in
`com.wiseasy.cashier.comm.exception.mapper`: `Init`, `Network`, `Package`, `PinPad`, `Print`,
`ReadCard`, `Sdk`, `Server`, `ThirdPay`, `Transaction`, `Unknown`, `User`.

Only the `Transaction` family is tabulated above, because it is the one the SALE intent
returns. Re-deriving the decline/ambiguous classification against the full set is open work.

## Reproducing this

```sh
unzip -q <wisecashier>.apk -d wc
aapt2 dump resources <wisecashier>.apk > wc_resources.txt   # code -> English text
dexdump -d wc/classes3.dex > dex3.txt                       # mappers live here
dexdump -d wc/classes2.dex > dex2.txt                       # raise sites live here
```

In `TransactionExceptionMapper.getExceptionMessage`, each `const-string vN, "Kxxx"` is followed
by a `String.equals` and, on match, the `sget R$string.<resource>` that is its message. Resolve
the resource name against `wc_resources.txt`.
