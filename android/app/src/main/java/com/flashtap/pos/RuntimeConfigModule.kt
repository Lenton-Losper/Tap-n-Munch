package com.flashtap.pos

import com.flashtapterminal.BuildConfig
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule

class RuntimeConfigModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "RuntimeConfig"

    override fun getConstants(): Map<String, Any> = mapOf(
        "API_BASE_URL" to BuildConfig.API_BASE_URL,
        "SUPABASE_URL" to BuildConfig.SUPABASE_URL,
        "SUPABASE_ANON_KEY" to BuildConfig.SUPABASE_ANON_KEY,
        "ENV_NAME" to BuildConfig.ENV_NAME,
        "NOTIFY_URL" to BuildConfig.NOTIFY_URL,
        "PAYCLOUD_APP_ID" to BuildConfig.PAYCLOUD_APP_ID,
    )
}
