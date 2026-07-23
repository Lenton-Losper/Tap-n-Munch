package com.flashtap.pos

import android.content.Intent
import android.util.Log
import com.flashtapterminal.BuildConfig
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Locale
import org.json.JSONObject

class PaymentModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "PaymentModule"

  private fun generateMerchantOrderNo(orderId: String): String {
    val cleanOrderId = orderId.replace("-", "").take(20)
    val timestamp = System.currentTimeMillis().toString().takeLast(12)
    return (cleanOrderId + timestamp).take(32)
  }

  @ReactMethod
  fun launchPayment(
    amount: String,
    orderId: String,
    merchantOrderNo: String,
    promise: Promise,
  ) {
    val activity = getCurrentActivity() ?: run {
      promise.reject("NO_ACTIVITY", "No current activity")
      return
    }

    try {
      // Backend-owned value from POST /api/terminal/orders/{id}/prepare-payment — must match
      // orders.paycloud_merchant_order_no so Finatic webhooks can correlate. Do not mint here.
      val trimmedMerchantOrderNo = merchantOrderNo.trim()
      if (trimmedMerchantOrderNo.isEmpty()) {
        promise.reject(
          "MISSING_MERCHANT_ORDER_NO",
          "merchantOrderNo is required; call prepare-payment before launching Finatic",
        )
        return
      }
      if (trimmedMerchantOrderNo.length > 32) {
        promise.reject(
          "INVALID_MERCHANT_ORDER_NO",
          "merchantOrderNo exceeds Finatic 32-character limit",
        )
        return
      }

      Log.d(
        "PaymentModule",
        "orderId=$orderId merchantOrderNo=$trimmedMerchantOrderNo length=${trimmedMerchantOrderNo.length}",
      )

      val paddedAmount = String.format(Locale.US, "%012d", amount.toLong())

      val transData =
        JSONObject().apply {
          put("businessOrderNo", trimmedMerchantOrderNo)
          put("paymentScenario", "CARD")
          put("amt", paddedAmount)
          put("notifyUrl", BuildConfig.NOTIFY_URL)
          put("POSMode", "1")
        }

      Log.d("PaymentModule", "transData=$transData")

      val intent =
        Intent().apply {
          action = "com.wiseasy.transaction.call"
          putExtra("version", "A01")
          putExtra("appId", "wz66363c6bb9592fb5")
          putExtra("transType", "SALE")
          putExtra("loginMode", "LoginFree")
          putExtra("transData", transData.toString())
        }

      pendingPromise = promise
      activity.startActivityForResult(intent, PAYMENT_REQUEST_CODE)
    } catch (e: Exception) {
      pendingPromise = null
      promise.reject("INTENT_ERROR", e.message, e)
    }
  }

  @ReactMethod
  fun launchRefund(
    amount: String,
    originBusinessOrderNo: String,
    promise: Promise,
  ) {
    val activity = getCurrentActivity() ?: run {
      promise.reject("NO_ACTIVITY", "No current activity")
      return
    }

    try {
      val refundBusinessOrderNo = generateMerchantOrderNo(originBusinessOrderNo)

      Log.d(
        "PaymentModule",
        "refundBusinessOrderNo=$refundBusinessOrderNo originBusinessOrderNo=$originBusinessOrderNo",
      )

      val paddedAmount = String.format(Locale.US, "%012d", amount.toLong())

      val transData =
        JSONObject().apply {
          put("originBusinessOrderNo", originBusinessOrderNo)
          put("businessOrderNo", refundBusinessOrderNo)
          put("amt", paddedAmount)
          put("paymentScenario", "CARD")
          put("notifyUrl", BuildConfig.NOTIFY_URL)
          put("POSMode", "1")
        }

      Log.d("PaymentModule", "refund transData=$transData")

      val intent =
        Intent().apply {
          action = "com.wiseasy.transaction.call"
          putExtra("version", "A01")
          putExtra("appId", "wz66363c6bb9592fb5")
          putExtra("transType", "REFUND")
          putExtra("loginMode", "LoginFree")
          putExtra("transData", transData.toString())
        }

      pendingPromise = promise
      activity.startActivityForResult(intent, REFUND_REQUEST_CODE)
    } catch (e: Exception) {
      pendingPromise = null
      promise.reject("INTENT_ERROR", e.message, e)
    }
  }

  companion object {
    const val PAYMENT_REQUEST_CODE = 1001
    const val REFUND_REQUEST_CODE = 1002
    var pendingPromise: Promise? = null
  }
}
