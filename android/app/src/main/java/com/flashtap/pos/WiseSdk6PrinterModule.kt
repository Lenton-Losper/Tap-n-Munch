package com.flashtap.pos

import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.wisedevice.sdk.IInitDeviceSdkListener
import com.wisedevice.sdk.WiseDeviceSdk
import com.wisepos.smartpos.InitPosSdkListener
import com.wisepos.smartpos.WisePosException
import com.wisepos.smartpos.WisePosSdk
import com.wisepos.smartpos.errorcode.WisePosErrorCode
import com.wisepos.smartpos.printer.Align
import com.wisepos.smartpos.printer.Printer
import com.wisepos.smartpos.printer.PrinterListener
import com.wisepos.smartpos.printer.TextInfo

/**
 * Transport-only bridge to the terminal's built-in Wiseasy printer (SDK6 / WisePosSdk).
 * Deliberately knows nothing about receipt content, VAT, or line formatting -- printJob() just
 * executes a pre-fetched sdk6Lines list verbatim, the same way PrinterModule.printEscPos()
 * executes pre-fetched ESC/POS bytes. Both come from the same call, GET
 * /api/terminal/receipts/[orderId] (receiptPrinting.ts, same terminal-token auth for both
 * fields) -- sdk6Lines and escposBase64 are sibling fields derived from the same receipt
 * snapshot. WisePosSdk's Printer has no raw-byte-write method -- only structured
 * addSingleText/addMultiText calls -- so the "already-rendered bytes" PrinterModule.kt takes
 * become a small structured line list here instead. addLine() maps each Sdk6ReceiptLine
 * variant ('text'/'row'/'feed'/'divider' -- see Sdk6ReceiptLine in wiseSdk6Printer.ts) verbatim;
 * no qrCode/barCode variant exists because the backend doesn't emit them.
 *
 * Some Wiseasy models have no built-in printer at all (T2, P5L per the SDK6 demo's own
 * visibility check) -- isAvailable() lets JS rule this out before offering it as a Settings
 * option, instead of surfacing a confusing SDK error.
 */
class WiseSdk6PrinterModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "WiseSdk6PrinterModule"

  companion object {
    private const val TAG = "WiseSdk6PrinterModule"
    private const val SDK_INIT_TIMEOUT_MS = 8000L
    // feedPaper()'s parameter is dots on the Y axis (per WiseSdkDoc_P), not mm -- 30 matches
    // the SDK6 demo's own trailing feedPaper(30) call after a successful print.
    private const val DEFAULT_FEED_DOTS = 30
    private const val DEFAULT_FONT_SIZE = 24
    private const val LARGE_FONT_SIZE = 32
    // Printable width in dots -- addMultiText's docs require width+columnSpacing per column to
    // sum to no more than this.
    private const val CANVAS_WIDTH_DOTS = 384
    // The SDK6 demo calls setGrayLevel() before every print job (never leaves it unset); 3 is
    // WiseSdkDoc_P's documented factory default ("restored to the default value of 3" on
    // restart), used here as an explicit value rather than relying on whatever the printer
    // happens to still have set from a previous job.
    private const val DEFAULT_GRAY_LEVEL = 3
    // Exact convention from the SDK6 demo's own divider lines (PrinterActivity.java).
    private const val DIVIDER_TEXT = "--------------------------------------------"
    private val UNSUPPORTED_MODELS = setOf("T2", "P5L")
  }

  private var printer: Printer? = null
  private var sdkInitInFlight = false
  private var deviceSdkInitStarted = false
  private val pendingCallbacks = mutableListOf<(Printer?, Int?) -> Unit>()
  private val mainHandler = Handler(Looper.getMainLooper())

  @ReactMethod
  fun isAvailable(promise: Promise) {
    promise.resolve(!UNSUPPORTED_MODELS.contains(Build.MODEL))
  }

  /**
   * initPosSdk() binds to a system service asynchronously; callers queue behind a single
   * in-flight init rather than each triggering their own bind. A timeout guards against the
   * service never answering (e.g. this SDK on non-Wiseasy hardware), so a print request can't
   * hang the Retry/Skip UI forever.
   */
  private fun ensurePrinter(callback: (Printer?, errorCode: String?, errorMessage: String?) -> Unit) {
    val existing = printer
    if (existing != null) {
      callback(existing, null, null)
      return
    }

    pendingCallbacks.add { printerInstance, wiseErrorCode ->
      if (printerInstance != null) {
        callback(printerInstance, null, null)
      } else {
        val suffix = wiseErrorCode?.let { " (code $it)" } ?: " (timed out)"
        callback(null, "SDK_INIT_FAILED", "Failed to initialize the built-in printer$suffix")
      }
    }

    if (sdkInitInFlight) return
    sdkInitInFlight = true

    // Mirrors the SDK6 demo's MainActivity.onCreate(), which binds both SDKs together.
    // WisePosSdk owns the printer; WiseDeviceSdk isn't used by this module directly, but the
    // demo never initializes one without the other, so this doesn't deviate from the only
    // proven-working init sequence available. Fire-and-forget: printer readiness only waits
    // on WisePosSdk's own callback below.
    if (!deviceSdkInitStarted) {
      deviceSdkInitStarted = true
      WiseDeviceSdk.getInstance().initDeviceSdk(
        reactContext,
        object : IInitDeviceSdkListener {
          override fun onInitPosSuccess() {
            Log.d(TAG, "WiseDeviceSdk initialized")
          }

          override fun onInitPosFail(errorCode: Int) {
            Log.w(TAG, "WiseDeviceSdk init failed, code=$errorCode")
          }
        },
      )
    }

    var settled = false
    lateinit var timeoutRunnable: Runnable

    fun settleInit(success: Boolean, wiseErrorCode: Int?) {
      if (settled) return
      settled = true
      mainHandler.removeCallbacks(timeoutRunnable)
      sdkInitInFlight = false
      printer = if (success) WisePosSdk.getInstance().getPrinter() else null
      val callbacks = pendingCallbacks.toList()
      pendingCallbacks.clear()
      callbacks.forEach { it(printer, wiseErrorCode) }
    }

    timeoutRunnable = Runnable { settleInit(false, null) }
    mainHandler.postDelayed(timeoutRunnable, SDK_INIT_TIMEOUT_MS)

    WisePosSdk.getInstance().initPosSdk(
      reactContext,
      object : InitPosSdkListener {
        override fun onInitPosSuccess() {
          settleInit(true, null)
        }

        override fun onInitPosFail(errorCode: Int) {
          Log.w(TAG, "initPosSdk failed, code=$errorCode")
          settleInit(false, errorCode)
        }
      },
    )
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    ensurePrinter { printerInstance, errorCode, errorMessage ->
      if (printerInstance == null) {
        promise.reject(errorCode ?: "SDK_INIT_FAILED", errorMessage)
        return@ensurePrinter
      }
      try {
        val status = printerInstance.getPrinterStatus()
        if (status == null) {
          promise.reject("STATUS_UNAVAILABLE", "Could not read printer status")
          return@ensurePrinter
        }
        val result = Arguments.createMap()
        val paper = status["paper"] as? Byte
        result.putBoolean("hasPaper", paper == null || paper.toInt() != 1)
        result.putBoolean("connected", true)
        promise.resolve(result)
      } catch (e: Exception) {
        promise.reject("STATUS_FAILED", e.message, e)
      }
    }
  }

  /**
   * Executes a pre-fetched sdk6Lines list. `lines` is an array of {type, ...} maps matching
   * Sdk6ReceiptLine in wiseSdk6Printer.ts ('text' | 'row' | 'feed' | 'divider'). Rejects with
   * OUT_OF_PAPER before touching the SDK's print queue so the caller can show Retry/Skip without
   * a half-printed receipt.
   */
  @ReactMethod
  fun printJob(lines: ReadableArray, options: ReadableMap?, promise: Promise) {
    ensurePrinter { printerInstance, errorCode, errorMessage ->
      if (printerInstance == null) {
        promise.reject(errorCode ?: "SDK_INIT_FAILED", errorMessage)
        return@ensurePrinter
      }
      executePrintJob(printerInstance, lines, options, promise)
    }
  }

  private fun executePrintJob(
    printerInstance: Printer,
    lines: ReadableArray,
    options: ReadableMap?,
    promise: Promise,
  ) {
    try {
      printerInstance.initPrinter()
      printerInstance.setGrayLevel(DEFAULT_GRAY_LEVEL)

      val status = printerInstance.getPrinterStatus()
      val paper = status?.get("paper") as? Byte
      if (paper != null && paper.toInt() == 1) {
        promise.reject("OUT_OF_PAPER", "The printer is out of paper")
        return
      }

      // Matches the SDK6 demo's own per-model font workaround, applied unconditionally
      // before every text-bearing job -- a hardware compatibility quirk, not a content choice.
      val fontBundle = Bundle()
      fontBundle.putString(
        "font",
        if (Build.MODEL in setOf("P5SE", "P5MAX", "P052")) "sans-serif-light" else "DEFAULT",
      )
      printerInstance.setPrintFont(fontBundle)

      for (i in 0 until lines.size()) {
        val line = lines.getMap(i) ?: continue
        addLine(printerInstance, line)
      }

      val feedAfterDots =
        if (options?.hasKey("feedAfterDots") == true) options.getInt("feedAfterDots") else DEFAULT_FEED_DOTS

      printerInstance.startPrinting(
        Bundle(),
        object : PrinterListener {
          override fun onError(errorCode: Int) {
            promise.reject(errorCodeName(errorCode), "Print failed (code $errorCode)")
          }

          override fun onFinish() {
            try {
              printerInstance.feedPaper(feedAfterDots)
            } catch (e: WisePosException) {
              // The receipt already printed; a failed feed isn't a print failure.
              Log.w(TAG, "feedPaper failed after successful print", e)
            }
            promise.resolve(true)
          }

          override fun onReport(status: Int) {
            // Reserved by the SDK; no action needed.
          }
        },
      )
    } catch (e: WisePosException) {
      promise.reject(errorCodeName(e.errorCode), e.message, e)
    } catch (e: Exception) {
      promise.reject("PRINT_FAILED", e.message, e)
    }
  }

  /** Maps one Sdk6ReceiptLine (wiseSdk6Printer.ts) to the matching Printer call. */
  private fun addLine(printerInstance: Printer, line: ReadableMap) {
    when (line.getString("type")) {
      "text" -> {
        val text = line.getString("text") ?: return
        val info = TextInfo()
        info.setText(text)
        info.setAlign(alignFrom(line.getString("align")))
        info.setFontSize(if (line.hasKey("large") && line.getBoolean("large")) LARGE_FONT_SIZE else DEFAULT_FONT_SIZE)
        if (line.hasKey("bold")) info.setBold(line.getBoolean("bold"))
        printerInstance.addSingleText(info)
      }
      "row" -> {
        val columns = line.getArray("columns") ?: return
        val count = columns.size()
        if (count == 0) return
        val columnWidth = CANVAS_WIDTH_DOTS / count
        val list = ArrayList<TextInfo>()
        for (i in 0 until count) {
          val info = TextInfo()
          info.setText(columns.getString(i) ?: "")
          // The contract gives plain strings with no per-column formatting -- right-align the
          // last column (the common receipt convention: label(s) left, trailing amount right),
          // left-align the rest. Split width evenly, folding the remainder into the last column
          // so the total still sums to exactly CANVAS_WIDTH_DOTS as addMultiText requires.
          info.setAlign(if (i == count - 1) Align.PRINT_ALIGN_STYLE_RIGHT else Align.PRINT_ALIGN_STYLE_LEFT)
          info.setFontSize(DEFAULT_FONT_SIZE)
          info.setWidth(if (i == count - 1) CANVAS_WIDTH_DOTS - columnWidth * (count - 1) else columnWidth)
          info.setColumnSpacing(0)
          list.add(info)
        }
        printerInstance.addMultiText(list)
      }
      "feed" -> {
        val lineCount = if (line.hasKey("lines")) line.getInt("lines") else 1
        // feedPaper() takes dots, not a line count, and there's no documented dots-per-line
        // constant -- printing blank text lines lets the SDK's own line-height/spacing
        // determine the actual distance instead of us guessing a conversion factor.
        repeat(lineCount.coerceAtLeast(0)) {
          val blank = TextInfo()
          blank.setText("")
          printerInstance.addSingleText(blank)
        }
      }
      "divider" -> {
        val info = TextInfo()
        info.setText(DIVIDER_TEXT)
        info.setAlign(Align.PRINT_ALIGN_STYLE_CENTER)
        info.setFontSize(DEFAULT_FONT_SIZE)
        printerInstance.addSingleText(info)
      }
    }
  }

  private fun alignFrom(value: String?): Int =
    when (value) {
      "CENTER" -> Align.PRINT_ALIGN_STYLE_CENTER
      "RIGHT" -> Align.PRINT_ALIGN_STYLE_RIGHT
      else -> Align.PRINT_ALIGN_STYLE_LEFT
    }

  private fun errorCodeName(code: Int): String =
    when (code) {
      WisePosErrorCode.ERR_PRINTER_RUN_OUT_PAPER -> "OUT_OF_PAPER"
      WisePosErrorCode.ERR_PRINTER_TEMPERATURE, WisePosErrorCode.ERR_SVR_PRINTER_TEMPERATURE -> "PRINTER_OVERHEATED"
      WisePosErrorCode.ERR_PRINTER, WisePosErrorCode.ERR_SVR_PRINTER_STATUS_ERROR -> "PRINTER_ERROR"
      WisePosErrorCode.ERR_SDK_SERVICE_NOT_CONNECTED, WisePosErrorCode.ERR_SDK_DEVICE_UNCONNECTED -> "SDK_NOT_CONNECTED"
      // Documented on startPrinting(): fires when device battery is <=4%.
      WisePosErrorCode.ERR_SVR_LOW_BATTERY -> "LOW_BATTERY"
      else -> "PRINT_FAILED"
    }
}
