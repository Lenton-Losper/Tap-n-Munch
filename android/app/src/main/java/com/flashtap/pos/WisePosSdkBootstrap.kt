package com.flashtap.pos

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import com.wisedevice.sdk.IInitDeviceSdkListener
import com.wisedevice.sdk.WiseDeviceSdk
import com.wisepos.smartpos.InitPosSdkListener
import com.wisepos.smartpos.WisePosSdk
import com.wisepos.smartpos.printer.Printer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Eager WisePos / WiseDevice SDK bind — mirrors SDKDemo MainActivity.onCreate().
 *
 * WisePosSdk.initPosSdk resolves action [USDK_ACTION] via queryIntentServices and
 * requires **exactly one** match. 0 or 2+ matches → error 7101.
 */
object WisePosSdkBootstrap {
  private const val TAG = "WisePosSdkBootstrap"
  const val USDK_ACTION = "com.wisepos.aidl.service"

  private val posReady = AtomicBoolean(false)
  private val everBound = AtomicBoolean(false)
  private val posInitStarted = AtomicBoolean(false)
  private val deviceInitStarted = AtomicBoolean(false)
  private val waiters = CopyOnWriteArrayList<(Boolean, Int?) -> Unit>()

  fun isPosReady(): Boolean = posReady.get()

  data class ServiceProbe(
    val action: String,
    val matchCount: Int,
    val components: List<String>,
    val model: String,
    val sdkInt: Int,
  ) {
    fun summary(): String {
      val comps =
        if (components.isEmpty()) "none"
        else components.joinToString("; ")
      return "model=$model sdk=$sdkInt action=$action matches=$matchCount [$comps]"
    }
  }

  /** Mirrors WisePosSdk.getExplicitIntent visibility — what the OS can see for the USDK action. */
  fun probeUsdkService(context: Context): ServiceProbe {
    val pm = context.packageManager
    val intent = Intent(USDK_ACTION)
    // flags=0 is what WisePosSdk uses; also try MATCH_ALL for diagnostics on newer Android.
    val withDefault =
      try {
        @Suppress("DEPRECATION")
        pm.queryIntentServices(intent, 0) ?: emptyList()
      } catch (e: Exception) {
        Log.e(TAG, "queryIntentServices(0) failed", e)
        emptyList()
      }
    val withMatchAll =
      try {
        @Suppress("DEPRECATION")
        pm.queryIntentServices(intent, PackageManager.MATCH_ALL) ?: emptyList()
      } catch (e: Exception) {
        Log.e(TAG, "queryIntentServices(MATCH_ALL) failed", e)
        emptyList()
      }
    val resolved = if (withDefault.isNotEmpty()) withDefault else withMatchAll
    val components =
      resolved.mapNotNull { info ->
        val si = info.serviceInfo ?: return@mapNotNull null
        "${si.packageName}/${si.name}"
      }
    val queryAll =
      pm.checkPermission(
        "android.permission.QUERY_ALL_PACKAGES",
        context.packageName,
      ) == PackageManager.PERMISSION_GRANTED
    Log.i(
      TAG,
      "USDK probe: default=${withDefault.size} matchAll=${withMatchAll.size} " +
        "queryAll=$queryAll targetSdk=${context.applicationInfo.targetSdkVersion} " +
        "components=$components",
    )
    return ServiceProbe(
      action = USDK_ACTION,
      matchCount = components.size,
      components = components,
      model = Build.MODEL ?: "?",
      sdkInt = Build.VERSION.SDK_INT,
    )
  }

  fun start(activity: Activity) {
    // SDKDemo MainActivity.onCreate order: initPosSdk(this) THEN initDeviceSdk(this).
    if (posReady.get()) {
      Log.d(TAG, "already ready — skip initPosSdk")
    } else {
      startPosSdk(activity, force = false)
    }
    startDeviceSdk(activity)
  }

  private fun peekPrinter(): Printer? {
    return try {
      WisePosSdk.getInstance().getPrinter()
    } catch (e: Exception) {
      Log.w(TAG, "peekPrinter failed: ${e.message}")
      null
    }
  }

  private fun startDeviceSdk(activity: Activity) {
    if (!deviceInitStarted.compareAndSet(false, true)) return
    try {
      WiseDeviceSdk.getInstance().initDeviceSdk(
        activity,
        object : IInitDeviceSdkListener {
          override fun onInitPosSuccess() {
            Log.i(TAG, "WiseDeviceSdk init success")
          }

          override fun onInitPosFail(errorCode: Int) {
            Log.w(TAG, "WiseDeviceSdk init fail code=$errorCode")
            deviceInitStarted.set(false)
          }
        },
      )
    } catch (e: Exception) {
      Log.e(TAG, "WiseDeviceSdk init threw", e)
      deviceInitStarted.set(false)
    }
  }

  private fun startPosSdk(activity: Activity, force: Boolean) {
    if (!force && posReady.get()) {
      flushWaiters(true, null)
      return
    }
    if (!posInitStarted.compareAndSet(false, true)) {
      Log.d(TAG, "initPosSdk already in flight")
      return
    }
    val probe = probeUsdkService(activity)
    Log.i(TAG, "pre-init probe: ${probe.summary()}")
    try {
      Log.i(
        TAG,
        "WisePosSdk.initPosSdk starting force=$force everBound=${everBound.get()} " +
          "(Activity=${activity.javaClass.simpleName})",
      )
      WisePosSdk.getInstance().initPosSdk(
        activity,
        object : InitPosSdkListener {
          override fun onInitPosSuccess() {
            Log.i(TAG, "WisePosSdk init success")
            everBound.set(true)
            posReady.set(true)
            posInitStarted.set(false)
            flushWaiters(true, null)
          }

          override fun onInitPosFail(errorCode: Int) {
            Log.w(
              TAG,
              "WisePosSdk init fail code=$errorCode (0x${Integer.toHexString(errorCode)}) " +
                "probe=${probe.summary()}",
            )
            posInitStarted.set(false)
            if (everBound.get() && !force) {
              Log.i(TAG, "initPosSdk fail but previously bound — keeping ready")
              posReady.set(true)
              flushWaiters(true, null)
            } else {
              posReady.set(false)
              flushWaiters(false, errorCode)
            }
          }
        },
      )
    } catch (e: Exception) {
      Log.e(TAG, "WisePosSdk init threw", e)
      posInitStarted.set(false)
      if (everBound.get() && !force) {
        posReady.set(true)
        flushWaiters(true, null)
      } else {
        posReady.set(false)
        flushWaiters(false, null)
      }
    }
  }

  private fun describeInitFailure(context: Context, errorCode: Int?): String {
    val probe = probeUsdkService(context)
    return when {
      errorCode == 7101 && probe.matchCount == 0 ->
        "No app on this terminal provides $USDK_ACTION (matches=0, model=${probe.model}, " +
          "targetSdk=${context.applicationInfo.targetSdkVersion}). " +
          "If the SDK demo prints on this same device, FlashTap's Android visibility is wrong."
      errorCode == 7101 && probe.matchCount != 1 ->
        "WisePos SDK needs exactly 1 provider of $USDK_ACTION but found " +
          "${probe.matchCount}: ${probe.components.joinToString()}. (${probe.summary()})"
      errorCode == 7101 ->
        "Cannot bind WisePos printer service (code 7101). ${probe.summary()}"
      errorCode == 7102 || errorCode == 7103 ->
        "Printer service not connected (code $errorCode). ${probe.summary()}"
      errorCode != null ->
        "Failed to initialize printer (code $errorCode / 0x${Integer.toHexString(errorCode)}). " +
          probe.summary()
      else -> "Failed to initialize the built-in printer. ${probe.summary()}"
    }
  }

  fun resolvePrinter(
    activity: Activity?,
    onResult: (printer: Printer?, errorCode: String?, errorMessage: String?) -> Unit,
  ) {
    if (posReady.get()) {
      val printer = peekPrinter()
      if (printer != null) {
        onResult(printer, null, null)
        return
      }
      Log.w(TAG, "posReady but getPrinter() null — forcing rebind")
      posReady.set(false)
    }

    if (activity == null) {
      onResult(
        null,
        "SDK_INIT_FAILED",
        "No Activity to bind printer SDK — keep FlashTap in the foreground and try again",
      )
      return
    }

    waiters.add { ready, errorCode ->
      if (!ready) {
        val detail = describeInitFailure(activity, errorCode)
        val code =
          when (errorCode) {
            7102, 7103 -> "SDK_NOT_CONNECTED"
            else -> "SDK_INIT_FAILED"
          }
        onResult(null, code, detail)
        return@add
      }
      val printer = peekPrinter()
      if (printer == null) {
        onResult(null, "UNAVAILABLE", "SDK init succeeded but getPrinter() returned null")
      } else {
        onResult(printer, null, null)
      }
    }

    // SDKDemo MainActivity.onCreate order: initPosSdk THEN initDeviceSdk.
    startPosSdk(activity, force = false)
    startDeviceSdk(activity)
  }

  fun forceReconnect(
    activity: Activity?,
    onResult: (printer: Printer?, errorCode: String?, errorMessage: String?) -> Unit,
  ) {
    Log.w(TAG, "forceReconnect")
    posReady.set(false)
    posInitStarted.set(false)

    if (activity == null) {
      onResult(
        null,
        "SDK_NOT_CONNECTED",
        "Printer service disconnected and no Activity to rebind",
      )
      return
    }

    waiters.add { ready, errorCode ->
      if (!ready) {
        onResult(null, "SDK_INIT_FAILED", describeInitFailure(activity, errorCode))
        return@add
      }
      val printer = peekPrinter()
      if (printer == null) {
        onResult(null, "UNAVAILABLE", "Reconnect succeeded but getPrinter() returned null")
      } else {
        onResult(printer, null, null)
      }
    }

    // SDKDemo MainActivity.onCreate order: initPosSdk THEN initDeviceSdk.
    startPosSdk(activity, force = true)
    startDeviceSdk(activity)
  }

  fun getPrinter(): Printer? = peekPrinter()

  fun invalidate(reason: String) {
    Log.w(TAG, "invalidate ($reason)")
    posReady.set(false)
    everBound.set(false)
  }

  private fun flushWaiters(ready: Boolean, errorCode: Int?) {
    val copy = waiters.toList()
    waiters.clear()
    copy.forEach { it(ready, errorCode) }
  }
}
