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
import com.facebook.react.bridge.WritableNativeArray
import com.facebook.react.bridge.WritableNativeMap
import java.util.Collections
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.FutureTask
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
 * -- which IS installed, confirmed on the Finatic-UAT P5 (matchCount = 1).
 *
 * Both SDKs use the same mechanism (queryIntentServices -> bindService -> AIDL). The
 * `BaseServiceManager` reflection onto `android.os.ServiceManager` that also ships in the SDK4
 * jar is dead code -- nothing in the jar references it except itself.
 *
 * The job sequence is taken from Wiseasy's worked example,
 * Demo/SDKDemo/.../com/wpos/sdkdemo/print/USBPrinting.java.
 */
class WiseSdk4PrinterModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "WiseSdk4PrinterModule"

  companion object {
    private const val TAG = "WiseSdk4PrinterModule"

    const val BINDER_POOL_ACTION = "wangpos.sdk4.base.service.BinderPoolService"
    const val BINDER_POOL_PACKAGE = "wangpos.sdk4.base"

    /**
     * Ceiling on `new Printer(context)`.
     *
     * The SDK constructor calls bindService() then blocks on a CountDownLatch with NO timeout
     * of its own (BaseBinder.connectBinderPoolService -> mCountDownLatch.await()), so a service
     * that is present but wedged would hang the caller forever.
     *
     * 8s: binding an already-installed local service normally completes well under 500ms, so
     * this is >15x expected and will not trip on a slow-but-healthy device; it is inside a
     * staff member's patience at the till; and it is deliberately SHORTER than
     * PRINT_TIMEOUT_MS so a failure here is attributable to binding rather than printing.
     */
    private const val BIND_TIMEOUT_MS = 8_000L
    private const val PRINT_TIMEOUT_MS = 20_000L
    private const val STATUS_TIMEOUT_MS = 8_000L

    /** setPrintPaperType: 0 = 58mm, 1 = 80mm, 2 = 104mm (USBPrinting.java:189-196). */
    const val PAPER_TYPE_58MM = 0
    const val PAPER_TYPE_80MM = 1
    const val PAPER_TYPE_104MM = 2

    /**
     * Fallback only -- every call site now supplies "paperType" from the terminal's stored
     * paper_width_mm (#167).
     *
     * Deliberately left at 80mm. #167 argues 58mm is the value every other part of the system
     * assumes (Printer.PAPER_WIDTH is 384 dots, WiseSdk6PrinterModule composed to 384,
     * parseCharacterWidth defaults to 32 characters), and that is probably right -- but nobody
     * has measured the physical roll on the P5, so changing the fallback would alter printed
     * layout on any unit that reaches it, on an unverified assumption. That is a measurement,
     * not a code change. Leave it until someone reads a receipt off the device.
     */
    private const val DEFAULT_PAPER_TYPE = PAPER_TYPE_80MM
    private const val DEFAULT_GRAY_LEVEL = 3
    private const val DEFAULT_FEED_DOTS = 100
    private const val DEFAULT_FONT_SIZE = 25
    private const val LARGE_FONT_SIZE = 32
    /**
     * 32 characters, the 384-dot head at font size 25. This was 44, which wrapped onto a second
     * line and printed as the "double divider" seen alongside #166. printString wraps where
     * printMultiseriateString clips, so the same width mismatch showed up two different ways.
     */
    private const val DIVIDER_TEXT = "--------------------------------"

    private const val CANVAS_WIDTH_DOTS = 384
    private const val PRINT_TYPE_INTERNAL = 0
    private const val ERR_SUCCESS = 0

    /** How many step rows to retain for the Diagnostics screen. */
    private const val MAX_RETAINED_STEPS = 64

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

  private sealed class LineSnapshot {
    data class Text(val text: String, val align: String?, val bold: Boolean, val large: Boolean) :
      LineSnapshot()

    data class Row(val columns: List<String>) : LineSnapshot()

    data class Feed(val lines: Int) : LineSnapshot()

    object Divider : LineSnapshot()
  }

  private val mainHandler = Handler(Looper.getMainLooper())

  /**
   * Serialises print jobs. The SDK's print calls are synchronous AIDL and the
   * printInit/printFinish model is stateful, so two overlapping jobs would interleave into one
   * buffer -- printMultiseriateString is static and writes through BaseBinder's shared
   * `protected static mService`.
   *
   * NEVER submit to this executor from a task already running on it, and never block a task on
   * another task submitted to it. It has ONE thread: the inner task queues behind the outer one
   * and can never start, so the outer wait can only end in a timeout. That exact deadlock
   * shipped in vc77 -- ensurePrinter() re-entered this executor to construct the Printer, so
   * every print blocked the full 8s and failed as PRINTER_BIND_TIMEOUT while the service was
   * healthy the whole time. Construction now runs on its own dedicated thread; keep it there.
   */
  private val printerExecutor = Executors.newSingleThreadExecutor()

  @Volatile private var cachedPrinter: Printer? = null

  // ---------------------------------------------------------------- step recording

  private data class StepResult(
    val step: String,
    val code: Int?,
    val ok: Boolean,
    val detail: String?,
  )

  /** Steps from the most recent job, for the Diagnostics screen. ADB is not reachable here. */
  private val lastSteps: MutableList<StepResult> =
    Collections.synchronizedList(ArrayList<StepResult>())

  @Volatile private var lastJobStartedAt: Long = 0L
  @Volatile private var lastJobOutcome: String = "none"

  private fun beginJob(label: String) {
    synchronized(lastSteps) { lastSteps.clear() }
    lastJobStartedAt = System.currentTimeMillis()
    lastJobOutcome = "running"
    Log.i(TAG, "=== job start: $label ===")
  }

  private fun record(step: String, code: Int?, ok: Boolean, detail: String? = null) {
    synchronized(lastSteps) {
      if (lastSteps.size < MAX_RETAINED_STEPS) {
        lastSteps.add(StepResult(step, code, ok, detail))
      } else if (lastSteps.size == MAX_RETAINED_STEPS) {
        lastSteps.add(StepResult("…truncated", null, true, "step log capped at $MAX_RETAINED_STEPS"))
      }
    }
    val codeText = code?.toString() ?: "-"
    if (ok) {
      Log.i(TAG, "step=$step code=$codeText ok${if (detail != null) " ($detail)" else ""}")
    } else {
      Log.e(TAG, "step=$step code=$codeText FAILED${if (detail != null) " ($detail)" else ""}")
    }
  }

  /**
   * Runs one SDK call, records its integer return, and fails with the STEP NAME attached.
   * A bare code costs another test cycle; "failed at printInit (code 2)" does not.
   */
  private fun step(name: String, detail: String? = null, call: () -> Int): Int {
    val code =
      try {
        call()
      } catch (e: Exception) {
        record(name, null, false, e.message ?: e.javaClass.simpleName)
        throw PrintStepException(name, null, e.message ?: "threw ${e.javaClass.simpleName}", e)
      }
    val ok = code == ERR_SUCCESS
    record(name, code, ok, detail)
    if (!ok) throw PrintStepException(name, code, detail)
    return code
  }

  /** Non-fatal variant: records the result but never throws (config the SDK treats as advisory). */
  private fun softStep(name: String, detail: String? = null, call: () -> Int): Int {
    return try {
      val code = call()
      record(name, code, code == ERR_SUCCESS, detail)
      code
    } catch (e: Exception) {
      record(name, null, false, e.message ?: e.javaClass.simpleName)
      -1
    }
  }

  private class PrintStepException(
    val step: String,
    val code: Int?,
    val detail: String?,
    cause: Throwable? = null,
  ) : Exception(
      "failed at $step" + (code?.let { " (code $it)" } ?: "") + (detail?.let { " — $it" } ?: ""),
      cause,
    )

  private class PrinterSetupException(val code: String, override val message: String) :
    Exception(message)

  // ---------------------------------------------------------------- snapshot (ported as-is)

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

  private sealed class ServiceResolution {
    data class Ok(val packageName: String, val className: String) : ServiceResolution()

    object Absent : ServiceResolution()

    data class Ambiguous(val matches: List<String>) : ServiceResolution()
  }

  private fun resolveBinderPoolService(context: Context): ServiceResolution {
    val pm: PackageManager = context.packageManager
    val matches = pm.queryIntentServices(Intent(BINDER_POOL_ACTION), 0)
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

  /**
   * BaseBinder.getExplicitIntent returns null unless queryIntentServices matches EXACTLY one
   * service, then bindService(null, ...) throws -- so "absent" and "ambiguous" surface
   * identically as an NPE. Resolve first so they cannot.
   */
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
   * Builds (or returns) the Printer.
   *
   * Construction runs on its OWN dedicated thread, never on [printerExecutor]. See the comment
   * on that field: a single-thread executor cannot have a task that waits on another task
   * submitted to the same executor, and vc77 shipped exactly that deadlock.
   */
  private fun ensurePrinter(): Result<Printer> {
    cachedPrinter?.let { return Result.success(it) }

    val context = reactContext.applicationContext
    val resolution = resolveBinderPoolService(context)
    resolutionError(resolution)?.let { (code, message) ->
      record("resolveService", null, false, code)
      return Result.failure(PrinterSetupException(code, message))
    }
    val ok = resolution as ServiceResolution.Ok
    record("resolveService", null, true, "${ok.packageName}/${ok.className}")

    // Dedicated thread + FutureTask: no executor involvement at all.
    val construct = FutureTask(Callable { Printer(context) })
    val thread = Thread(construct, "WiseSdk4-PrinterConstruct")
    thread.isDaemon = true
    thread.start()

    return try {
      val printer = construct.get(BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      record("newPrinter", null, true, "bound in <${BIND_TIMEOUT_MS}ms")
      softStep("setPrintType", "internal($PRINT_TYPE_INTERNAL)") { printer.setPrintType(PRINT_TYPE_INTERNAL) }
      cachedPrinter = printer
      Result.success(printer)
    } catch (e: TimeoutException) {
      construct.cancel(true)
      thread.interrupt()
      record("newPrinter", null, false, "timeout after ${BIND_TIMEOUT_MS}ms")
      Log.e(TAG, "Printer construction exceeded ${BIND_TIMEOUT_MS}ms", e)
      Result.failure(
        PrinterSetupException(
          "PRINTER_BIND_TIMEOUT",
          "The printer service did not respond within ${BIND_TIMEOUT_MS / 1000} seconds. " +
            "It is installed but not answering — restart the terminal and try again.",
        ),
      )
    } catch (e: ExecutionException) {
      record("newPrinter", null, false, e.cause?.message ?: e.message)
      Log.e(TAG, "Printer construction threw", e)
      Result.failure(
        PrinterSetupException(
          "PRINTER_BIND_FAILED",
          "Could not connect to the printer service: ${e.cause?.message ?: e.message}",
        ),
      )
    } catch (e: Exception) {
      record("newPrinter", null, false, e.message)
      Log.e(TAG, "Printer construction failed", e)
      Result.failure(
        PrinterSetupException("PRINTER_BIND_FAILED", e.message ?: "Could not connect to the printer"),
      )
    }
  }

  /** Runs [block] on the printer thread with a ceiling; never blocks the RN bridge. */
  private fun withPrinter(
    promise: Promise,
    timeoutMs: Long,
    block: (Printer) -> Any?,
  ) {
    val task =
      printerExecutor.submit(
        Callable {
          // ensurePrinter() constructs on its own thread — it does NOT re-enter this executor.
          val printer = ensurePrinter().getOrElse { throw it }
          block(printer)
        },
      )
    Thread {
      try {
        val value = task.get(timeoutMs, TimeUnit.MILLISECONDS)
        lastJobOutcome = "success"
        resolvePromise(promise, value)
      } catch (e: TimeoutException) {
        task.cancel(true)
        lastJobOutcome = "timeout after ${timeoutMs}ms"
        record("jobTimeout", null, false, "exceeded ${timeoutMs}ms")
        rejectPromise(promise, "PRINTER_TIMEOUT", "The printer did not respond in time.", e)
      } catch (e: ExecutionException) {
        when (val cause = e.cause) {
          is PrinterSetupException -> {
            lastJobOutcome = cause.code
            rejectPromise(promise, cause.code, cause.message, cause)
          }
          is PrintStepException -> {
            lastJobOutcome = "failed at ${cause.step}"
            rejectPromise(promise, "PRINT_FAILED", cause.message, cause)
          }
          else -> {
            lastJobOutcome = "failed: ${cause?.message ?: e.message}"
            rejectPromise(promise, "PRINT_FAILED", cause?.message ?: e.message, e)
          }
        }
      } catch (e: Exception) {
        lastJobOutcome = "failed: ${e.message}"
        rejectPromise(promise, "PRINT_FAILED", e.message, e)
      }
    }
      .start()
  }

  // ---------------------------------------------------------------- layout

  /**
   * SDK6's addMultiText needed absolute dot widths, so it computed column arithmetic by hand.
   * SDK4's printMultiseriateString takes a PROPORTION array and divides itself.
   */
  private fun addLine(printer: Printer, index: Int, line: LineSnapshot) {
    when (line) {
      is LineSnapshot.Text ->
        step("line[$index].text", line.text.take(24)) {
          printer.printString(
            line.text,
            if (line.large) LARGE_FONT_SIZE else DEFAULT_FONT_SIZE,
            alignFrom(line.align),
            line.bold,
            false,
          )
        }
      is LineSnapshot.Row -> {
        val count = line.columns.size
        if (count == 0) return
        // #166: this was `if (it == 0 && count > 1) 3 else 1`, the vendor demo's four-column
        // rule applied to two-column rows, which left the value column ~8 characters.
        val proportions = receiptColumnProportions(count)
        // NOTE: printMultiseriateString is declared STATIC on Printer, unlike every other print
        // call on this class. It still operates on BaseBinder's shared `protected static
        // mService`, so it is only valid once an instance has been constructed and the binder
        // pool has connected -- which `printer` here guarantees. Do not hoist above ensurePrinter().
        step("line[$index].row", "${count} cols") {
          Printer.printMultiseriateString(
            proportions,
            line.columns.toTypedArray(),
            DEFAULT_FONT_SIZE,
            Printer.Align.LEFT,
            false,
            false,
          )
        }
      }
      is LineSnapshot.Feed ->
        repeat(line.lines.coerceAtLeast(0)) { n ->
          step("line[$index].feed[$n]") {
            printer.printString(" ", DEFAULT_FONT_SIZE, Printer.Align.LEFT, false, false)
          }
        }
      LineSnapshot.Divider ->
        step("line[$index].divider") {
          printer.printString(DIVIDER_TEXT, DEFAULT_FONT_SIZE, Printer.Align.CENTER, false, false)
        }
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
      resolvePromise(promise, resolution is ServiceResolution.Ok)
    }
      .start()
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    withPrinter(promise, STATUS_TIMEOUT_MS) { printer ->
      val status = IntArray(1)
      val ret = softStep("getPrinterStatus") { printer.getPrinterStatus(status) }
      WritableNativeMap().apply {
        putInt("result", ret)
        putInt("status", status[0])
        // USBPrinting.java ICommonCallback: 0 = normal, 2 = out of paper.
        putBoolean("connected", ret == ERR_SUCCESS)
        putBoolean("hasPaper", status[0] != 2)
        putBoolean("statusUnknown", ret != ERR_SUCCESS)
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

    beginJob("printJob(${snapshot.size} lines)")

    withPrinter(promise, PRINT_TIMEOUT_MS) { printer ->
      // Gray level is persistent config; the SDK notes it needs a printer restart to take
      // effect, so a non-zero result is recorded but not fatal.
      softStep("setGrayLevel", "level=$grayLevel") { printer.setGrayLevel(grayLevel) }

      if (paperWidth != null) {
        step("setPrintPaperWide", "width=${paperWidth}mm") { printer.setPrintPaperWide(paperWidth) }
      } else {
        val typeCode =
          try {
            printer.setPrintPaperType(paperType)
          } catch (e: Exception) {
            record("setPrintPaperType", null, false, e.message)
            throw PrintStepException("setPrintPaperType", null, e.message, e)
          }
        record("setPrintPaperType", typeCode, typeCode == ERR_SUCCESS, "type=$paperType")
        if (typeCode != ERR_SUCCESS) {
          throw PrintStepException("setPrintPaperType", typeCode, paperResultMessage(typeCode))
        }
      }

      step("printInit") { printer.printInit() }
      step("clearPrintDataCache") { printer.clearPrintDataCache() }

      snapshot.forEachIndexed { i, line -> addLine(printer, i, line) }

      step("printPaper", "feed=$feedAfterDots") { printer.printPaper(feedAfterDots) }
      step("printFinish") { printer.printFinish() }
      Log.i(TAG, "=== job complete ===")
      true
    }
  }

  /**
   * Step-by-step results of the most recent job, for the Diagnostics screen.
   *
   * ADB is not reachable on these terminals and TMS is the only deploy path, so logcat is not
   * a diagnostic channel in practice. This is.
   */
  @ReactMethod
  fun getLastPrintSteps(promise: Promise) {
    val arr = WritableNativeArray()
    synchronized(lastSteps) {
      for (s in lastSteps) {
        arr.pushMap(
          WritableNativeMap().apply {
            putString("step", s.step)
            if (s.code != null) putInt("code", s.code) else putNull("code")
            putBoolean("ok", s.ok)
            putString("detail", s.detail ?: "")
          },
        )
      }
    }
    resolvePromise(
      promise,
      WritableNativeMap().apply {
        putArray("steps", arr)
        putString("outcome", lastJobOutcome)
        putDouble("startedAt", lastJobStartedAt.toDouble())
        putInt("count", arr.size())
      },
    )
  }

  /** New capability — no SDK6 equivalent. */
  @ReactMethod
  fun cutPaper(promise: Promise) {
    beginJob("cutPaper")
    withPrinter(promise, STATUS_TIMEOUT_MS) { printer ->
      step("cutPaper") { printer.cutPaper() }
      true
    }
  }

  /** New capability — no SDK6 equivalent. */
  @ReactMethod
  fun setPrintLineSpacing(lineSpacing: Int, promise: Promise) {
    beginJob("setPrintLineSpacing($lineSpacing)")
    withPrinter(promise, STATUS_TIMEOUT_MS) { printer ->
      step("setPrintLineSpacing", "spacing=$lineSpacing") { printer.setPrintLineSpacing(lineSpacing) }
      true
    }
  }

  /** Diagnostics: what the device actually offers for the SDK4 binder pool action. */
  @ReactMethod
  fun probeService(promise: Promise) {
    Thread {
      val pm = reactContext.applicationContext.packageManager
      val matches = pm.queryIntentServices(Intent(BINDER_POOL_ACTION), 0) ?: emptyList()
      val components = WritableNativeArray()
      for (m in matches) components.pushString("${m.serviceInfo.packageName}/${m.serviceInfo.name}")
      resolvePromise(
        promise,
        WritableNativeMap().apply {
          putString("action", BINDER_POOL_ACTION)
          putString("expectedPackage", BINDER_POOL_PACKAGE)
          putInt("matchCount", matches.size)
          putArray("components", components)
          putString(
            "summary",
            when (matches.size) {
              0 -> "PRINTER_SERVICE_ABSENT — no app provides $BINDER_POOL_ACTION"
              1 -> "OK — exactly one component, SDK can bind"
              else -> "PRINTER_SERVICE_AMBIGUOUS — ${matches.size} providers"
            },
          )
        },
      )
    }
      .start()
  }
}
