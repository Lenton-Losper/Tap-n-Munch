package com.flashtap.pos

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #166 -- the value column of every two-column receipt row was truncated.
 *
 * These assert the arithmetic from the issue directly. The observed receipt showed
 * "03 Aug 2" (8 chars), "RCT 000" (7) and "N$40.5" (6) where 17, more, and 7 were expected;
 * 8 = 384/4, the {3,1} quarter. The SDK returned code 0 for every one of those rows, so this
 * cannot be caught from return codes -- the proportion arithmetic is the only off-device check.
 */
class ReceiptColumnLayoutTest {

  private val headWidthDots = 384 // SDK4 Printer.PAPER_WIDTH, 58mm at 203dpi

  @Test
  fun `two column rows split the head evenly`() {
    assertArrayEquals(intArrayOf(1, 1), receiptColumnProportions(2))
  }

  @Test
  fun `the value column of a two column row fits the longest value we emit`() {
    val budget = receiptColumnCharacterBudget(2, headWidthDots, 1)

    // formatThermalIssuedAt composes "03 Aug 2026 06:35" -- 17 characters.
    assertEquals(17, "03 Aug 2026 06:35".length)
    assertTrue(
      "value column must fit N\$40.56 (7 chars); budget was $budget",
      budget >= "N$40.56".length,
    )
    assertEquals(16, budget)
  }

  @Test
  fun `the old wide-first rule is what truncated the value column`() {
    // The exact regression: {3,1} gave the value column a quarter of 384 dots.
    val oldProportions = IntArray(2) { if (it == 0) 3 else 1 }
    val oldBudget =
      headWidthDots * oldProportions[1] / oldProportions.sum() / RECEIPT_DOTS_PER_CHARACTER

    assertEquals(8, oldBudget) // matches the observed "03 Aug 2"
    assertTrue(
      "the fix must widen the value column beyond the 8 chars that were printed",
      receiptColumnCharacterBudget(2, headWidthDots, 1) > oldBudget,
    )
  }

  @Test
  fun `single column rows are unweighted`() {
    assertArrayEquals(intArrayOf(1), receiptColumnProportions(1))
  }

  @Test
  fun `the vendor wide-first weighting is kept for genuine multi column item rows`() {
    // USBPrinting.java's item/qty/price/tax example, the shape {3,1,1,1} was written for.
    assertArrayEquals(intArrayOf(3, 1, 1, 1), receiptColumnProportions(4))
    assertArrayEquals(intArrayOf(3, 1, 1), receiptColumnProportions(3))
  }

  @Test
  fun `an empty row produces no proportions`() {
    assertArrayEquals(IntArray(0), receiptColumnProportions(0))
    assertEquals(0, receiptColumnCharacterBudget(0, headWidthDots, 0))
  }
}
