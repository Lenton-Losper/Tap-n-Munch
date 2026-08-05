package com.flashtap.pos

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class PaymentPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(
      PaymentModule(reactContext),
      RuntimeConfigModule(reactContext),
      PrinterModule(reactContext),
      // SDK4 is the transport that actually resolves on our P5 units. SDK6 stays registered
      // only through the verification window; delete it once SDK4 has printed on a real
      // device, so a future printer bug never starts with "which path did this take".
      WiseSdk4PrinterModule(reactContext),
      WiseSdk6PrinterModule(reactContext),
      PrintFrameworkModule(reactContext),
    )

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
