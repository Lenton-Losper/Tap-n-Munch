package com.flashtap.pos

import android.content.Context
import android.content.Intent
import android.util.Log
import com.flashtapterminal.BuildConfig
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale
import org.json.JSONObject

class PaymentModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  init {
    // Keep a process-wide handle so MainActivity can emit when the Promise is gone.
    appContext = reactContext
  }

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
        TAG,
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

      Log.d(TAG, "transData=$transData")

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
      persistPendingLaunch(
        reactContext,
        requestCode = PAYMENT_REQUEST_CODE,
        orderId = orderId,
        merchantOrderNo = trimmedMerchantOrderNo,
      )
      activity.startActivityForResult(intent, PAYMENT_REQUEST_CODE)
    } catch (e: Exception) {
      pendingPromise = null
      clearPendingLaunch(reactContext)
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
        TAG,
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

      Log.d(TAG, "refund transData=$transData")

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

  /**
   * JS recovery path when onActivityResult arrived with a null pendingPromise
   * (process death / bridge tear-down / double delivery). Returns one orphaned
   * SALE result map or null.
   */
  @ReactMethod
  fun consumeOrphanedPaymentResult(promise: Promise) {
    try {
      val prefs = reactContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val raw = prefs.getString(KEY_ORPHANED_RESULT, null)
      if (raw.isNullOrBlank()) {
        promise.resolve(null)
        return
      }
      prefs.edit().remove(KEY_ORPHANED_RESULT).apply()
      val json = JSONObject(raw)
      val map = Arguments.createMap()
      map.putString("outcome", json.optString("outcome", "ambiguous"))
      map.putString("gatewayResult", json.optString("gatewayResult", ""))
      map.putInt("androidResultCode", json.optInt("androidResultCode", 0))
      map.putString("voucherNo", json.optString("voucherNo", ""))
      map.putString("businessOrderNo", json.optString("businessOrderNo", ""))
      map.putString("orderId", json.optString("orderId", ""))
      map.putString("merchantOrderNo", json.optString("merchantOrderNo", ""))
      map.putString("error", json.optString("error", ""))
      map.putBoolean("orphaned", true)
      Log.i(TAG, "consumeOrphanedPaymentResult delivering orphaned SALE callback")
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("ORPHAN_READ_FAILED", e.message, e)
    }
  }

  companion object {
    private const val TAG = "PaymentModule"
    private const val PREFS = "flashtap_payment_callback"
    private const val KEY_PENDING_REQUEST = "pending_request_code"
    private const val KEY_PENDING_ORDER = "pending_order_id"
    private const val KEY_PENDING_MERCHANT = "pending_merchant_order_no"
    private const val KEY_PENDING_AT = "pending_launched_at"
    private const val KEY_ORPHANED_RESULT = "orphaned_payment_result_json"

    const val PAYMENT_REQUEST_CODE = 1001
    const val REFUND_REQUEST_CODE = 1002

    @Volatile
    var pendingPromise: Promise? = null

    @Volatile
    private var appContext: ReactApplicationContext? = null

    fun persistPendingLaunch(
      context: Context,
      requestCode: Int,
      orderId: String,
      merchantOrderNo: String,
    ) {
      context
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putInt(KEY_PENDING_REQUEST, requestCode)
        .putString(KEY_PENDING_ORDER, orderId)
        .putString(KEY_PENDING_MERCHANT, merchantOrderNo)
        .putLong(KEY_PENDING_AT, System.currentTimeMillis())
        .apply()
    }

    fun clearPendingLaunch(context: Context) {
      context
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .remove(KEY_PENDING_REQUEST)
        .remove(KEY_PENDING_ORDER)
        .remove(KEY_PENDING_MERCHANT)
        .remove(KEY_PENDING_AT)
        .apply()
    }

    fun readPendingLaunch(context: Context): Triple<Int, String, String>? {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val code = prefs.getInt(KEY_PENDING_REQUEST, -1)
      if (code < 0) return null
      val orderId = prefs.getString(KEY_PENDING_ORDER, "") ?: ""
      val merchant = prefs.getString(KEY_PENDING_MERCHANT, "") ?: ""
      return Triple(code, orderId, merchant)
    }

    /**
     * Called when SALE onActivityResult fires but pendingPromise is null.
     * Root cause (typical): process death while WiseCashier was foregrounded —
     * the in-memory Promise is gone, but Android may still deliver the result
     * to a recreated MainActivity. Config-change recreation is unlikely here
     * (MainActivity declares configChanges). Double-delivery after a successful
     * first handle also yields null.
     */
    fun handleNullPromiseSaleResult(
      context: Context,
      resultCode: Int,
      data: Intent?,
      voucherNo: String,
      businessOrderNo: String,
      gatewayResult: String?,
      outcome: String,
      errorMessage: String,
    ) {
      val pending = readPendingLaunch(context)
      Log.e(
        TAG,
        "CRITICAL: SALE onActivityResult with null pendingPromise — " +
          "JS will not receive the Promise callback. " +
          "androidResultCode=$resultCode gatewayResult=$gatewayResult " +
          "outcome=$outcome voucherNo=$voucherNo businessOrderNo=$businessOrderNo " +
          "pendingLaunch=$pending error=$errorMessage. " +
          "Likely process death or double delivery; persisting orphaned result for JS recovery.",
      )

      val payload =
        JSONObject().apply {
          put("outcome", outcome)
          put("gatewayResult", gatewayResult ?: "")
          put("androidResultCode", resultCode)
          put("voucherNo", voucherNo)
          put("businessOrderNo", businessOrderNo)
          put("orderId", pending?.second ?: "")
          put("merchantOrderNo", pending?.third ?: "")
          put("error", errorMessage)
          put("orphaned", true)
          put("savedAt", System.currentTimeMillis())
        }

      context
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .putString(KEY_ORPHANED_RESULT, payload.toString())
        .apply()

      clearPendingLaunch(context)

      val ctx = appContext
      if (ctx != null) {
        try {
          val map = Arguments.createMap()
          map.putString("outcome", outcome)
          map.putString("gatewayResult", gatewayResult ?: "")
          map.putInt("androidResultCode", resultCode)
          map.putString("voucherNo", voucherNo)
          map.putString("businessOrderNo", businessOrderNo)
          map.putString("orderId", pending?.second ?: "")
          map.putString("merchantOrderNo", pending?.third ?: "")
          map.putString("error", errorMessage)
          map.putBoolean("orphaned", true)
          ctx
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit("FinaticPaymentOrphanResult", map)
          Log.i(TAG, "Emitted FinaticPaymentOrphanResult to JS")
        } catch (e: Exception) {
          Log.w(TAG, "Failed to emit FinaticPaymentOrphanResult — orphan stored for consumeOrphanedPaymentResult", e)
        }
      } else {
        Log.w(TAG, "No ReactApplicationContext — orphaned result stored for consumeOrphanedPaymentResult")
      }
    }

    fun clearAfterHandled(context: Context) {
      clearPendingLaunch(context)
      pendingPromise = null
    }
  }
}
