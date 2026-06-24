package com.flashtapterminal

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.Arguments
import com.flashtap.pos.PaymentModule
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import org.json.JSONObject

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "FlashTapTerminal"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

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
    }
  }
}
