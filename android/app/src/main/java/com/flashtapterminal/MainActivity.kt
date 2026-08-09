package com.flashtapterminal

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.facebook.react.bridge.Arguments
import com.flashtap.pos.PaymentModule
import com.flashtap.pos.WisePosSdkBootstrap
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import org.json.JSONObject

class MainActivity : ReactActivity() {

  companion object {
    // Gateway result codes confirmed (via the 2026-07-28 Finatic-UAT NAD 11.99 staging
    // decline investigation) to mean a clean card decline with no charge. Only add a code
    // here once it's been confirmed against real gateway behavior — everything else stays
    // PAYMENT_AMBIGUOUS and goes through Finatic verify, per the existing safe-default
    // policy (see the REFUND path below, which deliberately declines to guess DECLINE vs
    // FAILED for codes it hasn't confirmed).
    private val KNOWN_DECLINE_CODES = setOf("N003")

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
     * so EVERY failure — cancel, timeout, flat battery — arrives as RESULT_OK and is
     * distinguished only by `result`. Confirmed on a UAT P5 on 2026-08-09 (vc82 wiretap):
     * resultCode -1, result=K026, resultMsg="[K026]Manual cancellation by operator".
     *
     * NARROW ON PURPOSE. K026 is one of 22 codes in TransactionExceptionMapper, and several
     * of its siblings must NEVER take the no-gateway-attempt bypass:
     *   K027 "Transaction timeout ... check transaction status before making another payment"
     *   K017 "Transaction processing"
     *   K036 / K037 auto-reversal succeeded / FAILED — a reversal implies an authorisation
     *   K009 "Unknown Transaction Exception"
     * Those arrive on this identical path and must keep falling through to Finatic verify.
     * See docs/wisecashier-result-codes.md for the full table. Do not widen this set without
     * device evidence for the specific code being added.
     *
     * Matched on the CODE, never on resultMsg: resultMsg is composed by
     * CommonException.getExceptionMessage() as '[' + code + ']' + a LOCALISED string resource
     * (string/exception_manual_cancel), so its text changes with device language.
     *
     * K026 means operator abort and nothing else — all 14 of its raise sites in WiseCashier
     * 2.1.6.42 are cancel/back handlers or a card-read abort, every one of them before
     * authorisation. It is never a decline.
     */
    private val USER_CANCEL_RESULT_CODES = setOf("K026")
  }

  override fun getMainComponentName(): String = "FlashTapTerminal"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // SDKDemo MainActivity.onCreate: bind WisePos + WiseDevice before any printer use.
    WisePosSdkBootstrap.start(this)
  }

  override fun onResume() {
    super.onResume()
    // If cold-start bind raced or failed, retry when the activity is foregrounded.
    if (!WisePosSdkBootstrap.isPosReady()) {
      WisePosSdkBootstrap.start(this)
    }
  }

  @Deprecated("Deprecated in Java")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)

    // INSTRUMENTATION (vc82). Verbatim capture BEFORE any of the classification below runs, and
    // for EVERY request code — including ones we do not recognise, since "the result came back
    // under a different request code" is one of the live hypotheses for the 2026-08-07 cancel
    // that did not take the RESULT_CANCELED branch. Read it on Diagnostics; there is no ADB on
    // these terminals. Records only; changes no outcome.
    PaymentModule.recordActivityReturn(this, requestCode, resultCode, data)

    if (requestCode == PaymentModule.PAYMENT_REQUEST_CODE) {
      val resultExtra = data?.getStringExtra("result")
      val transDataJson = data?.getStringExtra("transData")
      var voucherNo = ""
      var businessOrderNo = ""
      if (!transDataJson.isNullOrEmpty()) {
        try {
          val transData = JSONObject(transDataJson)
          voucherNo = transData.optString("transactionID", "")
          businessOrderNo = transData.optString("businessOrderNo", "")
        } catch (_: Exception) {
          // Malformed transData — treat as missing voucher below.
        }
      }

      val promise = PaymentModule.pendingPromise
      if (promise == null) {
        val outcome =
          when {
            resultCode == Activity.RESULT_OK && resultExtra == "00" && voucherNo.isNotBlank() ->
              "success"
            resultCode == Activity.RESULT_OK && resultExtra == "00" -> "ambiguous"
            // Same split as the promise path above: an orphaned USER CANCEL must not be
            // reported as ambiguous, or it strands exactly as before.
            resultCode == Activity.RESULT_OK &&
              USER_CANCEL_RESULT_CODES.contains(resultExtra) -> "user_cancelled"
            resultCode == Activity.RESULT_CANCELED -> "user_cancelled"
            else -> "ambiguous"
          }
        val errorMessage =
          when (outcome) {
            "success" -> "Orphaned success callback (pendingPromise was null)"
            else ->
              "Orphaned non-success or incomplete callback (pendingPromise was null)"
          }
        PaymentModule.handleNullPromiseSaleResult(
          context = this,
          resultCode = resultCode,
          data = data,
          voucherNo = voucherNo,
          businessOrderNo = businessOrderNo,
          gatewayResult = resultExtra,
          outcome = outcome,
          errorMessage = errorMessage,
        )
        return
      }

      if (resultCode == Activity.RESULT_OK && data != null) {
        if (USER_CANCEL_RESULT_CODES.contains(resultExtra)) {
          // Checked BEFORE the "00" success test. K026 can never be "00", so the ordering is
          // defensive rather than load-bearing -- but a cancel must never be reachable through
          // the success or decline branches, whatever a future edit does to them.
          //
          // Same rejection code as the RESULT_CANCELED branch below, so both converge on
          // outcomeKind 'user_cancelled' -> cancellationReason + noGatewayAttempt -> the server
          // skips a Finatic verify that would return E04111 and strand the order.
          promise.reject(
            "PAYMENT_CANCELLED_BY_USER",
            "Payment was cancelled on the reader before the gateway was contacted " +
              "(gateway result=$resultExtra)",
          )
        } else if (resultExtra == "00") {
          if (voucherNo.isBlank()) {
            // Ambiguous: gateway said success code but no transaction id for FlashTap to trust.
            promise.reject(
              "PAYMENT_AMBIGUOUS",
              "No transaction ID returned from WiseCashier",
            )
          } else {
            val resultMap = Arguments.createMap()
            resultMap.putString("voucherNo", voucherNo)
            resultMap.putString("businessOrderNo", businessOrderNo)
            promise.resolve(resultMap)
          }
        } else if (KNOWN_DECLINE_CODES.contains(resultExtra)) {
          // Confirmed no-charge decline (see KNOWN_DECLINE_CODES) — safe to report as a
          // confirmed failure without a Finatic verify round-trip.
          promise.reject(
            "PAYMENT_DECLINED",
            "Card declined by gateway (gateway result=$resultExtra)",
          )
        } else {
          promise.reject(
            "PAYMENT_AMBIGUOUS",
            "Payment result was not a confirmed success (gateway result=$resultExtra)",
          )
        }
      } else if (resultCode == Activity.RESULT_CANCELED) {
        // The operator dismissed WiseCashier before the reader contacted the gateway, so no
        // payment order can exist. Mirrors the REFUND path below, which has always done this.
        //
        // Keyed on the RESULT_CANCELED CONSTANT ONLY -- never on message text, and never via
        // the ambiguous bucket. Note this deliberately does NOT catch RESULT_OK with null
        // data: that is a genuinely unknown outcome and must stay ambiguous, because a card
        // may have been charged. Widening this branch would start swallowing real declines.
        promise.reject(
          "PAYMENT_CANCELLED_BY_USER",
          "Payment was cancelled on the reader before the gateway was contacted",
        )
      } else {
        promise.reject(
          "PAYMENT_AMBIGUOUS",
          "Payment returned without a usable result",
        )
      }

      PaymentModule.clearAfterHandled(this)
      return
    }

    if (requestCode == PaymentModule.REFUND_REQUEST_CODE) {
      val promise = PaymentModule.pendingPromise
      if (promise == null) {
        android.util.Log.e(
          "MainActivity",
          "CRITICAL: REFUND onActivityResult with null pendingPromise — " +
            "androidResultCode=$resultCode (refund outcome not delivered to JS)",
        )
        return
      }

      try {
        // CANCELLED: activity returned without usable gateway extras
        // (user backed out / no RESULT_OK / missing Intent data).
        if (resultCode != Activity.RESULT_OK || data == null) {
          val resultMap = Arguments.createMap()
          resultMap.putString("status", "CANCELLED")
          resultMap.putBoolean("retryable", false)
          val gateway = Arguments.createMap()
          gateway.putString("code", "")
          gateway.putString("message", "Refund was cancelled")
          resultMap.putMap("gateway", gateway)
          promise.resolve(resultMap)
          return
        }

        val resultCodeStr = data.getStringExtra("result") ?: ""
        val resultMsg = data.getStringExtra("resultMsg") ?: ""

        var transactionId = ""
        var businessOrderNo = ""
        val transDataJson = data.getStringExtra("transData")
        if (!transDataJson.isNullOrEmpty()) {
          try {
            val transData = JSONObject(transDataJson)
            transactionId = transData.optString("transactionID", "")
            businessOrderNo = transData.optString("businessOrderNo", "")
          } catch (e: Exception) {
            // Infrastructure/transport failure: malformed gateway payload
            promise.reject("REFUND_PARSE_ERROR", e.message, e)
            return
          }
        }

        // DECLINED vs FAILED: WiseCashier only returns opaque result/resultMsg.
        // There is no field that reliably distinguishes "issuer declined" from
        // terminal/network errors (J000–J006, Z000, etc.). Mapping all non-00 /
        // non-K018 gateway outcomes to FAILED rather than guessing DECLINED.
        val (status, retryable) =
          when (resultCodeStr) {
            "00" -> "APPROVED" to false
            "K018" -> "WRONG_CARD" to true
            else -> "FAILED" to false
          }

        val resultMap = Arguments.createMap()
        resultMap.putString("status", status)
        resultMap.putBoolean("retryable", retryable)
        if (transactionId.isNotBlank()) {
          resultMap.putString("transactionId", transactionId)
        }
        if (businessOrderNo.isNotBlank()) {
          resultMap.putString("businessOrderNo", businessOrderNo)
        }
        val gateway = Arguments.createMap()
        gateway.putString("code", resultCodeStr)
        gateway.putString("message", resultMsg)
        resultMap.putMap("gateway", gateway)
        promise.resolve(resultMap)
      } finally {
        PaymentModule.pendingPromise = null
      }
    }
  }
}
