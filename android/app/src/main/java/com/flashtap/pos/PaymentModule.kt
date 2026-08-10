package com.flashtap.pos

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import com.flashtapterminal.BuildConfig
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale
import org.json.JSONArray
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
    // INSTRUMENTATION (vc82). First marker on the path, before the guards below can return —
    // so "JS called launchPayment and it refused" is distinguishable from "JS never called it".
    recordWiretap(
      reactContext,
      "launchPayment.entry",
      JSONObject().apply {
        put("orderId", orderId)
        put("merchantOrderNo", merchantOrderNo)
        put("amountMinor", amount)
      },
    )

    val activity = getCurrentActivity() ?: run {
      recordWiretap(reactContext, "launchPayment.reject", JSONObject().put("code", "NO_ACTIVITY"))
      promise.reject("NO_ACTIVITY", "No current activity")
      return
    }

    try {
      // Backend-owned value from POST /api/terminal/orders/{id}/prepare-payment — must match
      // orders.paycloud_merchant_order_no so Finatic webhooks can correlate. Do not mint here.
      val trimmedMerchantOrderNo = merchantOrderNo.trim()
      if (trimmedMerchantOrderNo.isEmpty()) {
        recordWiretap(
          reactContext,
          "launchPayment.reject",
          JSONObject().put("code", "MISSING_MERCHANT_ORDER_NO"),
        )
        promise.reject(
          "MISSING_MERCHANT_ORDER_NO",
          "merchantOrderNo is required; call prepare-payment before launching Finatic",
        )
        return
      }
      if (trimmedMerchantOrderNo.length > 32) {
        recordWiretap(
          reactContext,
          "launchPayment.reject",
          JSONObject().put("code", "INVALID_MERCHANT_ORDER_NO"),
        )
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
      // INSTRUMENTATION (vc82). Paired with the onActivityResult capture so an EMPTY wiretap is
      // unambiguous. Order #75 reached "cancelled" with no merchant_order_no and no audit rows,
      // which is consistent with WiseCashier never having been launched at all — a hypothesis a
      // return-only log could never separate from "launched and returned nothing".
      recordWiretap(
        reactContext,
        "launchPayment.dispatch",
        JSONObject().apply {
          put("orderId", orderId)
          put("merchantOrderNo", trimmedMerchantOrderNo)
          put("amountMinor", amount)
          put("paddedAmount", paddedAmount)
          put("action", intent.action ?: "")
          put("requestCode", PAYMENT_REQUEST_CODE)
        },
      )
      activity.startActivityForResult(intent, PAYMENT_REQUEST_CODE)
    } catch (e: Exception) {
      pendingPromise = null
      clearPendingLaunch(reactContext)
      recordWiretap(
        reactContext,
        "launchPayment.error",
        JSONObject().apply {
          put("orderId", orderId)
          put("merchantOrderNo", merchantOrderNo)
          put("error", e.message ?: e.javaClass.simpleName)
        },
      )
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

  /**
   * INSTRUMENTATION (vc82). Returns the wiretap ring buffer as a JSON array string for the
   * Diagnostics screen. Deliberately NON-consuming, unlike consumeOrphanedPaymentResult above:
   * the operator reads this minutes after the payment, and may read it more than once.
   */
  @ReactMethod
  fun readWiseCashierWiretap(promise: Promise) {
    try {
      val raw =
        reactContext
          .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
          .getString(KEY_WIRETAP, null)
      promise.resolve(if (raw.isNullOrBlank()) "[]" else raw)
    } catch (e: Exception) {
      promise.reject("WIRETAP_READ_FAILED", e.message, e)
    }
  }

  /**
   * Let JS append to the same wiretap the native side writes to.
   *
   * Added vc84. The 2026-08-09 test proved detection worked and the order still did not cancel,
   * and the server-side audit could not tell us whether the terminal had sent
   * cancellationReason/noGatewayAttempt or whether the route had discarded them — the route read
   * `body` field-by-field, so an ignored field and an absent field leave identical traces. This
   * closes that blind spot from the device end: what JS actually put on the wire is recorded
   * where it can be read without ADB.
   */
  @ReactMethod
  fun recordWiretapEvent(event: String, detailJson: String, promise: Promise) {
    try {
      val detail = if (detailJson.isBlank()) JSONObject() else JSONObject(detailJson)
      recordWiretap(reactContext, event, detail)
      promise.resolve(true)
    } catch (e: Exception) {
      // Instrumentation must never break a payment: report, do not throw into the JS flow.
      Log.w(TAG, "recordWiretapEvent($event) failed: ${e.message}")
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun clearWiseCashierWiretap(promise: Promise) {
    try {
      reactContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .remove(KEY_WIRETAP)
        .apply()
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("WIRETAP_CLEAR_FAILED", e.message, e)
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

    /**
     * INSTRUMENTATION (vc82). A ring buffer of everything WiseCashier hands back, recorded
     * BEFORE any of FlashTap's own classification runs.
     *
     * Why this exists: on 2026-08-07 a user cancel inside the WiseCashier screen did not take
     * the RESULT_CANCELED branch in MainActivity, and the SDK4 package documents no return
     * contract for an unsolicited cancel. These terminals have no ADB, so logcat is not a
     * channel we can read — the only way to learn what actually arrives is to persist it and
     * render it on Diagnostics. Read, do not consume: the operator reaches Diagnostics several
     * screens and possibly an app restart after the payment.
     */
    private const val KEY_WIRETAP = "wisecashier_wiretap_json"
    private const val WIRETAP_CAP = 24
    private const val WIRETAP_VALUE_MAX = 500

    const val PAYMENT_REQUEST_CODE = 1001
    const val REFUND_REQUEST_CODE = 1002

    @Volatile
    var pendingPromise: Promise? = null

    @Volatile
    private var appContext: ReactApplicationContext? = null

    /**
     * The symbolic name Android itself would use for a result code. Reported alongside the raw
     * integer and never instead of it — the whole point of this build is that we do not yet
     * know which codes WiseCashier uses, so an unrecognised value must still be legible.
     */
    fun resultCodeName(resultCode: Int): String =
      when {
        resultCode == Activity.RESULT_OK -> "RESULT_OK"
        resultCode == Activity.RESULT_CANCELED -> "RESULT_CANCELED"
        resultCode == Activity.RESULT_FIRST_USER -> "RESULT_FIRST_USER"
        resultCode > Activity.RESULT_FIRST_USER ->
          "RESULT_FIRST_USER+${resultCode - Activity.RESULT_FIRST_USER}"
        else -> "UNKNOWN"
      }

    private fun renderExtraValue(value: Any?): String {
      val rendered =
        when (value) {
          null -> "null"
          is String -> value
          is ByteArray -> "byte[${value.size}] " + value.joinToString("") { "%02x".format(it) }
          is IntArray -> value.contentToString()
          is LongArray -> value.contentToString()
          is Array<*> -> value.contentToString()
          is Bundle ->
            "{" +
              value.keySet().joinToString(", ") { k ->
                @Suppress("DEPRECATION")
                "$k=${renderExtraValue(value.get(k))}"
              } + "}"
          else -> value.toString()
        }
      return if (rendered.length > WIRETAP_VALUE_MAX) {
        rendered.take(WIRETAP_VALUE_MAX) + "…[${rendered.length}]"
      } else {
        rendered
      }
    }

    /** Append one entry to the ring buffer. Never throws — instrumentation must not break payment. */
    fun recordWiretap(context: Context?, event: String, detail: JSONObject) {
      if (context == null) return
      try {
        detail.put("event", event)
        detail.put("at", System.currentTimeMillis())
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getString(KEY_WIRETAP, null)
        val arr = if (existing.isNullOrBlank()) JSONArray() else JSONArray(existing)
        arr.put(detail)
        val trimmed =
          if (arr.length() <= WIRETAP_CAP) {
            arr
          } else {
            JSONArray().also { out ->
              for (i in (arr.length() - WIRETAP_CAP) until arr.length()) out.put(arr.get(i))
            }
          }
        prefs.edit().putString(KEY_WIRETAP, trimmed.toString()).apply()
      } catch (e: Exception) {
        Log.w(TAG, "wiretap append failed for $event: ${e.message}")
      }
    }

    /**
     * Record a raw activity return VERBATIM: the request code, the result code and its symbolic
     * name, the Intent's action, and every extra key with its runtime type and value. Called
     * from MainActivity.onActivityResult before any branching, for every request code — an
     * arrival under a request code we do not recognise is itself a finding worth seeing.
     */
    fun recordActivityReturn(context: Context?, requestCode: Int, resultCode: Int, data: Intent?) {
      if (context == null) return
      try {
        val detail =
          JSONObject().apply {
            put("requestCode", requestCode)
            put(
              "requestCodeName",
              when (requestCode) {
                PAYMENT_REQUEST_CODE -> "PAYMENT(SALE)"
                REFUND_REQUEST_CODE -> "REFUND"
                else -> "UNEXPECTED"
              },
            )
            put("resultCode", resultCode)
            put("resultCodeName", resultCodeName(resultCode))
            put("dataNull", data == null)
            put("action", data?.action ?: "")
            put("dataString", data?.dataString ?: "")
            put("component", data?.component?.flattenToShortString() ?: "")
            put("flags", data?.flags ?: 0)
            put("type", data?.type ?: "")
            put("categories", (data?.categories ?: emptySet<String>()).joinToString(","))
          }

        val extras = JSONArray()
        val bundle = data?.extras
        if (bundle == null) {
          detail.put("extrasNull", true)
          detail.put("extrasCount", 0)
        } else {
          detail.put("extrasNull", false)
          // Do NOT filter to keys we expect. The bug is that our expectations are wrong.
          for (key in bundle.keySet()) {
            @Suppress("DEPRECATION")
            val raw = bundle.get(key)
            extras.put(
              JSONObject().apply {
                put("key", key)
                put("type", raw?.javaClass?.simpleName ?: "null")
                put("value", renderExtraValue(raw))
              },
            )
          }
          detail.put("extrasCount", extras.length())
        }
        detail.put("extras", extras)

        val pending = readPendingLaunch(context)
        detail.put("pendingOrderId", pending?.second ?: "")
        detail.put("pendingMerchantOrderNo", pending?.third ?: "")
        detail.put("promiseAlive", pendingPromise != null)

        recordWiretap(context, "onActivityResult", detail)
        Log.i(
          TAG,
          "WIRETAP return requestCode=$requestCode resultCode=$resultCode " +
            "(${resultCodeName(resultCode)}) action=${data?.action} extras=${extras.length()}",
        )
      } catch (e: Exception) {
        Log.w(TAG, "wiretap capture failed: ${e.message}")
      }
    }

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
