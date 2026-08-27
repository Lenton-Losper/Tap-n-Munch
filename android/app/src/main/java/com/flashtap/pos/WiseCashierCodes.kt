package com.flashtap.pos

/**
 * The WiseCashier result-code tables, and the only place they are declared.
 *
 * WHY THIS IS A PURE OBJECT AND NOT A COMPANION ON MainActivity. These three tables decide, on the
 * money path, whether an order skips Finatic verification. Getting one wrong does not throw and
 * does not look wrong in review — it silently marks a possibly-charged order as cancelled. While
 * they lived as `private val`s inside a ReactActivity, nothing could reach them: an Android
 * Activity cannot be constructed under plain junit, so the most safety-critical constants in the
 * app had no test at all. Here they are plain data with no Android imports, and
 * WiseCashierCodesTest pins the properties that matter.
 *
 * The full recovered table — 22 transaction codes, their string resources and the reasoning behind
 * each bypass decision — is in docs/wisecashier-result-codes.md. It was recovered by decompiling
 * WiseCashier 2.1.6.42; it is not in any vendor documentation.
 */
object WiseCashierCodes {

  /**
   * Gateway result codes confirmed to mean a clean card decline with NO charge, via the
   * 2026-07-28 Finatic-UAT NAD 11.99 staging decline investigation.
   *
   * These skip the Finatic verify round-trip, so only add a code once it has been confirmed
   * against real gateway behaviour. Everything else stays PAYMENT_AMBIGUOUS and is verified, per
   * the safe-default policy the REFUND path also follows (it deliberately declines to guess
   * DECLINE vs FAILED for codes it has not confirmed).
   *
   * N-family, not K-family: these come from the gateway, whereas the K codes below are
   * WiseCashier's own transaction exceptions.
   */
  val KNOWN_DECLINE_CODES = setOf("N003")

  /**
   * Gateway result codes that mean THE OPERATOR ABORTED before the gateway was contacted.
   *
   * WiseCashier does not use RESULT_CANCELED. Its failure return is
   * AppInvokeUtilKt.onAppInvokeFail, which is hardcoded:
   *
   *     intent.putExtra("result",    exceptionCode)
   *     intent.putExtra("resultMsg", exceptionMsg)
   *     intent.putExtra("version",   "A01")
   *     activity.setResult(-1, intent)   // RESULT_OK, unconditionally
   *
   * so EVERY failure — cancel, timeout, flat battery — arrives as RESULT_OK and is distinguished
   * only by `result`. Confirmed on a UAT P5 on 2026-08-09 (vc82 wiretap): resultCode -1,
   * result=K026, resultMsg="[K026]Manual cancellation by operator".
   *
   * NARROW ON PURPOSE. K026 is one of 22 codes in TransactionExceptionMapper, and several of its
   * siblings must NEVER take the no-gateway-attempt bypass:
   *   K027 "Transaction timeout ... check transaction status before making another payment"
   *   K017 "Transaction processing"
   *   K036 / K037 auto-reversal succeeded / FAILED — a reversal implies an authorisation
   *   K009 "Unknown Transaction Exception"
   * Those arrive on this identical path and must keep falling through to Finatic verify. Do not
   * widen this set without device evidence for the specific code being added.
   *
   * Matched on the CODE, never on resultMsg: resultMsg is composed by
   * CommonException.getExceptionMessage() as '[' + code + ']' + a LOCALISED string resource
   * (string/exception_manual_cancel), so its text changes with device language.
   *
   * K026 means operator abort and nothing else — all 14 of its raise sites in WiseCashier 2.1.6.42
   * are cancel/back handlers or a card-read abort, every one of them before authorisation. It is
   * never a decline.
   */
  val USER_CANCEL_RESULT_CODES = setOf("K026")

  /**
   * The four codes the doc marks NEVER — they must not bypass verification under any future edit.
   *
   * Declared so the test can assert against them by name rather than restating a list in an
   * assertion, and so that widening USER_CANCEL_RESULT_CODES to include one fails loudly instead
   * of silently marking a possibly-charged order as an operator cancel. K027 is the worst case:
   * its own vendor message tells the operator to check transaction status before retrying, and a
   * timeout is the canonical money-may-have-moved outcome.
   */
  val NEVER_BYPASS_CODES = setOf("K027", "K017", "K036", "K037", "K009")

  /**
   * #182: staff-facing text for the pre-transaction WiseCashier failure codes that are actionable
   * at the till, replacing the generic "Payment result was not a confirmed success" with something
   * a staff member can act on (e.g. "flat battery" rather than a raw K029). The English is
   * WiseCashier's own, transcribed from TransactionExceptionMapper's string resources — not copy
   * authored here.
   *
   * DISPLAY TEXT ONLY. Every code here stays in the doc's "Bypass: no" group and falls through to
   * the same PAYMENT_AMBIGUOUS branch as before, still going through Finatic verify. Every message
   * built from this map keeps the trailing "(gateway result=$code)" suffix intact, because
   * src/lib/payment.ts's extractGatewayResult() regexes it back out for the audit reference, and
   * the ambiguous-classification regex in the same file also matches on message text as a
   * fallback — changing wording must never break either.
   *
   * K024 IS HERE FOR A DIFFERENT REASON THAN THE REST, and it is the reason the doc singles it out.
   * The others are device or configuration faults local to the terminal in front of you. K024 and
   * K031 are the only two that say something about money ALREADY TAKEN: an unsettled batch is a
   * set of prior transactions that were authorised but never submitted to the acquirer. For the
   * order on screen they mean the same thing as a flat battery — no card was read. The difference
   * is what they imply about everything else: unsettled authorisations expire, and the loss is
   * invisible in FlashTap because those orders are already marked paid. Showing staff a generic
   * "not a confirmed success" here converts a recoverable operational alert into silent revenue
   * loss. K024 is the sharper of the two — a settlement was attempted and FAILED, so something is
   * already wrong rather than merely pending — and it was the one code missing from this map.
   */
  val STAFF_FAILURE_MESSAGES = mapOf(
    "K024" to "Settlement failed, need to perform batch upload",
    "K025" to "Need Sign In",
    "K029" to "Battery too low to trade. Please charge your device first.",
    "K030" to "The remote card reader is not connected!",
    "K031" to "Please settle first",
    "K032" to "Please load emv parameters",
    "K033" to "Key Not Injected",
  )
}
