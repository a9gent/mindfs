package com.mindfs.app;

import android.app.DownloadManager;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.TextUtils;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

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

    @PluginMethod
    public void saveBase64(PluginCall call) {
        String dataBase64 = call.getString("dataBase64");
        String filename = sanitizeFilename(call.getString("filename"));
        String mimeType = call.getString("mimeType");

        if (TextUtils.isEmpty(dataBase64)) {
            call.reject("download content is empty");
            return;
        }
        if (TextUtils.isEmpty(filename)) {
            filename = "download";
        }
        if (TextUtils.isEmpty(mimeType)) {
            mimeType = "application/octet-stream";
        }

        try {
            byte[] data = Base64.decode(dataBase64, Base64.DEFAULT);
            String path = saveBytesToDownloads(getContext(), data, filename, mimeType);

            JSObject result = new JSObject();
            result.put("filename", filename);
            result.put("directory", Environment.DIRECTORY_DOWNLOADS);
            result.put("path", path);
            call.resolve(result);
        } catch (Exception ex) {
            call.reject("Failed to save download: " + ex.getMessage(), ex);
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
        if (filename.toLowerCase().endsWith(".apk")) {
            request.setMimeType("application/vnd.android.package-archive");
            request.setDescription("Downloading app update");
        }
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

    static String saveBytesToDownloads(Context context, byte[] data, String filename, String mimeType) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IllegalStateException("MediaStore insert returned null");
            }

            try (OutputStream output = context.getContentResolver().openOutputStream(uri)) {
                if (output == null) {
                    throw new IllegalStateException("MediaStore output stream unavailable");
                }
                output.write(data);
                output.flush();
            } catch (Exception ex) {
                context.getContentResolver().delete(uri, null, null);
                throw ex;
            }

            ContentValues done = new ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            context.getContentResolver().update(uri, done, null, null);
            return uri.toString();
        }

        File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!downloadsDir.exists() && !downloadsDir.mkdirs()) {
            throw new IllegalStateException("Downloads directory unavailable");
        }
        File outputFile = uniqueFile(downloadsDir, filename);
        try (OutputStream output = new FileOutputStream(outputFile)) {
            output.write(data);
            output.flush();
        }
        return outputFile.getAbsolutePath();
    }

    private static File uniqueFile(File directory, String filename) {
        File candidate = new File(directory, filename);
        if (!candidate.exists()) {
            return candidate;
        }
        String base = filename;
        String ext = "";
        int dot = filename.lastIndexOf('.');
        if (dot > 0) {
            base = filename.substring(0, dot);
            ext = filename.substring(dot);
        }
        int index = 1;
        do {
            candidate = new File(directory, base + " (" + index + ")" + ext);
            index += 1;
        } while (candidate.exists());
        return candidate;
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
