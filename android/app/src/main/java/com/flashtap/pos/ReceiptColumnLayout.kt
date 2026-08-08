package com.flashtap.pos

/**
 * Column weighting for SDK4's Printer.printMultiseriateString, which takes a PROPORTION array
 * and divides the head width itself.
 *
 * Deliberately free of any Android or Wiseasy SDK import so it can be unit-tested on the JVM:
 * the truncation this governs is invisible from return codes (#166 -- the SDK reported code 0
 * for every row while silently dropping characters), so the arithmetic is the only thing that
 * can be checked off-device.
 *
 * History: the original rule was `if (index == 0 && count > 1) 3 else 1`, copied from the
 * vendor demo's FOUR-column item/qty/price/tax example (USBPrinting.java:304-312) and applied
 * to two-column rows as well. On a two-column row that is {3,1}: the value column gets one
 * quarter of the head. At 384 dots that is 96 dots, about 8 characters at font size 25 --
 * "03 Aug 2026 06:35" printed as "03 Aug 2", "N$40.56" as "N$40.5". On a receipt the value is
 * the part that must not be lost.
 */

/** 384-dot head at font size 25 fits ~32 characters, so ~12 dots per character. */
const val RECEIPT_DOTS_PER_CHARACTER = 12

/**
 * Weighting depends on the column count rather than a fixed "first column wide" rule.
 *
 * - 2 columns (every row sdk6Renderer.ts emits today): {1,1}. Label left, value right, each
 *   getting half the head -- 192 dots, ~16 characters, enough for the longest value we emit.
 * - 3 or more: the vendor's wide-first weighting is kept, because that is the shape it was
 *   written for (a long item name against short numeric columns).
 */
fun receiptColumnProportions(count: Int): IntArray =
  when {
    count <= 0 -> IntArray(0)
    count == 1 -> intArrayOf(1)
    count == 2 -> intArrayOf(1, 1)
    else -> IntArray(count) { if (it == 0) 3 else 1 }
  }

/**
 * Characters that survive in the widest column of a row, for a given head width. Used by the
 * tests to state the truncation budget explicitly rather than trusting a printer return code.
 */
fun receiptColumnCharacterBudget(count: Int, headWidthDots: Int, columnIndex: Int): Int {
  val proportions = receiptColumnProportions(count)
  if (columnIndex !in proportions.indices) {
    return 0
  }
  val total = proportions.sum()
  if (total <= 0) {
    return 0
  }
  return headWidthDots * proportions[columnIndex] / total / RECEIPT_DOTS_PER_CHARACTER
}
