package com.flashtap.pos

import android.content.pm.PackageManager
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
import com.wisepos.smartpos.InitPosSdkListener
import com.wisepos.smartpos.WisePosException
import com.wisepos.smartpos.WisePosSdk
import com.wisepos.smartpos.errorcode.WisePosErrorCode
import com.wisepos.smartpos.printer.Align
import com.wisepos.smartpos.printer.Printer
import com.wisepos.smartpos.printer.PrinterListener
import com.wisepos.smartpos.printer.TextInfo
import java.lang.reflect.Modifier
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Built-in Wiseasy printer bridge.
 *
 * Hardened against every failure mode we identified vs SDKDemo:
 *  1. SDK bound at MainActivity.onCreate (WisePosSdkBootstrap) — not only on first print
 *  2. Activity context for any re-init (never Application-only when Activity exists)
 *  3. Print/status on UI thread (PrinterActivity pattern)
 *  4. Fresh getPrinter() per job (no stale cached handle after service death)
 *  5. initPrinter → setGrayLevel → status → setPrintFont → setLineSpacing → add* → startPrinting
 *  6. Independent timeouts so hung SDK calls still reject the JS promise
 *  7. One reconnect on SDK_NOT_CONNECTED
 *  8. Paper: docs 0=has paper, 1=none; null status does not block print
 */
class WiseSdk6PrinterModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "WiseSdk6PrinterModule"

  companion object {
    private const val TAG = "WiseSdk6PrinterModule"
    private const val ENSURE_TIMEOUT_MS = 10_000L
    private const val PRINT_TIMEOUT_MS = 20_000L
    private const val STATUS_TIMEOUT_MS = 8_000L
    private const val REAL_INIT_TIMEOUT_MS = 15_000L
    private const val DEFAULT_FEED_DOTS = 30
    private const val DEFAULT_FONT_SIZE = 24
    private const val LARGE_FONT_SIZE = 32
    private const val CANVAS_WIDTH_DOTS = 384
    private const val DEFAULT_GRAY_LEVEL = 3
    private const val DIVIDER_TEXT = "--------------------------------------------"
    private const val ERR_SUCCESS = 0
    private val UNSUPPORTED_MODELS = setOf("T2", "P5L")
    private val P5_FONT_MODELS = setOf("P5SE", "P5MAX", "P052")
  }

  private sealed class LineSnapshot {
    data class Text(val text: String, val align: String?, val bold: Boolean, val large: Boolean) :
      LineSnapshot()

    data class Row(val columns: List<String>) : LineSnapshot()

    data class Feed(val lines: Int) : LineSnapshot()

    object Divider : LineSnapshot()
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val timeoutScheduler = Executors.newSingleThreadScheduledExecutor()

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post(block)
    }
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
      if (throwable != null) {
        promise.reject(code, message, throwable)
      } else {
        promise.reject(code, message)
      }
    }
  }

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

  private fun isOutOfPaper(status: Map<String, Any>?): Boolean {
    if (status == null) return false
    val raw = status["paper"] ?: return false
    val asByte: Byte =
      when (raw) {
        is Byte -> raw
        is Number -> raw.toByte()
        else -> {
          Log.w(TAG, "Unexpected paper type=${raw.javaClass.name} value=$raw")
          return false
        }
      }
    Log.d(TAG, "paper raw=$raw asByte=$asByte (1=out)")
    return asByte.toInt() == 1
  }

  @ReactMethod
  fun isAvailable(promise: Promise) {
    resolvePromise(promise, !UNSUPPORTED_MODELS.contains(Build.MODEL))
  }

  /**
   * Staging forensic: call the **real** WisePosSdk.initPosSdk() exactly as SDKDemo
   * MainActivity does — not our PackageManager probe. Reports onInitPosSuccess /
   * onInitPosFail(errorCode) with WisePosErrorCode name lookup; on success also
   * calls getPrinter().getPrinterStatus().
   */
  @ReactMethod
  fun testRealInitPosSdk(promise: Promise) {
    @Suppress("DEPRECATION")
    val activity = getCurrentActivity()
    if (activity == null) {
      rejectPromise(
        promise,
        "NO_ACTIVITY",
        "No Activity — initPosSdk needs an Activity Context like SDKDemo MainActivity",
        null,
      )
      return
    }

    // Exact SDKDemo MainActivity pattern: getInstance() then initPosSdk(this, listener).
    // Pass the Activity itself (not applicationContext) — same as SDKDemo's `this`.
    val settled = AtomicBoolean(false)
    val timeoutFuture =
      timeoutScheduler.schedule(
        {
          if (settled.compareAndSet(false, true)) {
            val map = Arguments.createMap()
            map.putString("outcome", "TIMEOUT")
            map.putString(
              "summary",
              "Neither onInitPosSuccess nor onInitPosFail within ${REAL_INIT_TIMEOUT_MS}ms",
            )
            map.putString("contextClass", activity.javaClass.name)
            resolvePromise(promise, map)
          }
        },
        REAL_INIT_TIMEOUT_MS,
        TimeUnit.MILLISECONDS,
      )

    fun finish(builder: () -> com.facebook.react.bridge.WritableMap) {
      if (!settled.compareAndSet(false, true)) return
      timeoutFuture.cancel(false)
      try {
        resolvePromise(promise, builder())
      } catch (e: Exception) {
        rejectPromise(promise, "REAL_INIT_RESOLVE_FAILED", e.message, e)
      }
    }

    Handler(Looper.getMainLooper()).post {
      // Capture discovery state with the SAME flags the SDK uses, immediately
      // before the real initPosSdk call — so a 7101 can be attributed to the
      // correct bytecode branch (null Context vs getExplicitIntent==null).
      val preProbe = WisePosSdkBootstrap.probeUsdkService(activity)
      try {
        Log.i(
          TAG,
          "testRealInitPosSdk: SDKDemo-identical call " +
            "WisePosSdk.getInstance().initPosSdk(Activity=${activity.javaClass.name}) " +
            "preProbe=${preProbe.summary()}",
        )
        val wisePosSdk = WisePosSdk.getInstance()
        wisePosSdk.initPosSdk(
          activity,
          object : InitPosSdkListener {
            override fun onInitPosSuccess() {
              Log.i(TAG, "testRealInitPosSdk: onInitPosSuccess")
              finish {
                val map = Arguments.createMap()
                map.putString("outcome", "SUCCESS")
                map.putInt("errorCode", WisePosErrorCode.ERR_SUCCESS)
                map.putString("errorName", "ERR_SUCCESS")
                map.putString("failBranch", "none")
                map.putString("contextClass", activity.javaClass.name)
                map.putInt("preInitMatchCount", preProbe.matchCount)
                map.putString(
                  "summary",
                  "WisePosSdk.initPosSdk → onInitPosSuccess()",
                )
                try {
                  val printer = WisePosSdk.getInstance().getPrinter()
                  val status = printer.getPrinterStatus()
                  map.putBoolean("printerStatusOk", true)
                  map.putString("printerStatusError", "")
                  val statusMap = Arguments.createMap()
                  if (status != null) {
                    for ((k, v) in status) {
                      when (v) {
                        null -> statusMap.putNull(k)
                        is Boolean -> statusMap.putBoolean(k, v)
                        is Int -> statusMap.putInt(k, v)
                        is Long -> statusMap.putDouble(k, v.toDouble())
                        is Float -> statusMap.putDouble(k, v.toDouble())
                        is Double -> statusMap.putDouble(k, v)
                        is Number -> statusMap.putDouble(k, v.toDouble())
                        else -> statusMap.putString(k, v.toString())
                      }
                    }
                  }
                  map.putMap("printerStatus", statusMap)
                  map.putString(
                    "printerStatusRaw",
                    status?.toString() ?: "null",
                  )
                } catch (e: WisePosException) {
                  map.putBoolean("printerStatusOk", false)
                  map.putString(
                    "printerStatusError",
                    "WisePosException errorCode=${e.errorCode} (${wisePosErrorName(e.errorCode)}) ${e.message}",
                  )
                  map.putString("printerStatusRaw", "")
                } catch (e: Exception) {
                  map.putBoolean("printerStatusOk", false)
                  map.putString(
                    "printerStatusError",
                    "${e.javaClass.simpleName}: ${e.message}",
                  )
                  map.putString("printerStatusRaw", "")
                }
                map
              }
            }

            override fun onInitPosFail(errorCode: Int) {
              Log.w(TAG, "testRealInitPosSdk: onInitPosFail code=$errorCode")
              finish {
                val name = wisePosErrorName(errorCode)
                // Bytecode of initPosSdk: 7101 from (1) context==null OR
                // (2) getExplicitIntent==null (queryIntentServices size != 1).
                // We passed a live Activity, so (1) is impossible here → (2).
                val failBranch =
                  when {
                    errorCode != WisePosErrorCode.ERR_SDK_INVALID_PARAMETER ->
                      "other"
                    preProbe.matchCount != 1 ->
                      "GET_EXPLICIT_INTENT_NULL (queryIntentServices flags=0 " +
                        "matchCount=${preProbe.matchCount}, need exactly 1)"
                    else ->
                      "GET_EXPLICIT_INTENT_NULL (unexpected: matchCount was 1 " +
                        "at pre-probe — race or PackageManager inconsistency)"
                  }
                val map = Arguments.createMap()
                map.putString("outcome", "FAIL")
                map.putInt("errorCode", errorCode)
                map.putString("errorName", name)
                map.putString("failBranch", failBranch)
                map.putString("contextClass", activity.javaClass.name)
                map.putInt("preInitMatchCount", preProbe.matchCount)
                map.putString(
                  "summary",
                  "WisePosSdk.initPosSdk → onInitPosFail($errorCode) $name | $failBranch",
                )
                map.putBoolean("printerStatusOk", false)
                map.putString("printerStatusError", "skipped — init failed")
                map.putString("printerStatusRaw", "")
                map
              }
            }
          },
        )
      } catch (e: Exception) {
        Log.e(TAG, "testRealInitPosSdk: initPosSdk threw", e)
        finish {
          val map = Arguments.createMap()
          map.putString("outcome", "THREW")
          map.putInt("errorCode", -1)
          map.putString("errorName", e.javaClass.simpleName)
          map.putString("failBranch", "threw")
          map.putString("contextClass", activity.javaClass.name)
          map.putInt("preInitMatchCount", preProbe.matchCount)
          map.putString(
            "summary",
            "WisePosSdk.initPosSdk threw: ${e.javaClass.name}: ${e.message}",
          )
          map.putBoolean("printerStatusOk", false)
          map.putString("printerStatusError", e.message ?: "")
          map.putString("printerStatusRaw", "")
          map
        }
      }
    }
  }

  /** Map int → WisePosErrorCode field name (e.g. 7101 → ERR_SDK_INVALID_PARAMETER). */
  private fun wisePosErrorName(code: Int): String {
    try {
      for (field in WisePosErrorCode::class.java.declaredFields) {
        if (!Modifier.isStatic(field.modifiers)) continue
        if (field.type != Int::class.javaPrimitiveType) continue
        if (field.getInt(null) == code) return field.name
      }
    } catch (_: Exception) {
      // fall through
    }
    return "UNKNOWN"
  }

  /** Device probe: queryIntentServices(com.wisepos.aidl.service, 0) — same as SDK bind check. */
  @ReactMethod
  fun probeService(promise: Promise) {
    try {
      val probe = WisePosSdkBootstrap.probeUsdkService(reactContext)
      val pm = reactContext.packageManager
      val queryAll =
        pm.checkPermission(
          "android.permission.QUERY_ALL_PACKAGES",
          reactContext.packageName,
        ) == PackageManager.PERMISSION_GRANTED
      val map = Arguments.createMap()
      map.putString("action", probe.action)
      map.putInt("matchCount", probe.matchCount)
      map.putInt("matchAllCount", probe.matchAllCount)
      map.putString("model", probe.model)
      map.putInt("sdkInt", probe.sdkInt)
      map.putInt("targetSdk", probe.targetSdk)
      map.putBoolean("queryAllPackagesGranted", queryAll)
      map.putBoolean("packageVisibilityApplies", probe.targetSdk >= 30)
      map.putString("summary", probe.summary())
      val services = Arguments.createArray()
      probe.services.forEach { svc ->
        val row = Arguments.createMap()
        row.putString("packageName", svc.packageName)
        row.putString("serviceName", svc.serviceName)
        services.pushMap(row)
      }
      map.putArray("services", services)
      val comps = Arguments.createArray()
      probe.components.forEach { comps.pushString(it) }
      map.putArray("components", comps)
      resolvePromise(promise, map)
    } catch (e: Exception) {
      rejectPromise(promise, "PROBE_FAILED", e.message, e)
    }
  }

  /**
   * Staging forensic: dump ALL installed services (plus keyword matches and a
   * focus set of Wiseasy system packages), including ServiceInfo.permission and
   * that permission's protectionLevel. Does not bind or print.
   */
  @ReactMethod
  fun enumeratePrinterRelatedServices(promise: Promise) {
    try {
      val pm = reactContext.packageManager
      val queryAll =
        pm.checkPermission(
          "android.permission.QUERY_ALL_PACKAGES",
          reactContext.packageName,
        ) == PackageManager.PERMISSION_GRANTED

      @Suppress("DEPRECATION")
      val packages =
        pm.getInstalledPackages(PackageManager.GET_SERVICES) ?: emptyList()

      val keywords =
        listOf(
          "print",
          "printer",
          "wisepos",
          "wisedevice",
          "wiseasy",
          "usdk",
          "smartpos",
          "cashier",
        )
      val focusPackages =
        setOf(
          "com.wiseasy.finatic.cashier",
          "cn.wiseasy.leopardclaw",
          "com.wiseasy.wmmi",
          "wiseasy.com.market",
        )

      val allServices = Arguments.createArray()
      val hits = Arguments.createArray()
      val focusHits = Arguments.createArray()
      val signatureGated = Arguments.createArray()
      var packagesScanned = 0
      var servicesScanned = 0
      var focusServiceCount = 0
      var signatureGatedCount = 0

      for (pkg in packages) {
        packagesScanned++
        val pkgName = pkg.packageName ?: continue
        val isFocus = focusPackages.contains(pkgName)
        val services = pkg.services ?: continue
        for (si in services) {
          servicesScanned++
          val svcName = si.name ?: continue
          val row = serviceEnumRow(pm, pkgName, si)
          allServices.pushMap(cloneServiceRow(row))

          if (row.getBoolean("signatureGated")) {
            signatureGatedCount++
            signatureGated.pushMap(cloneServiceRow(row))
          }

          if (isFocus) {
            focusServiceCount++
            focusHits.pushMap(cloneServiceRow(row))
          }

          val hay = "${pkgName}/${svcName}".lowercase()
          val matched =
            keywords.any { hay.contains(it) } ||
              hay.contains(".pos.") ||
              hay.endsWith(".pos") ||
              Regex("""(^|[.\-_])pos([.\-_]|$)""").containsMatchIn(pkgName.lowercase())
          if (matched) {
            hits.pushMap(cloneServiceRow(row))
          }
        }
      }

      // Focus packages present but with zero services (or package not installed).
      val focusPackageStatus = Arguments.createArray()
      for (name in focusPackages.sorted()) {
        val status = Arguments.createMap()
        status.putString("packageName", name)
        val installed = packages.any { it.packageName == name }
        status.putBoolean("installed", installed)
        val svcCount =
          packages
            .firstOrNull { it.packageName == name }
            ?.services
            ?.size
            ?: 0
        status.putInt("serviceCount", svcCount)
        focusPackageStatus.pushMap(status)
      }

      // Also list packages whose *name* alone matches (even with no services returned).
      val relatedPackages = Arguments.createArray()
      for (pkg in packages) {
        val pkgName = pkg.packageName ?: continue
        val lower = pkgName.lowercase()
        if (
          keywords.any { lower.contains(it) } ||
            lower.contains(".pos.") ||
            Regex("""(^|[.\-_])pos([.\-_]|$)""").containsMatchIn(lower)
        ) {
          relatedPackages.pushString(pkgName)
        }
      }

      val map = Arguments.createMap()
      map.putBoolean("queryAllPackagesGranted", queryAll)
      map.putInt("targetSdk", reactContext.applicationInfo.targetSdkVersion)
      map.putInt("sdkInt", Build.VERSION.SDK_INT)
      map.putString("model", Build.MODEL ?: "?")
      map.putInt("packagesScanned", packagesScanned)
      map.putInt("servicesScanned", servicesScanned)
      map.putInt("matchingServiceCount", hits.size())
      map.putArray("matchingServices", hits)
      map.putArray("relatedPackageNames", relatedPackages)
      map.putInt("allServiceCount", allServices.size())
      map.putArray("allServices", allServices)
      map.putInt("focusServiceCount", focusServiceCount)
      map.putArray("focusPackageServices", focusHits)
      map.putArray("focusPackageStatus", focusPackageStatus)
      map.putInt("signatureGatedServiceCount", signatureGatedCount)
      map.putArray("signatureGatedServices", signatureGated)
      resolvePromise(promise, map)
    } catch (e: Exception) {
      rejectPromise(promise, "ENUMERATE_FAILED", e.message, e)
    }
  }

  private fun serviceEnumRow(
    pm: PackageManager,
    pkgName: String,
    si: android.content.pm.ServiceInfo,
  ): com.facebook.react.bridge.WritableMap {
    val row = Arguments.createMap()
    row.putString("packageName", pkgName)
    row.putString("serviceName", si.name ?: "")
    row.putBoolean("exported", si.exported)
    row.putBoolean("enabled", si.enabled)
    val perm = si.permission
    row.putString("permission", perm ?: "")
    var protLevel = -1
    var protLabel = ""
    var signatureGated = false
    if (!perm.isNullOrEmpty()) {
      try {
        @Suppress("DEPRECATION")
        val pi = pm.getPermissionInfo(perm, 0)
        protLevel = pi.protectionLevel
        val base = protLevel and android.content.pm.PermissionInfo.PROTECTION_MASK_BASE
        signatureGated =
          base == android.content.pm.PermissionInfo.PROTECTION_SIGNATURE ||
            base == android.content.pm.PermissionInfo.PROTECTION_SIGNATURE_OR_SYSTEM
        protLabel =
          when (base) {
            android.content.pm.PermissionInfo.PROTECTION_NORMAL -> "normal"
            android.content.pm.PermissionInfo.PROTECTION_DANGEROUS -> "dangerous"
            android.content.pm.PermissionInfo.PROTECTION_SIGNATURE -> "signature"
            android.content.pm.PermissionInfo.PROTECTION_SIGNATURE_OR_SYSTEM ->
              "signature|system"
            else -> "other($base)"
          }
        if (
          (protLevel and android.content.pm.PermissionInfo.PROTECTION_FLAG_PRIVILEGED) != 0
        ) {
          protLabel += "|privileged"
        }
      } catch (_: PackageManager.NameNotFoundException) {
        protLabel = "unknown"
      }
    }
    row.putInt("protectionLevel", protLevel)
    row.putString("protectionLabel", protLabel)
    row.putBoolean("signatureGated", signatureGated)
    return row
  }

  private fun cloneServiceRow(
    src: com.facebook.react.bridge.ReadableMap,
  ): com.facebook.react.bridge.WritableMap {
    val row = Arguments.createMap()
    row.putString("packageName", src.getString("packageName") ?: "")
    row.putString("serviceName", src.getString("serviceName") ?: "")
    row.putBoolean("exported", src.getBoolean("exported"))
    row.putBoolean("enabled", src.getBoolean("enabled"))
    row.putString("permission", src.getString("permission") ?: "")
    row.putInt("protectionLevel", src.getInt("protectionLevel"))
    row.putString("protectionLabel", src.getString("protectionLabel") ?: "")
    row.putBoolean("signatureGated", src.getBoolean("signatureGated"))
    return row
  }

  /**
   * Ensures SDK service is bound (onInitPosSuccess), then returns Printer.
   * getPrinter() alone is NOT proof of readiness — it returns a stub singleton.
   */
  private fun withPrinter(
    forceReconnect: Boolean = false,
    callback: (Printer?, errorCode: String?, errorMessage: String?) -> Unit,
  ) {
    @Suppress("DEPRECATION")
    val activity = getCurrentActivity()

    val settled = AtomicBoolean(false)
    val timeoutFuture =
      timeoutScheduler.schedule(
        {
          if (settled.compareAndSet(false, true)) {
            callback(null, "SDK_INIT_FAILED", "Printer SDK init timed out")
          }
        },
        ENSURE_TIMEOUT_MS,
        TimeUnit.MILLISECONDS,
      )

    fun done(printer: Printer?, code: String?, message: String?) {
      if (!settled.compareAndSet(false, true)) return
      timeoutFuture.cancel(false)
      callback(printer, code, message)
    }

    val resolver =
      if (forceReconnect) {
        WisePosSdkBootstrap::forceReconnect
      } else {
        WisePosSdkBootstrap::resolvePrinter
      }

    resolver(activity) { printer, code, message ->
      runOnMain { done(printer, code, message) }
    }
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    withPrinter { printerInstance, errorCode, errorMessage ->
      if (printerInstance == null) {
        rejectPromise(promise, errorCode ?: "SDK_INIT_FAILED", errorMessage)
        return@withPrinter
      }

      val settled = AtomicBoolean(false)
      val timeoutFuture =
        timeoutScheduler.schedule(
          {
            if (settled.compareAndSet(false, true)) {
              rejectPromise(promise, "STATUS_FAILED", "Printer status timed out")
            }
          },
          STATUS_TIMEOUT_MS,
          TimeUnit.MILLISECONDS,
        )

      runOnMain {
        try {
          val status = printerInstance.getPrinterStatus()
          if (!settled.compareAndSet(false, true)) return@runOnMain
          timeoutFuture.cancel(false)
          if (status == null) {
            rejectPromise(promise, "STATUS_UNAVAILABLE", "Could not read printer status")
            return@runOnMain
          }
          val result = Arguments.createMap()
          result.putBoolean("hasPaper", !isOutOfPaper(status))
          result.putBoolean("connected", true)
          val temperature = status["temperature"]
          if (temperature is Number) {
            result.putDouble("temperature", temperature.toDouble())
          }
          resolvePromise(promise, result)
        } catch (e: Exception) {
          if (!settled.compareAndSet(false, true)) return@runOnMain
          timeoutFuture.cancel(false)
          Log.e(TAG, "getStatus failed", e)
          rejectPromise(promise, "STATUS_FAILED", e.message, e)
        }
      }
    }
  }

  @ReactMethod
  fun printJob(lines: ReadableArray, options: ReadableMap?, promise: Promise) {
    val snapshot = snapshotLines(lines)
    if (snapshot.isEmpty()) {
      rejectPromise(promise, "INVALID_PAYLOAD", "Print job has no lines")
      return
    }
    val feedAfterDots =
      if (options?.hasKey("feedAfterDots") == true) {
        options.getInt("feedAfterDots")
      } else {
        DEFAULT_FEED_DOTS
      }

    withPrinter { printerInstance, errorCode, errorMessage ->
      if (printerInstance == null) {
        rejectPromise(promise, errorCode ?: "SDK_INIT_FAILED", errorMessage)
        return@withPrinter
      }
      runOnMain {
        executePrintJob(printerInstance, snapshot, feedAfterDots, promise, allowReconnect = true)
      }
    }
  }

  private fun executePrintJob(
    printerInstance: Printer,
    lines: List<LineSnapshot>,
    feedAfterDots: Int,
    promise: Promise,
    allowReconnect: Boolean,
  ) {
    val settled = AtomicBoolean(false)
    var timeoutFuture: ScheduledFuture<*>? = null

    fun settleReject(mappedCode: String, message: String?, cause: Exception? = null) {
      if (!settled.compareAndSet(false, true)) return
      timeoutFuture?.cancel(false)
      Log.w(TAG, "printJob reject code=$mappedCode msg=$message")
      if (
        mappedCode == "SDK_NOT_CONNECTED"
      ) {
        // Only soft-invalidate on true disconnect — re-init after ordinary failures
        // often breaks a still-bound service ("Couldn't reach the built-in printer").
        WisePosSdkBootstrap.invalidate(mappedCode)
      }
      rejectPromise(promise, mappedCode, message, cause)
    }

    fun settleResolve() {
      if (!settled.compareAndSet(false, true)) return
      timeoutFuture?.cancel(false)
      resolvePromise(promise, true)
    }

    fun failOrReconnect(mappedCode: String, message: String?, cause: Exception? = null) {
      if (mappedCode == "SDK_NOT_CONNECTED" && allowReconnect) {
        if (!settled.compareAndSet(false, true)) return
        timeoutFuture?.cancel(false)
        Log.w(TAG, "SDK_NOT_CONNECTED — forcing initPosSdk rebind then retry print")
        WisePosSdkBootstrap.invalidate("SDK_NOT_CONNECTED during print")
        withPrinter(forceReconnect = true) { fresh, errorCode, errorMessage ->
          if (fresh == null) {
            rejectPromise(
              promise,
              errorCode ?: "SDK_NOT_CONNECTED",
              errorMessage ?: message,
            )
            return@withPrinter
          }
          runOnMain {
            executePrintJob(fresh, lines, feedAfterDots, promise, allowReconnect = false)
          }
        }
        return
      }
      settleReject(mappedCode, message, cause)
    }

    timeoutFuture =
      timeoutScheduler.schedule(
        {
          Log.e(TAG, "printJob timed out after ${PRINT_TIMEOUT_MS}ms")
          settleReject("PRINT_TIMEOUT", "Print timed out waiting for the printer")
        },
        PRINT_TIMEOUT_MS,
        TimeUnit.MILLISECONDS,
      )

    try {
      Log.i(
        TAG,
        "printJob start lines=${lines.size} model=${Build.MODEL} bootstrapReady=${WisePosSdkBootstrap.isPosReady()}",
      )

      // --- SDKDemo PrinterActivity.printText() sequence ---
      // 7102 = ERR_SDK_SERVICE_NOT_CONNECTED — getPrinter() stub can exist without a live bind.
      val initRet = printerInstance.initPrinter()
      if (initRet != ERR_SUCCESS) {
        failOrReconnect(
          errorCodeOf(initRet),
          "initPrinter failed (code $initRet / 0x${Integer.toHexString(initRet)})",
        )
        return
      }

      val grayRet = printerInstance.setGrayLevel(DEFAULT_GRAY_LEVEL)
      if (grayRet != ERR_SUCCESS) {
        settleReject("PRINTER_ERROR", "setGrayLevel failed (code $grayRet)")
        return
      }

      try {
        val status = printerInstance.getPrinterStatus()
        if (status != null && isOutOfPaper(status)) {
          settleReject("OUT_OF_PAPER", "The printer is out of paper")
          return
        }
      } catch (e: Exception) {
        Log.w(TAG, "getPrinterStatus before print failed — continuing", e)
      }

      val fontBundle = Bundle()
      fontBundle.putString(
        "font",
        if (Build.MODEL in P5_FONT_MODELS) "sans-serif-light" else "DEFAULT",
      )
      printerInstance.setPrintFont(fontBundle)

      try {
        printerInstance.setLineSpacing(1)
      } catch (e: Exception) {
        Log.w(TAG, "setLineSpacing failed — continuing", e)
      }

      for (line in lines) {
        addLine(printerInstance, line)
      }

      printerInstance.startPrinting(
        Bundle(),
        object : PrinterListener {
          override fun onError(errorCode: Int) {
            Log.e(TAG, "startPrinting onError code=$errorCode (0x${Integer.toHexString(errorCode)})")
            failOrReconnect(
              errorCodeOf(errorCode),
              "Print failed (code $errorCode / 0x${Integer.toHexString(errorCode)})",
            )
          }

          override fun onFinish() {
            try {
              printerInstance.feedPaper(feedAfterDots)
            } catch (e: WisePosException) {
              Log.w(TAG, "feedPaper failed after successful print", e)
            }
            settleResolve()
          }

          override fun onReport(status: Int) {
            Log.d(TAG, "startPrinting onReport status=$status")
          }
        },
      )
    } catch (e: WisePosException) {
      failOrReconnect(errorCodeOf(e.errorCode), e.message, e)
    } catch (e: Exception) {
      settleReject("PRINT_FAILED", e.message, e)
    }
  }

  private fun addLine(printerInstance: Printer, line: LineSnapshot) {
    when (line) {
      is LineSnapshot.Text -> {
        val info = TextInfo()
        info.setText(line.text)
        info.setAlign(alignFrom(line.align))
        info.setFontSize(if (line.large) LARGE_FONT_SIZE else DEFAULT_FONT_SIZE)
        info.setBold(line.bold)
        printerInstance.addSingleText(info)
      }
      is LineSnapshot.Row -> {
        val count = line.columns.size
        if (count == 0) return
        val columnWidth = CANVAS_WIDTH_DOTS / count
        val list = ArrayList<TextInfo>()
        for (i in 0 until count) {
          val info = TextInfo()
          info.setText(line.columns[i])
          info.setAlign(
            if (i == count - 1) Align.PRINT_ALIGN_STYLE_RIGHT else Align.PRINT_ALIGN_STYLE_LEFT,
          )
          info.setFontSize(DEFAULT_FONT_SIZE)
          info.setWidth(
            if (i == count - 1) CANVAS_WIDTH_DOTS - columnWidth * (count - 1) else columnWidth,
          )
          info.setColumnSpacing(0)
          list.add(info)
        }
        printerInstance.addMultiText(list)
      }
      is LineSnapshot.Feed -> {
        repeat(line.lines.coerceAtLeast(0)) {
          val blank = TextInfo()
          blank.setText("")
          printerInstance.addSingleText(blank)
        }
      }
      LineSnapshot.Divider -> {
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

  private fun errorCodeOf(code: Int): String =
    when (code) {
      WisePosErrorCode.ERR_PRINTER_RUN_OUT_PAPER -> "OUT_OF_PAPER"
      WisePosErrorCode.ERR_PRINTER_TEMPERATURE, WisePosErrorCode.ERR_SVR_PRINTER_TEMPERATURE ->
        "PRINTER_OVERHEATED"
      WisePosErrorCode.ERR_PRINTER, WisePosErrorCode.ERR_SVR_PRINTER_STATUS_ERROR -> "PRINTER_ERROR"
      WisePosErrorCode.ERR_SDK_SERVICE_NOT_CONNECTED, WisePosErrorCode.ERR_SDK_DEVICE_UNCONNECTED ->
        "SDK_NOT_CONNECTED"
      WisePosErrorCode.ERR_SVR_LOW_BATTERY -> "LOW_BATTERY"
      else -> "PRINT_FAILED"
    }
}
