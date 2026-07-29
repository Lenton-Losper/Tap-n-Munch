package com.flashtap.pos

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Staging diagnostic: Android system print framework (PrintManager) — separate from
 * WisePos AIDL / WiseSdk_P.
 *
 * Note: PrintManager.getPrintServices() is a @SystemApi / hidden API on many SDK
 * levels, so we discover print services the public way: PackageManager query for
 * intent action android.printservice.PrintService (what BIPS registers).
 */
class PrintFrameworkModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "PrintFrameworkModule"

  /**
   * Lists print services Android can resolve for the standard PrintService
   * intent, plus a reflective attempt at PrintManager.getPrintServices() when
   * available. Flags BIPS (com.android.bips) explicitly.
   */
  @ReactMethod
  fun listPrintServices(promise: Promise) {
    try {
      val pm = reactContext.packageManager
      val intent = Intent(PRINT_SERVICE_INTERFACE)

      val resolvedDefault =
        pm.queryIntentServices(intent, 0) ?: emptyList()
      val resolvedMatchAll =
        try {
          pm.queryIntentServices(intent, PackageManager.MATCH_ALL) ?: emptyList()
        } catch (_: Exception) {
          emptyList()
        }

      val reflective = reflectPrintManagerServices()

      val map = Arguments.createMap()
      map.putInt("sdkInt", Build.VERSION.SDK_INT)
      map.putString("model", Build.MODEL ?: "")
      map.putString("manufacturer", Build.MANUFACTURER ?: "")
      map.putString("printServiceIntent", PRINT_SERVICE_INTERFACE)
      map.putArray("resolvedServicesFlags0", resolveInfosToArray(resolvedDefault))
      map.putArray("resolvedServicesMatchAll", resolveInfosToArray(resolvedMatchAll))
      map.putInt("resolvedFlags0Count", resolvedDefault.size)
      map.putInt("resolvedMatchAllCount", resolvedMatchAll.size)

      map.putBoolean("printManagerGetPrintServicesAvailable", reflective.available)
      map.putString("printManagerGetPrintServicesNote", reflective.note)
      map.putArray("printManagerEnabledServices", reflective.enabled)
      map.putArray("printManagerAllServices", reflective.all)
      map.putInt("printManagerEnabledCount", reflective.enabled.size())
      map.putInt("printManagerAllCount", reflective.all.size())

      val bipsInResolved =
        resolvedDefault.any { isBipsPackage(it.serviceInfo?.packageName) } ||
          resolvedMatchAll.any { isBipsPackage(it.serviceInfo?.packageName) }
      val bipsInReflective =
        arrayContainsBips(reflective.enabled) || arrayContainsBips(reflective.all)

      map.putBoolean("bipsResolvedViaPackageManager", bipsInResolved)
      map.putBoolean("bipsReportedByPrintManager", bipsInReflective)
      map.putBoolean("bipsPresent", bipsInResolved || bipsInReflective)

      map.putString(
        "silentPrintSupportedByFramework",
        "NO — PrintManager.print() always brings up the system print UI; " +
          "there is no public API to print silently to a default printer.",
      )
      map.putString(
        "summary",
        "pmFlags0=${resolvedDefault.size} pmMatchAll=${resolvedMatchAll.size} " +
          "reflectEnabled=${reflective.enabled.size()} " +
          "bipsPresent=${bipsInResolved || bipsInReflective} " +
          "model=${Build.MODEL}",
      )

      // Keep field names the Diagnostics UI already expects.
      map.putBoolean("bipsEnabled", bipsInResolved || bipsInReflective)
      map.putBoolean("bipsPresentInAll", bipsInResolved || bipsInReflective)
      map.putArray(
        "enabledServices",
        if (reflective.enabled.size() > 0) reflective.enabled
        else resolveInfosToArray(resolvedDefault),
      )
      map.putArray(
        "allServices",
        if (reflective.all.size() > 0) reflective.all
        else resolveInfosToArray(resolvedMatchAll.ifEmpty { resolvedDefault }),
      )
      map.putInt(
        "enabledCount",
        if (reflective.enabled.size() > 0) reflective.enabled.size()
        else resolvedDefault.size,
      )
      map.putInt(
        "allCount",
        if (reflective.all.size() > 0) reflective.all.size()
        else (resolvedMatchAll.ifEmpty { resolvedDefault }).size,
      )

      Log.i(TAG, "listPrintServices ${map.getString("summary")}")
      promise.resolve(map)
    } catch (e: Exception) {
      Log.e(TAG, "listPrintServices failed", e)
      promise.reject("LIST_FAILED", e.message, e)
    }
  }

  /**
   * Starts a system print job for a simple receipt-like PDF via PrintManager.
   * Android ALWAYS shows the system print UI — silent print is not available.
   */
  @ReactMethod
  fun printSystemTestReceipt(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.KITKAT) {
        promise.reject("UNSUPPORTED", "PrintManager requires API 19+")
        return
      }

      val activity: Activity =
        getCurrentActivity()
          ?: run {
            promise.reject("NO_ACTIVITY", "PrintManager.print() requires an Activity")
            return
          }

      activity.runOnUiThread {
        try {
          val printManager =
            activity.getSystemService(Context.PRINT_SERVICE) as? PrintManager
          if (printManager == null) {
            promise.reject("NO_PRINT_MANAGER", "PRINT_SERVICE null")
            return@runOnUiThread
          }

          val jobName = "FlashTap-BIPS-Test"
          val adapter = ReceiptPrintDocumentAdapter()
          val attrs =
            PrintAttributes.Builder()
              .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
              .setResolution(
                PrintAttributes.Resolution("flashtap", "flash", 203, 203),
              )
              .setColorMode(PrintAttributes.COLOR_MODE_MONOCHROME)
              .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
              .build()

          val job = printManager.print(jobName, adapter, attrs)

          val map = Arguments.createMap()
          map.putString("outcome", "PRINT_UI_SHOWN")
          map.putString("jobId", job.id?.toString() ?: "")
          map.putString("jobName", job.info?.label?.toString() ?: jobName)
          map.putInt("jobState", job.info?.state ?: -1)
          map.putBoolean("systemPrintUiRequired", true)
          map.putString(
            "note",
            "Android always shows the system print dialog for PrintManager.print(). " +
              "If BIPS (or another service) exposes a printer that reaches the P5 " +
              "thermal head, select it and confirm. If the picker shows only " +
              "cloud/Wi-Fi/Save-as-PDF options, BIPS is not bridging to the " +
              "built-in POS printer.",
          )
          map.putString(
            "timestamp",
            SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date()),
          )
          Log.i(TAG, "printSystemTestReceipt started job=${job.id}")
          promise.resolve(map)
        } catch (e: Exception) {
          Log.e(TAG, "printSystemTestReceipt failed", e)
          promise.reject("PRINT_FAILED", e.message, e)
        }
      }
    } catch (e: Exception) {
      promise.reject("PRINT_FAILED", e.message, e)
    }
  }

  private data class ReflectiveServices(
    val available: Boolean,
    val note: String,
    val enabled: WritableArray,
    val all: WritableArray,
  )

  /**
   * PrintManager.getPrintServices() is often @SystemApi / hidden from the public
   * SDK. Try reflection so we can report what Android itself would return when
   * the method is present on the device runtime.
   */
  private fun reflectPrintManagerServices(): ReflectiveServices {
    val empty = Arguments.createArray()
    return try {
      val printManager =
        reactContext.getSystemService(Context.PRINT_SERVICE) as? PrintManager
          ?: return ReflectiveServices(
            false,
            "PRINT_SERVICE null",
            empty,
            Arguments.createArray(),
          )

      val method =
        PrintManager::class.java.getMethod("getPrintServices", Int::class.javaPrimitiveType)
      val enabledFlag =
        PrintManager::class.java.getField("ENABLED_SERVICES").getInt(null)
      val allFlag = PrintManager::class.java.getField("ALL_SERVICES").getInt(null)

      @Suppress("UNCHECKED_CAST")
      val enabledList =
        (method.invoke(printManager, enabledFlag) as? List<*>) ?: emptyList<Any>()
      @Suppress("UNCHECKED_CAST")
      val allList =
        (method.invoke(printManager, allFlag) as? List<*>) ?: emptyList<Any>()

      ReflectiveServices(
        available = true,
        note =
          "PrintManager.getPrintServices() is available via reflection on this runtime " +
            "(may be @SystemApi in public SDK stubs).",
        enabled = printServiceObjectsToArray(enabledList),
        all = printServiceObjectsToArray(allList),
      )
    } catch (e: Exception) {
      ReflectiveServices(
        available = false,
        note =
          "PrintManager.getPrintServices() not callable from app: ${e.javaClass.simpleName}: " +
            "${e.message}. Falling back to PackageManager queryIntentServices(" +
            "android.printservice.PrintService).",
        enabled = Arguments.createArray(),
        all = Arguments.createArray(),
      )
    }
  }

  private fun printServiceObjectsToArray(list: List<*>): WritableArray {
    val arr = Arguments.createArray()
    for (item in list) {
      if (item == null) continue
      val m = Arguments.createMap()
      try {
        val cls = item.javaClass
        val getComponentName = cls.methods.firstOrNull { it.name == "getComponentName" && it.parameterCount == 0 }
        val getName = cls.methods.firstOrNull { it.name == "getName" && it.parameterCount == 0 }
        val isEnabled = cls.methods.firstOrNull { it.name == "isEnabled" && it.parameterCount == 0 }
        val component = getComponentName?.invoke(item)
        val pkg =
          component?.javaClass?.methods
            ?.firstOrNull { it.name == "getPackageName" && it.parameterCount == 0 }
            ?.invoke(component)
            ?.toString()
            ?: ""
        val className =
          component?.javaClass?.methods
            ?.firstOrNull { it.name == "getClassName" && it.parameterCount == 0 }
            ?.invoke(component)
            ?.toString()
            ?: ""
        val name = getName?.invoke(item)?.toString() ?: ""
        val enabled = (isEnabled?.invoke(item) as? Boolean) ?: false
        m.putString("packageName", pkg)
        m.putString("className", className)
        m.putString("name", name)
        m.putBoolean("isEnabled", enabled)
        m.putBoolean("isBips", isBipsPackage(pkg) || name.contains("Built-In", ignoreCase = true))
      } catch (e: Exception) {
        m.putString("name", item.toString())
        m.putString("packageName", "")
        m.putString("className", "")
        m.putBoolean("isEnabled", false)
        m.putBoolean("isBips", false)
        m.putString("parseError", e.message)
      }
      arr.pushMap(m)
    }
    return arr
  }

  private fun resolveInfosToArray(list: List<ResolveInfo>): WritableArray {
    val arr = Arguments.createArray()
    for (ri in list) {
      val si = ri.serviceInfo ?: continue
      val m = Arguments.createMap()
      m.putString("packageName", si.packageName ?: "")
      m.putString("className", si.name ?: "")
      val label =
        try {
          ri.loadLabel(reactContext.packageManager)?.toString() ?: ""
        } catch (_: Exception) {
          ""
        }
      m.putString("name", label)
      m.putBoolean("isEnabled", true)
      m.putBoolean("isBips", isBipsPackage(si.packageName))
      arr.pushMap(m)
    }
    return arr
  }

  private fun isBipsPackage(pkg: String?): Boolean =
    pkg.equals("com.android.bips", ignoreCase = true)

  private fun arrayContainsBips(arr: WritableArray): Boolean {
    for (i in 0 until arr.size()) {
      val m = arr.getMap(i) ?: continue
      if (m.getBoolean("isBips")) return true
      if (isBipsPackage(m.getString("packageName"))) return true
    }
    return false
  }

  private class ReceiptPrintDocumentAdapter : PrintDocumentAdapter() {
    private var pageWidth = 595
    private var pageHeight = 842

    override fun onLayout(
      oldAttributes: PrintAttributes?,
      newAttributes: PrintAttributes,
      cancellationSignal: CancellationSignal?,
      callback: LayoutResultCallback,
      extras: Bundle?,
    ) {
      if (cancellationSignal?.isCanceled == true) {
        callback.onLayoutCancelled()
        return
      }
      val media = newAttributes.mediaSize
      if (media != null) {
        pageWidth = media.widthMils * 72 / 1000
        pageHeight = media.heightMils * 72 / 1000
      }

      val info =
        PrintDocumentInfo.Builder("flashtap_bips_test.pdf")
          .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
          .setPageCount(1)
          .build()
      callback.onLayoutFinished(info, true)
    }

    override fun onWrite(
      pages: Array<out PageRange>?,
      destination: ParcelFileDescriptor,
      cancellationSignal: CancellationSignal?,
      callback: WriteResultCallback,
    ) {
      if (cancellationSignal?.isCanceled == true) {
        callback.onWriteCancelled()
        return
      }

      try {
        val pdf = PdfDocument()
        val pageInfo =
          PdfDocument.PageInfo.Builder(pageWidth, pageHeight, 1).create()
        val page = pdf.startPage(pageInfo)
        drawReceipt(page.canvas)
        pdf.finishPage(page)

        FileOutputStream(destination.fileDescriptor).use { out ->
          pdf.writeTo(out)
        }
        pdf.close()

        callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
      } catch (e: Exception) {
        Log.e(TAG, "onWrite failed", e)
        callback.onWriteFailed(e.message)
      }
    }

    private fun drawReceipt(canvas: Canvas) {
      val title =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
          color = Color.BLACK
          textSize = 22f
          isFakeBoldText = true
        }
      val body =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
          color = Color.BLACK
          textSize = 14f
        }
      val stamp =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss z", Locale.US).format(Date())

      var y = 48f
      fun line(text: String, paint: Paint = body) {
        canvas.drawText(text, 40f, y, paint)
        y += paint.textSize + 10f
      }

      line("FlashTap Terminal", title)
      line("SYSTEM PRINT FRAMEWORK TEST", title)
      line("(PrintManager + PrintDocumentAdapter)")
      line("--------------------------------")
      line("Path: android.print.PrintManager")
      line("NOT WiseSdk / NOT AIDL")
      line("Model: ${Build.MODEL}")
      line("Manufacturer: ${Build.MANUFACTURER}")
      line("Time: $stamp")
      line("--------------------------------")
      line("If this page exits the P5 thermal")
      line("printer, BIPS (or another service)")
      line("reaches the physical hardware.")
      line("If you only see cloud/Wi-Fi printers")
      line("in the picker, BIPS is not the POS")
      line("built-in printer bridge.")
      line("--------------------------------")
      line("Item A          N\$10.00")
      line("Item B          N\$5.00")
      line("TOTAL           N\$15.00")
      line("--------------------------------")
      line("END TEST RECEIPT")
    }
  }

  companion object {
    private const val TAG = "PrintFrameworkModule"
    /** Official PrintService binding action (BIPS registers this). */
    private const val PRINT_SERVICE_INTERFACE = "android.printservice.PrintService"
  }
}
