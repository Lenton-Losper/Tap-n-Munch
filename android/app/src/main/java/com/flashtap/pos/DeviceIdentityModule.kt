package com.flashtap.pos

import android.os.Build
import android.provider.Settings
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.wisepos.smartpos.WisePosSdk

/**
 * THE READER'S OWN SERIAL NUMBER (F19).
 *
 * ==================================================================================================
 * WHAT WAS MISSING
 * ==================================================================================================
 *
 * `restaurant_terminals` has carried an `sn` column since the table was created, and
 * `app/api/terminals/activate/route.ts` already reads `sn` off the activation body and writes it.
 * Nothing ever sent one: `activateTerminal()` posted `JSON.stringify({code})` and nothing else.
 *
 * Measured on production 2026-09-19, read-only: of 274 registrations, FOUR carry an `sn` -- all
 * four from a manual seed on 2026-06-17 -- and 270 carry `sn = null`. Their `device_serial` is
 * `ft-<the row's own uuid>`, synthesised by the activation route's own fallback, so it identifies
 * the ROW and tells you nothing about the DEVICE.
 *
 * The consequence: a payment can be traced to a terminal_id, and a terminal_id cannot be traced to
 * a physical reader. When two registrations exist for one device -- which they do, see the
 * remediation plan for WPYB002452000261 -- there is no way to tell from the data which is which.
 *
 * ==================================================================================================
 * WHERE THE SERIAL COMES FROM, AND WHY NOT `Build.SERIAL`
 * ==================================================================================================
 *
 * `WisePosSdk.getInstance().device.getDeviceSn()` -- the SDK's own accessor, documented in
 * WiseSdkDoc_P_1.29 as "obtain the serial number of the device". It returns the value printed on
 * the unit (the `WPYB…` / `WPHK…` form already in the four seeded rows), needs no Android
 * permission, and is the same identity the acquirer knows the device by.
 *
 * `Build.SERIAL` is deprecated and returns the literal string "unknown" on Android 8 and above
 * without READ_PHONE_STATE, and `Build.getSerial()` throws SecurityException without it. Adding a
 * runtime permission prompt to an unattended till to obtain a value the SDK already has would be a
 * worse trade in every direction.
 *
 * ==================================================================================================
 * IT NEVER THROWS, AND AN UNKNOWN SERIAL IS NULL
 * ==================================================================================================
 *
 * Activation must not fail because a serial could not be read. The SDK is not bound on every
 * device state, `getDeviceSn` declares WisePosException, and a station tablet is not a payment
 * terminal at all -- so every failure resolves to `serial: null` with the reason attached, and the
 * caller activates without one exactly as it does today.
 *
 * A NULL SERIAL IS NEVER SUBSTITUTED FOR. `androidId` is returned ALONGSIDE it, never instead of
 * it: ANDROID_ID is per-app-install and changes on a factory reset, so writing it into a column
 * called `sn` would put a value that is not a serial where every reader expects one. The server
 * decides what to do with each; this module only reports what it found.
 */
class DeviceIdentityModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "DeviceIdentity"

    companion object {
        private const val TAG = "DeviceIdentity"

        /**
         * Values Android hands back INSTEAD of a serial when it will not give you one. Treated as
         * absent rather than stored: "unknown" written into `sn` is worse than null, because null
         * is honestly missing and "unknown" looks like a serial to every query that reads it.
         */
        private val NOT_A_SERIAL = setOf("unknown", "null", "0", "000000000000000")
    }

    private fun clean(raw: String?): String? {
        val s = raw?.trim() ?: return null
        if (s.isEmpty()) return null
        if (NOT_A_SERIAL.contains(s.lowercase())) return null
        return s
    }

    /**
     * Resolve what this device can honestly say about its own identity.
     *
     * Returns `{ serial, serialSource, androidId, model, manufacturer, reason }`. `serial` is null
     * when the SDK could not supply one, and `reason` then says why -- a diagnostic screen can show
     * it without the caller having to guess between "not a payment terminal" and "SDK not bound".
     */
    @ReactMethod
    fun getIdentity(promise: Promise) {
        val out = Arguments.createMap()
        out.putString("model", clean(Build.MODEL))
        out.putString("manufacturer", clean(Build.MANUFACTURER))

        // Per-app-install, and reported as exactly that. Never a substitute for a serial.
        val androidId =
            try {
                clean(
                    Settings.Secure.getString(
                        reactContext.contentResolver,
                        Settings.Secure.ANDROID_ID,
                    ),
                )
            } catch (e: Throwable) {
                Log.w(TAG, "ANDROID_ID unreadable", e)
                null
            }
        out.putString("androidId", androidId)

        var serial: String? = null
        var source: String? = null
        var reason: String? = null

        try {
            val device = WisePosSdk.getInstance().device
            if (device == null) {
                reason = "wisepos_device_unavailable"
            } else {
                serial = clean(device.deviceSn)
                if (serial != null) {
                    source = "wisepos_sdk"
                } else {
                    reason = "wisepos_returned_blank"
                }
            }
        } catch (e: Throwable) {
            /**
             * Throwable, not Exception. On a non-WisePOS device (a station tablet, the emulator)
             * the SDK class may fail to link at all, which surfaces as NoClassDefFoundError -- an
             * Error, not an Exception. Catching only Exception would let activation crash on
             * exactly the devices this is designed to degrade gracefully on.
             */
            Log.w(TAG, "WisePos getDeviceSn failed", e)
            reason = "wisepos_threw:" + (e.javaClass.simpleName)
        }

        out.putString("serial", serial)
        out.putString("serialSource", source)
        out.putString("reason", reason)

        // RESOLVES, ALWAYS. A rejected promise here would have to be caught at every call site,
        // and a missed catch would fail an activation over a diagnostic value.
        promise.resolve(out)
    }
}
