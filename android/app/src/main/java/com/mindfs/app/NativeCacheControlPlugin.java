package com.mindfs.app;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeCacheControl")
public class NativeCacheControlPlugin extends Plugin {
    private static final String PREFS_NAME = "mindfs_native_cache_control";
    private static final String KEY_CLEAR_WEBVIEW_CACHE_ON_NEXT_LAUNCH =
        "clear_webview_cache_on_next_launch";

    @PluginMethod
    public void markClearWebViewCacheOnNextLaunch(PluginCall call) {
        setClearWebViewCacheOnNextLaunch(true);
        JSObject result = new JSObject();
        result.put("scheduled", true);
        call.resolve(result);
    }

    @PluginMethod
    public void clearPendingWebViewCacheClear(PluginCall call) {
        setClearWebViewCacheOnNextLaunch(false);
        JSObject result = new JSObject();
        result.put("scheduled", false);
        call.resolve(result);
    }

    static boolean shouldClearWebViewCacheOnNextLaunch(Context context) {
        return prefs(context).getBoolean(KEY_CLEAR_WEBVIEW_CACHE_ON_NEXT_LAUNCH, false);
    }

    static void consumeClearWebViewCacheOnNextLaunch(Context context) {
        prefs(context)
            .edit()
            .remove(KEY_CLEAR_WEBVIEW_CACHE_ON_NEXT_LAUNCH)
            .apply();
    }

    private void setClearWebViewCacheOnNextLaunch(boolean value) {
        prefs(getContext())
            .edit()
            .putBoolean(KEY_CLEAR_WEBVIEW_CACHE_ON_NEXT_LAUNCH, value)
            .apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
