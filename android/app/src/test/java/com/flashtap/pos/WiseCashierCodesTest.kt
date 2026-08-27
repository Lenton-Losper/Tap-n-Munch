package com.flashtap.pos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The safety properties of the WiseCashier result-code tables (#182 / #184).
 *
 * WHY THESE EXIST. USER_CANCEL_RESULT_CODES decides whether an order takes the no-gateway-attempt
 * bypass — skipping Finatic verification entirely and writing "operator cancelled" into the ledger.
 * Widen it by one wrong code and a payment that may well have gone through is silently recorded as
 * a cancel. Nothing throws, nothing looks wrong in review, and the money is on the acquirer's side
 * where FlashTap cannot see it.
 *
 * Until this file the tables were `private val`s on MainActivity's companion, which junit cannot
 * reach because an Android Activity cannot be constructed there. So the most consequential
 * constants in the app were covered by nothing at all.
 *
 * The assertions below are deliberately about the RULE, not a transcription of the current values.
 * A test that just restated the sets would pass against any edit that changed both it and the
 * source, which is the failure mode of a snapshot.
 */
class WiseCashierCodesTest {

  @Test
  fun `K026 is the only code permitted to bypass gateway verification`() {
    // The entire bypass surface, in one assertion. Everything else must be verified.
    assertEquals(setOf("K026"), WiseCashierCodes.USER_CANCEL_RESULT_CODES)
  }

  @Test
  fun `the codes the table marks NEVER can never bypass`() {
    // K027 is the worst case: a timeout, whose own vendor message tells the operator to check
    // transaction status before retrying. K036/K037 imply an authorisation existed, since a
    // reversal must have something to reverse.
    for (code in WiseCashierCodes.NEVER_BYPASS_CODES) {
      assertFalse(
        "$code must never take the no-gateway-attempt bypass",
        WiseCashierCodes.USER_CANCEL_RESULT_CODES.contains(code),
      )
    }
  }

  @Test
  fun `the never-bypass set covers every code the doc marks NEVER`() {
    // Guards the guard: if NEVER_BYPASS_CODES were emptied, the test above would pass vacuously.
    assertEquals(
      setOf("K027", "K017", "K036", "K037", "K009"),
      WiseCashierCodes.NEVER_BYPASS_CODES,
    )
  }

  @Test
  fun `no code with staff display text may also bypass`() {
    // The two tables are independent, and a code appearing in both would mean staff are shown an
    // explanation for a payment that was simultaneously recorded as an operator cancel.
    for (code in WiseCashierCodes.STAFF_FAILURE_MESSAGES.keys) {
      assertFalse(
        "$code carries staff display text and must stay on the verification path",
        WiseCashierCodes.USER_CANCEL_RESULT_CODES.contains(code),
      )
    }
  }

  @Test
  fun `a decline code is never also a cancel code`() {
    // A confirmed decline skips verification too, but records a DECLINE rather than a cancel.
    // Overlap would make the outcome depend on branch ordering in MainActivity.
    for (code in WiseCashierCodes.KNOWN_DECLINE_CODES) {
      assertFalse(
        "$code cannot be both a decline and an operator cancel",
        WiseCashierCodes.USER_CANCEL_RESULT_CODES.contains(code),
      )
    }
  }

  @Test
  fun `K024 has staff text, because a failed settlement is about money already taken`() {
    // #182's gap. An unsettled batch is prior transactions authorised but never submitted to the
    // acquirer; those authorisations expire, and the loss is invisible in FlashTap because the
    // orders are already marked paid. A generic "not a confirmed success" here turns a
    // recoverable operational alert into silent revenue loss.
    assertEquals(
      "Settlement failed, need to perform batch upload",
      WiseCashierCodes.STAFF_FAILURE_MESSAGES["K024"],
    )
    // Its sibling, the other code that implies money already taken.
    assertEquals("Please settle first", WiseCashierCodes.STAFF_FAILURE_MESSAGES["K031"])
  }

  @Test
  fun `staff text exists for the actionable pre-transaction codes`() {
    // The "Bypass: no" group from the doc that a staff member can actually do something about.
    for (code in listOf("K024", "K025", "K029", "K030", "K031", "K032", "K033")) {
      assertNotNull(
        "$code should show staff something better than a raw code",
        WiseCashierCodes.STAFF_FAILURE_MESSAGES[code],
      )
    }
  }

  @Test
  fun `codes that may have charged are NOT given reassuring staff text`() {
    // The other side, and the one that matters. These fall through to the generic message and the
    // Finatic verify on purpose: inventing friendly text for a timeout would imply to staff that
    // nothing happened, which is exactly what a timeout cannot promise.
    for (code in WiseCashierCodes.NEVER_BYPASS_CODES) {
      assertNull(
        "$code may have charged and must not carry reassuring staff text",
        WiseCashierCodes.STAFF_FAILURE_MESSAGES[code],
      )
    }
  }

  @Test
  fun `the decline set stays narrow`() {
    // Every code here skips the Finatic verify round-trip, so growth is the risk. N003 was
    // confirmed against real gateway behaviour in the 2026-07-28 Finatic-UAT investigation;
    // nothing else has been.
    assertEquals(setOf("N003"), WiseCashierCodes.KNOWN_DECLINE_CODES)
  }

  @Test
  fun `an unknown code takes no shortcut`() {
    // The safe default, stated as a property: anything not explicitly listed must be verified.
    for (code in listOf("K999", "", "00", "N001", "k026", " K026 ")) {
      assertFalse(
        "'$code' must not be treated as an operator cancel",
        WiseCashierCodes.USER_CANCEL_RESULT_CODES.contains(code),
      )
    }
    // Note 'k026' and ' K026 ': matching is exact and case-sensitive by design, because the code
    // arrives verbatim from WiseCashier's `result` extra. A normalising match would be a widening.
    assertTrue(WiseCashierCodes.USER_CANCEL_RESULT_CODES.contains("K026"))
  }
}
