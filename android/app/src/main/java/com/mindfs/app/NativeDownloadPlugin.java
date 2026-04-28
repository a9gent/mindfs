package com.mindfs.app;

import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Environment;
import android.text.TextUtils;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeDownload")
public class NativeDownloadPlugin extends Plugin {
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String filename = sanitizeFilename(call.getString("filename"));

        if (TextUtils.isEmpty(url)) {
            call.reject("url is required");
            return;
        }

        if (TextUtils.isEmpty(filename)) {
            filename = sanitizeFilename(URLUtil.guessFileName(url, null, null));
        }
        if (TextUtils.isEmpty(filename)) {
            filename = "download";
        }

        DownloadManager downloadManager =
            (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (downloadManager == null) {
            call.reject("DownloadManager is unavailable");
            return;
        }

        try {
            long downloadId = enqueueDownload(downloadManager, url, filename);

            JSObject result = new JSObject();
            result.put("downloadId", downloadId);
            result.put("filename", filename);
            result.put("directory", Environment.DIRECTORY_DOWNLOADS);
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("Failed to enqueue download: " + ex.getMessage(), ex);
        }
    }

    static long enqueueDownload(DownloadManager downloadManager, String url, String filename) {
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        request.setTitle(filename);
        request.setDescription("Downloading file");
        request.setNotificationVisibility(
            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
        );
        request.setAllowedOverMetered(true);
        request.setAllowedOverRoaming(true);
        request.setVisibleInDownloadsUi(true);
        request.setDestinationInExternalPublicDir(
            Environment.DIRECTORY_DOWNLOADS,
            filename
        );
        String cookies = CookieManager.getInstance().getCookie(url);
        if (!TextUtils.isEmpty(cookies)) {
            request.addRequestHeader("Cookie", cookies);
        }

        return downloadManager.enqueue(request);
    }

    static String sanitizeFilename(String filename) {
        if (filename == null) {
            return "";
        }
        return filename
            .trim()
            .replace("\\", "_")
            .replace("/", "_")
            .replace(":", "_")
            .replace("*", "_")
            .replace("?", "_")
            .replace("\"", "_")
            .replace("<", "_")
            .replace(">", "_")
            .replace("|", "_");
    }
}
