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

    if (requestCode == PaymentModule.PAYMENT_REQUEST_CODE) {
      val promise = PaymentModule.pendingPromise ?: return

      if (resultCode == Activity.RESULT_OK && data != null) {
        val result = data.getStringExtra("result")
        if (result == "00") {
          val transDataJson = data.getStringExtra("transData")
          var voucherNo = ""
          var businessOrderNo = ""

          if (!transDataJson.isNullOrEmpty()) {
            try {
              val transData = JSONObject(transDataJson)
              voucherNo = transData.optString("transactionID", "")
              businessOrderNo = transData.optString("businessOrderNo", "")
            } catch (_: Exception) {
              // Fall back to empty strings if transData is malformed
            }
          }

          if (voucherNo.isBlank()) {
            promise.reject("PAYMENT_FAILED", "No transaction ID returned from WiseCashier")
          } else {
            val resultMap = Arguments.createMap()
            resultMap.putString("voucherNo", voucherNo)
            resultMap.putString("businessOrderNo", businessOrderNo)
            promise.resolve(resultMap)
          }
        } else {
          promise.reject("PAYMENT_FAILED", "Payment was cancelled or failed")
        }
      } else {
        promise.reject("PAYMENT_FAILED", "Payment was cancelled or failed")
      }

      PaymentModule.pendingPromise = null
      return
    }

    if (requestCode == PaymentModule.REFUND_REQUEST_CODE) {
      val promise = PaymentModule.pendingPromise ?: return

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
