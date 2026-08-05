package com.flashtap.pos

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableNativeMap
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import wangpos.sdk4.libbasebinder.Printer

/**
 * Receipt printing over the Wiseasy SDK4 base binder.
 *
 * WHY THIS EXISTS. The SDK6 module (WiseSdk6PrinterModule.kt) binds
 * `com.wisepos.aidl.service`, which is not present on our P5 units, so its
 * queryIntentServices returns zero matches and printing never starts. SDK4 binds a DIFFERENT
 * service -- action `wangpos.sdk4.base.service.BinderPoolService`, package `wangpos.sdk4.base`
 * -- which IS installed, as proven by Wiseasy's own SDK Demo printing on our hardware.
 *
 * Both SDKs use the same mechanism (queryIntentServices -> bindService -> AIDL). The
 * `BaseServiceManager` reflection onto `android.os.ServiceManager` that also ships in the SDK4
 * jar is dead code -- nothing in the jar references it except itself -- so this is a
 * wrong-service problem, not a wrong-paradigm one.
 *
 * The job sequence below is taken from Wiseasy's worked example,
 * Demo/SDKDemo/.../com/wpos/sdkdemo/print/USBPrinting.java.
 */
class WiseSdk4PrinterModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "WiseSdk4PrinterModule"

  companion object {
    private const val TAG = "WiseSdk4PrinterModule"

    /** Action and package the SDK4 binder pool lives behind (BaseBinder.connectBinderPoolService). */
    const val BINDER_POOL_ACTION = "wangpos.sdk4.base.service.BinderPoolService"
    const val BINDER_POOL_PACKAGE = "wangpos.sdk4.base"

    /**
     * Ceiling on `new Printer(context)`.
     *
     * The SDK constructor calls bindService() then blocks on a CountDownLatch with NO timeout
     * of its own (BaseBinder.connectBinderPoolService -> mCountDownLatch.await()), so a service
     * that is present but wedged would hang the caller forever.
     *
     * 8s chosen deliberately: binding an already-installed local service normally completes in
     * well under 500ms, so this is >15x the expected cost and will not trip on a slow-but-
     * healthy device. It is also comfortably inside a staff member's patience at the till, and
     * deliberately SHORTER than PRINT_TIMEOUT_MS so a failure here is attributable to binding
     * rather than to printing.
     */
    private const val BIND_TIMEOUT_MS = 8_000L
    private const val PRINT_TIMEOUT_MS = 20_000L
    private const val STATUS_TIMEOUT_MS = 8_000L

    /** Paper. setPrintPaperType: 0 = 58mm, 1 = 80mm, 2 = 104mm (USBPrinting.java:189-196). */
    const val PAPER_TYPE_58MM = 0
    const val PAPER_TYPE_80MM = 1
    const val PAPER_TYPE_104MM = 2

    private const val DEFAULT_PAPER_TYPE = PAPER_TYPE_80MM
    private const val DEFAULT_GRAY_LEVEL = 3
    private const val DEFAULT_FEED_DOTS = 100
    private const val DEFAULT_FONT_SIZE = 25
    private const val LARGE_FONT_SIZE = 32
    private const val DIVIDER_TEXT = "--------------------------------------------"

    /** Printer.PAPER_WIDTH in the SDK. Kept for status reporting only. */
    private const val CANVAS_WIDTH_DOTS = 384

    /** setPrintType(0) is the internal/USB printer, per the demo's TYPE extra. */
    private const val PRINT_TYPE_INTERNAL = 0

    private const val ERR_SUCCESS = 0

    /** setPrintPaperWide / setPrintPaperType return codes (USBPrinting.java:135-153). */
    private fun paperResultMessage(code: Int): String =
      when (code) {
        0 -> "OK"
        1 -> "Printer does not support changing the paper width"
        2 -> "Printer is not connected"
        3 -> "Below the minimum width the printer supports"
        4 -> "Above the maximum width the printer supports"
        else -> "Unknown paper-width result ($code)"
      }
  }

  // ---------------------------------------------------------------- line model (ported as-is)
  //
  // Ported unchanged from WiseSdk6PrinterModule so the JS payload contract is identical.

  private sealed class LineSnapshot {
    data class Text(val text: String, val align: String?, val bold: Boolean, val large: Boolean) :
      LineSnapshot()

    data class Row(val columns: List<String>) : LineSnapshot()

    data class Feed(val lines: Int) : LineSnapshot()

    object Divider : LineSnapshot()
  }

  private val mainHandler = Handler(Looper.getMainLooper())

  /**
   * Single worker for every SDK call. The SDK4 Printer constructor blocks, and the print calls
   * are synchronous AIDL, so none of this may touch the main thread. One thread also serialises
   * jobs, which the buffered printInit/printFinish model requires anyway.
   */
  private val printerExecutor = Executors.newSingleThreadExecutor()

  @Volatile private var cachedPrinter: Printer? = null

  private fun snapshotLines(lines: ReadableArray): List<LineSnapshot> {
    val out = ArrayList<LineSnapshot>(lines.size())
    for (i in 0 until lines.size()) {
      val line = lines.getMap(i) ?: continue
      when (line.getString("type")) {
        "text" ->
          out.add(
            LineSnapshot.Text(
              text = line.getString("text") ?: continue,
              align = line.getString("align"),
              bold = line.hasKey("bold") && line.getBoolean("bold"),
              large = line.hasKey("large") && line.getBoolean("large"),
            ),
          )
        "row" -> {
          val columns = line.getArray("columns") ?: continue
          val cols = ArrayList<String>(columns.size())
          for (c in 0 until columns.size()) {
            cols.add(columns.getString(c) ?: "")
          }
          if (cols.isNotEmpty()) out.add(LineSnapshot.Row(cols))
        }
        "feed" ->
          out.add(LineSnapshot.Feed(if (line.hasKey("lines")) line.getInt("lines") else 1))
        "divider" -> out.add(LineSnapshot.Divider)
      }
    }
    return out
  }

  private fun resolvePromise(promise: Promise, value: Any?) {
    mainHandler.post { promise.resolve(value) }
  }

  private fun rejectPromise(
    promise: Promise,
    code: String,
    message: String?,
    throwable: Throwable? = null,
  ) {
    mainHandler.post {
      if (throwable != null) promise.reject(code, message, throwable) else promise.reject(code, message)
    }
  }

  // ---------------------------------------------------------------- GUARD 1: service resolution
  //
  // BaseBinder.getExplicitIntent returns NULL unless queryIntentServices matches EXACTLY one
  // service, and the SDK then calls bindService(null, ...), which throws. Zero matches and two
  // matches are completely different faults with completely different remedies, and the SDK
  // collapses both into the same NPE. We resolve first so they can never surface identically.

  private sealed class ServiceResolution {
    data class Ok(val packageName: String, val className: String) : ServiceResolution()

    object Absent : ServiceResolution()

    data class Ambiguous(val matches: List<String>) : ServiceResolution()
  }

  private fun resolveBinderPoolService(context: Context): ServiceResolution {
    val pm: PackageManager = context.packageManager
    val intent = Intent(BINDER_POOL_ACTION)
    val matches = pm.queryIntentServices(intent, 0)
    return when {
      matches.isNullOrEmpty() -> ServiceResolution.Absent
      matches.size == 1 -> {
        val info = matches[0].serviceInfo
        ServiceResolution.Ok(info.packageName, info.name)
      }
      else ->
        ServiceResolution.Ambiguous(
          matches.map { "${it.serviceInfo.packageName}/${it.serviceInfo.name}" },
        )
    }
  }

  /** Staff-readable, and deliberately different per case. */
  private fun resolutionError(resolution: ServiceResolution): Pair<String, String>? =
    when (resolution) {
      is ServiceResolution.Ok -> null
      is ServiceResolution.Absent ->
        "PRINTER_SERVICE_ABSENT" to
          "The Wiseasy printer service is not installed on this device. " +
            "No app provides '$BINDER_POOL_ACTION'. Install the Wiseasy base service " +
            "($BINDER_POOL_PACKAGE) on this terminal, then try again."
      is ServiceResolution.Ambiguous ->
        "PRINTER_SERVICE_AMBIGUOUS" to
          "This device has ${resolution.matches.size} apps providing the printer service, so " +
            "the correct one cannot be chosen automatically: ${resolution.matches.joinToString(", ")}. " +
            "Uninstall the duplicates, leaving only $BINDER_POOL_PACKAGE."
    }

  // ---------------------------------------------------------------- GUARD 2: bounded construction

  /**
   * Builds (or returns) the Printer. Runs on [printerExecutor] and is bounded by
   * [BIND_TIMEOUT_MS] because the SDK constructor's own wait is unbounded.
   */
  private fun ensurePrinter(): Result<Printer> {
    cachedPrinter?.let { return Result.success(it) }

    val context = reactContext.applicationContext
    val resolution = resolveBinderPoolService(context)
    resolutionError(resolution)?.let { (code, message) ->
      Log.w(TAG, "service resolution failed: $code — $message")
      return Result.failure(PrinterSetupException(code, message))
    }
    val ok = resolution as ServiceResolution.Ok
    Log.i(TAG, "binder pool resolved to ${ok.packageName}/${ok.className}")

    val future = printerExecutor.submit(Callable { Printer(context) })
    return try {
      val printer = future.get(BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      printer.setPrintType(PRINT_TYPE_INTERNAL)
      cachedPrinter = printer
      Result.success(printer)
    } catch (e: TimeoutException) {
      future.cancel(true)
      Log.e(TAG, "Printer construction exceeded ${BIND_TIMEOUT_MS}ms", e)
      Result.failure(
        PrinterSetupException(
          "PRINTER_BIND_TIMEOUT",
          "The printer service did not respond within ${BIND_TIMEOUT_MS / 1000} seconds. " +
            "It is installed but not answering — restart the terminal and try again.",
        ),
      )
    } catch (e: ExecutionException) {
      Log.e(TAG, "Printer construction threw", e)
      Result.failure(
        PrinterSetupException(
          "PRINTER_BIND_FAILED",
          "Could not connect to the printer service: ${e.cause?.message ?: e.message}",
        ),
      )
    } catch (e: Exception) {
      Log.e(TAG, "Printer construction failed", e)
      Result.failure(
        PrinterSetupException("PRINTER_BIND_FAILED", e.message ?: "Could not connect to the printer"),
      )
    }
  }

  private class PrinterSetupException(val code: String, override val message: String) :
    Exception(message)

  /** Runs [block] on the printer thread with a ceiling, rejecting the promise on any failure. */
  private fun withPrinter(
    promise: Promise,
    timeoutMs: Long,
    block: (Printer) -> Any?,
  ) {
    val task =
      printerExecutor.submit(
        Callable {
          val printer = ensurePrinter().getOrElse { throw it }
          block(printer)
        },
      )
    // Bound the whole operation on a throwaway thread so the RN bridge is never blocked.
    Thread {
      try {
        resolvePromise(promise, task.get(timeoutMs, TimeUnit.MILLISECONDS))
      } catch (e: TimeoutException) {
        task.cancel(true)
        rejectPromise(promise, "PRINTER_TIMEOUT", "The printer did not respond in time.", e)
      } catch (e: ExecutionException) {
        when (val cause = e.cause) {
          is PrinterSetupException -> rejectPromise(promise, cause.code, cause.message, cause)
          else -> rejectPromise(promise, "PRINT_FAILED", cause?.message ?: e.message, e)
        }
      } catch (e: Exception) {
        rejectPromise(promise, "PRINT_FAILED", e.message, e)
      }
    }
      .start()
  }

  // ---------------------------------------------------------------- layout

  /**
   * Renders one line.
   *
   * The SDK6 version had to compute absolute column widths in dots because addMultiText takes
   * pixel widths. SDK4's printMultiseriateString takes a PROPORTION array and does the division
   * itself, so that arithmetic is gone: a row of N columns is simply weighted 1 each, with the
   * first column widened because the description is always the long one on a receipt.
   */
  private fun addLine(printer: Printer, line: LineSnapshot) {
    when (line) {
      is LineSnapshot.Text ->
        printer.printString(
          line.text,
          if (line.large) LARGE_FONT_SIZE else DEFAULT_FONT_SIZE,
          alignFrom(line.align),
          line.bold,
          false,
        )
      is LineSnapshot.Row -> {
        val count = line.columns.size
        if (count == 0) return
        // Description gets 3 parts, every trailing figure 1 — matching the demo's
        // {3,1,1,1} worked example for an item/qty/price/tax row.
        val proportions = IntArray(count) { if (it == 0 && count > 1) 3 else 1 }
        // NOTE: printMultiseriateString is declared STATIC on Printer, unlike every other
        // print call on this class. It still operates on BaseBinder's shared `protected static
        // mService`, so it is only valid once an instance has been constructed and the binder
        // pool has connected -- which `printer` here guarantees. Do not hoist this call above
        // ensurePrinter().
        Printer.printMultiseriateString(
          proportions,
          line.columns.toTypedArray(),
          DEFAULT_FONT_SIZE,
          Printer.Align.LEFT,
          false,
          false,
        )
      }
      is LineSnapshot.Feed ->
        repeat(line.lines.coerceAtLeast(0)) {
          printer.printString(" ", DEFAULT_FONT_SIZE, Printer.Align.LEFT, false, false)
        }
      LineSnapshot.Divider ->
        printer.printString(DIVIDER_TEXT, DEFAULT_FONT_SIZE, Printer.Align.CENTER, false, false)
    }
  }

  private fun alignFrom(value: String?): Printer.Align =
    when (value) {
      "CENTER" -> Printer.Align.CENTER
      "RIGHT" -> Printer.Align.RIGHT
      else -> Printer.Align.LEFT
    }

  // ---------------------------------------------------------------- React methods

  @ReactMethod
  fun isAvailable(promise: Promise) {
    Thread {
      val resolution = resolveBinderPoolService(reactContext.applicationContext)
      val map = WritableNativeMap()
      when (resolution) {
        is ServiceResolution.Ok -> {
          map.putBoolean("available", true)
          map.putString("service", "${resolution.packageName}/${resolution.className}")
        }
        is ServiceResolution.Absent -> {
          map.putBoolean("available", false)
          map.putString("reason", "PRINTER_SERVICE_ABSENT")
        }
        is ServiceResolution.Ambiguous -> {
          map.putBoolean("available", false)
          map.putString("reason", "PRINTER_SERVICE_AMBIGUOUS")
          map.putInt("matchCount", resolution.matches.size)
        }
      }
      resolvePromise(promise, map)
    }
      .start()
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    withPrinter(promise, STATUS_TIMEOUT_MS) { printer ->
      val status = IntArray(1)
      val ret = printer.getPrinterStatus(status)
      WritableNativeMap().apply {
        putInt("result", ret)
        putInt("status", status[0])
        // USBPrinting.java ICommonCallback: 0 = normal, 2 = out of paper.
        putBoolean("ready", ret == ERR_SUCCESS && status[0] == 0)
        putBoolean("outOfPaper", status[0] == 2)
        putInt("canvasWidthDots", CANVAS_WIDTH_DOTS)
      }
    }
  }

  /**
   * Contract preserved verbatim from WiseSdk6PrinterModule so no call site changes.
   *
   * Sequence per USBPrinting.java:
   *   setPrintType -> setGrayLevel -> setPrintPaperType/Wide
   *   -> printInit -> clearPrintDataCache -> content -> printPaper -> printFinish
   */
  @ReactMethod
  fun printJob(lines: ReadableArray, options: ReadableMap?, promise: Promise) {
    val snapshot = snapshotLines(lines)
    if (snapshot.isEmpty()) {
      rejectPromise(promise, "INVALID_PAYLOAD", "Print job has no lines")
      return
    }
    val feedAfterDots =
      if (options?.hasKey("feedAfterDots") == true) options.getInt("feedAfterDots") else DEFAULT_FEED_DOTS
    val grayLevel =
      if (options?.hasKey("grayLevel") == true) options.getInt("grayLevel") else DEFAULT_GRAY_LEVEL
    val paperType =
      if (options?.hasKey("paperType") == true) options.getInt("paperType") else DEFAULT_PAPER_TYPE
    val paperWidth = if (options?.hasKey("paperWidthMm") == true) options.getInt("paperWidthMm") else null

    withPrinter(promise, PRINT_TIMEOUT_MS) { printer ->
      // setPrintType is applied at construction; gray level is persistent config and the SDK
      // notes it needs a printer restart to take effect, so a non-zero result is logged, not fatal.
      val grayResult = printer.setGrayLevel(grayLevel)
      if (grayResult != ERR_SUCCESS) Log.w(TAG, "setGrayLevel($grayLevel) returned $grayResult")

      if (paperWidth != null) {
        val widthResult = printer.setPrintPaperWide(paperWidth)
        if (widthResult != ERR_SUCCESS) {
          throw IllegalStateException(
            "setPrintPaperWide($paperWidth) failed: ${paperResultMessage(widthResult)}",
          )
        }
      } else {
        val typeResult = printer.setPrintPaperType(paperType)
        if (typeResult != ERR_SUCCESS) {
          throw IllegalStateException(
            "setPrintPaperType($paperType) failed: ${paperResultMessage(typeResult)}",
          )
        }
      }

      val initResult = printer.printInit()
      if (initResult != ERR_SUCCESS) {
        throw IllegalStateException("printInit failed with code $initResult")
      }
      printer.clearPrintDataCache()

      for (line in snapshot) addLine(printer, line)

      printer.printPaper(feedAfterDots)
      val finishResult = printer.printFinish()
      if (finishResult != ERR_SUCCESS) {
        throw IllegalStateException("printFinish failed with code $finishResult")
      }
      true
    }
  }

  /** New capability — no SDK6 equivalent. */
  @ReactMethod
  fun cutPaper(promise: Promise) {
    withPrinter(promise, STATUS_TIMEOUT_MS) { printer ->
      val ret = printer.cutPaper()
      if (ret != ERR_SUCCESS) throw IllegalStateException("cutPaper failed with code $ret")
      true
    }
  }

  /** New capability — no SDK6 equivalent. */
  @ReactMethod
  fun setPrintLineSpacing(lineSpacing: Int, promise: Promise) {
    withPrinter(promise, STATUS_TIMEOUT_MS) { printer ->
      val ret = printer.setPrintLineSpacing(lineSpacing)
      if (ret != ERR_SUCCESS) {
        throw IllegalStateException("setPrintLineSpacing($lineSpacing) failed with code $ret")
      }
      true
    }
  }

  /** Diagnostics: what the device actually offers for the SDK4 binder pool action. */
  @ReactMethod
  fun probeService(promise: Promise) {
    Thread {
      val pm = reactContext.applicationContext.packageManager
      val matches = pm.queryIntentServices(Intent(BINDER_POOL_ACTION), 0) ?: emptyList()
      val map = WritableNativeMap()
      map.putString("action", BINDER_POOL_ACTION)
      map.putString("expectedPackage", BINDER_POOL_PACKAGE)
      map.putInt("matchCount", matches.size)
      map.putString(
        "matches",
        matches.joinToString(", ") { "${it.serviceInfo.packageName}/${it.serviceInfo.name}" },
      )
      map.putString(
        "verdict",
        when (matches.size) {
          0 -> "PRINTER_SERVICE_ABSENT"
          1 -> "OK"
          else -> "PRINTER_SERVICE_AMBIGUOUS"
        },
      )
      resolvePromise(promise, map)
    }
      .start()
  }
}
