package com.mindfs.app;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MindfsMarginDebug";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeDownloadPlugin.class);
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        fixWebViewMargin();
    }

    @Override
    public void onResume() {
        super.onResume();
        fixWebViewMargin();
    }

    private void fixWebViewMargin() {
        View webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }

        ViewCompat.setOnApplyWindowInsetsListener(webView, (v, insets) -> {
            androidx.core.graphics.Insets systemBars = insets.getInsets(
                WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.displayCutout()
            );
            
            ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            if (params != null) {
                // 不再叠加 tappableElement 等区域，直接使用最基本的状态栏高度
                params.topMargin = systemBars.top;
                
                int safeBottom = systemBars.bottom > 0 ? systemBars.bottom : 48;
                params.bottomMargin = safeBottom;
                params.leftMargin = systemBars.left;
                params.rightMargin = systemBars.right;
                v.setLayoutParams(params);
            }
            return insets;
        });

        webView.post(() -> {
            ViewCompat.requestApplyInsets(webView);
        });
    }
}
