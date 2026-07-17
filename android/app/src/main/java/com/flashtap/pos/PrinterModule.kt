package com.flashtap.pos

import android.util.Base64
import android.util.Log
import com.dantsu.escposprinter.connection.bluetooth.BluetoothConnection
import com.dantsu.escposprinter.connection.bluetooth.BluetoothPrintersConnections
import com.dantsu.escposprinter.exceptions.EscPosConnectionException
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray

/**
 * Transport-only bridge to a paired Bluetooth ESC/POS printer. Deliberately knows nothing
 * about receipt content, VAT, or line formatting -- printEscPos() just writes bytes that were
 * already rendered server-side (lib/receipts/renderers/escposRenderer.ts). Paired-device
 * lookup only; this module never scans for new devices.
 */
class PrinterModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "PrinterModule"

  private var activeConnection: BluetoothConnection? = null
  private var activePrinterId: String? = null

  private fun pairedConnections(): Array<BluetoothConnection> =
    BluetoothPrintersConnections().list ?: emptyArray()

  @ReactMethod
  fun getPrinters(promise: Promise) {
    try {
      val result: WritableArray = Arguments.createArray()
      for (connection in pairedConnections()) {
        val device = connection.device ?: continue
        val map = Arguments.createMap()
        map.putString("id", device.address)
        map.putString("name", device.name ?: device.address)
        result.pushMap(map)
      }
      promise.resolve(result)
    } catch (e: SecurityException) {
      promise.reject("BLUETOOTH_PERMISSION_DENIED", e.message, e)
    } catch (e: Exception) {
      promise.reject("BLUETOOTH_UNAVAILABLE", e.message, e)
    }
  }

  @ReactMethod
  fun connect(printerId: String, promise: Promise) {
    try {
      val match = pairedConnections().firstOrNull { it.device?.address == printerId }
      if (match == null) {
        promise.reject("PRINTER_NOT_FOUND", "No paired printer with id $printerId")
        return
      }

      activeConnection?.disconnect()
      match.connect()
      activeConnection = match
      activePrinterId = printerId

      Log.d("PrinterModule", "Connected to printer $printerId")

      val result = Arguments.createMap()
      result.putBoolean("connected", true)
      result.putString("id", printerId)
      promise.resolve(result)
    } catch (e: EscPosConnectionException) {
      activeConnection = null
      activePrinterId = null
      promise.reject("CONNECT_FAILED", e.message, e)
    } catch (e: SecurityException) {
      activeConnection = null
      activePrinterId = null
      promise.reject("BLUETOOTH_PERMISSION_DENIED", e.message, e)
    }
  }

  @ReactMethod
  fun printEscPos(payloadBase64: String, promise: Promise) {
    val connection = activeConnection
    if (connection == null || !connection.isConnected) {
      promise.reject("NOT_CONNECTED", "No connected printer -- call connect() first")
      return
    }

    try {
      val bytes = Base64.decode(payloadBase64, Base64.NO_WRAP)
      connection.write(bytes)
      connection.send()
      promise.resolve(true)
    } catch (e: EscPosConnectionException) {
      promise.reject("PRINT_FAILED", e.message, e)
    } catch (e: IllegalArgumentException) {
      promise.reject("INVALID_PAYLOAD", "payload is not valid base64", e)
    }
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    val result = Arguments.createMap()
    result.putBoolean("connected", activeConnection?.isConnected == true)
    val id = activePrinterId
    if (id != null) {
      result.putString("id", id)
    } else {
      result.putNull("id")
    }
    promise.resolve(result)
  }
}
