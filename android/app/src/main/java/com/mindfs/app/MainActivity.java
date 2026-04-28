package com.mindfs.app;

import android.app.DownloadManager;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.graphics.Insets;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeDownloadPlugin.class);
        registerPlugin(NativeCacheControlPlugin.class);
        registerPlugin(LauncherNodeSyncPlugin.class);
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        getBridge().getWebView().getSettings().setMixedContentMode(
            WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        );
        getBridge().getWebView().addJavascriptInterface(
            new LauncherNodeSyncBridge(),
            "MindFSLauncherNodeSync"
        );
        getBridge().getWebView().addJavascriptInterface(
            new NativeDownloadBridge(),
            "MindFSNativeDownload"
        );
        clearPendingWebViewCacheIfNeeded();
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        applySystemBarStyle();
        installEdgeToEdgeInsetsOverride();
        fixWebViewMargin();
    }

    @Override
    public void onResume() {
        super.onResume();
        applySystemBarStyle();
        installEdgeToEdgeInsetsOverride();
        fixWebViewMargin();
    }

    @Override
    public void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applySystemBarStyle();
        notifyThemeChanged();
    }

    private void applySystemBarStyle() {
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }
        boolean darkMode =
            (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (controller != null) {
            controller.setAppearanceLightStatusBars(!darkMode);
            controller.setAppearanceLightNavigationBars(false);
        }
    }

    private void fixWebViewMargin() {
        View webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }

        View parent = (View) webView.getParent();
        if (parent != null) {
            parent.setPadding(0, 0, 0, 0);
        }

        ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
        if (params != null) {
            params.topMargin = 0;
            params.bottomMargin = 0;
            params.leftMargin = 0;
            params.rightMargin = 0;
            webView.setLayoutParams(params);
        }

        webView.post(() -> {
            ViewCompat.requestApplyInsets(webView);
        });
    }

    private void installEdgeToEdgeInsetsOverride() {
        View webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }

        View parent = (View) webView.getParent();
        if (parent == null) {
            return;
        }

        ViewCompat.setOnApplyWindowInsetsListener(parent, (view, insets) -> {
            Insets systemInsets = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime());
            int imeBottom = insets.isVisible(WindowInsetsCompat.Type.ime()) ? imeInsets.bottom : 0;
            view.setPadding(0, 0, 0, 0);
            webView.setPadding(0, 0, 0, 0);
            injectSafeAreaInsets(systemInsets.top, systemInsets.bottom, imeBottom);
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout(), androidx.core.graphics.Insets.NONE)
                .build();
        });

        parent.post(() -> ViewCompat.requestApplyInsets(parent));
    }

    private void injectSafeAreaInsets(int topPx, int bottomPx, int imeBottomPx) {
        View webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }

        float density = getResources().getDisplayMetrics().density;
        float topDp = topPx / density;
        float bottomDp = bottomPx / density;
        float imeBottomDp = imeBottomPx / density;
        String script = String.format(
            java.util.Locale.US,
            "(function(){if(!document||!document.documentElement||!document.documentElement.style){return;}document.documentElement.style.setProperty('--mindfs-safe-area-top','%.2fpx');document.documentElement.style.setProperty('--mindfs-safe-area-bottom','%.2fpx');document.documentElement.style.setProperty('--mindfs-ime-bottom','%.2fpx');window.dispatchEvent(new CustomEvent('mindfs:safe-area-updated'));})();",
            topDp,
            bottomDp,
            imeBottomDp
        );
        ((WebView) webView).evaluateJavascript(script, null);
    }

    private void notifyThemeChanged() {
        View webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }
        ((WebView) webView).evaluateJavascript(
            "(function(){if(!window){return;}window.dispatchEvent(new CustomEvent('mindfs:native-theme-changed'));})();",
            null
        );
    }

    private void clearPendingWebViewCacheIfNeeded() {
        if (!NativeCacheControlPlugin.shouldClearWebViewCacheOnNextLaunch(this)) {
            return;
        }
        try {
            View webView = getBridge().getWebView();
            if (webView instanceof WebView) {
                ((WebView) webView).clearCache(true);
            }
        } finally {
            NativeCacheControlPlugin.consumeClearWebViewCacheOnNextLaunch(this);
        }
    }

    private class LauncherNodeSyncBridge {
        @JavascriptInterface
        public void storeRelayNodes(String rawJSON) {
            LauncherNodeSyncPlugin.storeRelayNodesJSON(MainActivity.this, rawJSON);
        }
    }

    private class NativeDownloadBridge {
        @JavascriptInterface
        public String download(String url, String filename) {
            try {
                DownloadManager downloadManager =
                    (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (downloadManager == null) {
                    return "DownloadManager is unavailable";
                }
                String safeFilename = NativeDownloadPlugin.sanitizeFilename(filename);
                if (safeFilename.isEmpty()) {
                    safeFilename = NativeDownloadPlugin.sanitizeFilename(
                        android.webkit.URLUtil.guessFileName(url, null, null)
                    );
                }
                if (safeFilename.isEmpty()) {
                    safeFilename = "download";
                }
                NativeDownloadPlugin.enqueueDownload(downloadManager, url, safeFilename);
                return "";
            } catch (Exception ex) {
                return "Failed to enqueue download: " + ex.getMessage();
            }
        }
    }
}
