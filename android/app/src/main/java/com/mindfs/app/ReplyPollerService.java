package com.mindfs.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.text.TextUtils;
import android.util.Base64;
import android.util.Log;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONArray;
import org.json.JSONObject;

public class ReplyPollerService extends Service {
    static final String ACTION_CONFIGURE = "com.mindfs.app.reply_poller.CONFIGURE";
    static final String ACTION_RESUME = "com.mindfs.app.reply_poller.RESUME";
    static final String ACTION_PAUSE = "com.mindfs.app.reply_poller.PAUSE";
    static final String ACTION_CLEAR_COMPLETED = "com.mindfs.app.reply_poller.CLEAR_COMPLETED";
    static final String ACTION_STOP = "com.mindfs.app.reply_poller.STOP";
    static final String EXTRA_API_BASE_URL = "apiBaseUrl";
    static final String EXTRA_TOKEN = "token";
    static final String EXTRA_E2EE_REQUIRED = "e2eeRequired";
    static final String EXTRA_E2EE_NODE_ID = "e2eeNodeId";
    static final String EXTRA_E2EE_CLIENT_ID = "e2eeClientId";
    static final String EXTRA_E2EE_TRANSPORT_KEY = "e2eeTransportKey";

    private static final String TAG = "MindFSReplyPoller";
    private static final String PREFS_NAME = "mindfs_reply_poller";
    private static final String PREF_API_BASE_URL = "api_base_url";
    private static final String PREF_TOKEN = "token";
    private static final String PREF_E2EE_REQUIRED = "e2ee_required";
    private static final String PREF_E2EE_NODE_ID = "e2ee_node_id";
    private static final String PREF_E2EE_CLIENT_ID = "e2ee_client_id";
    private static final String PREF_E2EE_TRANSPORT_KEY = "e2ee_transport_key";
    private static final String PREF_COMPLETED_KEYS = "completed_keys";
    private static final String E2EE_HEADER = "X-MindFS-E2EE";
    private static final String CLIENT_ID_HEADER = "X-MindFS-Client-ID";
    private static final String PROOF_HEADER = "X-MindFS-Proof";
    private static final String TS_HEADER = "X-MindFS-TS";
    private static final String PROGRESS_CHANNEL_ID = "mindfs_reply_progress_v1";
    private static final String VISIBLE_PROGRESS_CHANNEL_ID = "mindfs_reply_progress_visible_v1";
    private static final String ALERT_CHANNEL_ID = "mindfs_reply_alert_v3";
    private static final String REPLY_GROUP_KEY = "com.mindfs.app.REPLY_NOTIFICATIONS";
    private static final int FOREGROUND_ID = 750001;
    private static final int NOTIFICATION_BASE_ID = 760000;
    private static final long ACTIVE_POLL_INTERVAL_SECONDS = 5;
    private static final long IDLE_POLL_INTERVAL_SECONDS = 15;
    private static final long[] ALERT_VIBRATION_PATTERN = new long[] {0, 160, 110, 160};

    private final Map<String, ReplyState> states = new HashMap<>();
    private final Map<Integer, String> notificationSignatures = new HashMap<>();
    private NotificationManager notificationManager;
    private ScheduledExecutorService executor;
    private ScheduledFuture<?> pollingTask;
    private volatile boolean running = false;
    private String apiBaseUrl = "";
    private String token = "";
    private boolean e2eeRequired = false;
    private String e2eeNodeId = "";
    private String e2eeClientId = "";
    private String e2eeTransportKey = "";
    private NotificationMode notificationMode = NotificationMode.NONE;
    private static SSLSocketFactory localTrustAllSocketFactory;

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        executor = Executors.newSingleThreadScheduledExecutor();
        createChannels();
        loadConfig();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        if (ACTION_CONFIGURE.equals(action)) {
            configure(intent);
            return START_NOT_STICKY;
        }
        if (ACTION_RESUME.equals(action)) {
            resumePolling();
            return START_STICKY;
        }
        if (ACTION_PAUSE.equals(action)) {
            pausePolling();
            return START_NOT_STICKY;
        }
        if (ACTION_CLEAR_COMPLETED.equals(action)) {
            clearCompleted();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            stopAll();
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopPollingTask();
        if (executor != null) {
            executor.shutdownNow();
        }
        super.onDestroy();
    }

    private void configure(Intent intent) {
        String nextApiBaseUrl = safe(intent.getStringExtra(EXTRA_API_BASE_URL)).replaceAll("/+$", "");
        if (isLocalShellOrigin(nextApiBaseUrl)) {
            Log.w(TAG, "ignore local shell apiBaseUrl=" + nextApiBaseUrl);
            nextApiBaseUrl = apiBaseUrl;
        }
        SharedPreferences.Editor editor = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit();
        if (!nextApiBaseUrl.isEmpty()) {
            apiBaseUrl = nextApiBaseUrl;
            editor.putString(PREF_API_BASE_URL, apiBaseUrl);
        }
        if (intent.hasExtra(EXTRA_TOKEN)) {
            token = safe(intent.getStringExtra(EXTRA_TOKEN));
            editor.putString(PREF_TOKEN, token);
        }
        if (intent.hasExtra(EXTRA_E2EE_REQUIRED)) {
            e2eeRequired = intent.getBooleanExtra(EXTRA_E2EE_REQUIRED, false);
            editor.putBoolean(PREF_E2EE_REQUIRED, e2eeRequired);
        }
        if (intent.hasExtra(EXTRA_E2EE_NODE_ID)) {
            e2eeNodeId = safe(intent.getStringExtra(EXTRA_E2EE_NODE_ID));
            editor.putString(PREF_E2EE_NODE_ID, e2eeNodeId);
        }
        if (intent.hasExtra(EXTRA_E2EE_CLIENT_ID)) {
            e2eeClientId = safe(intent.getStringExtra(EXTRA_E2EE_CLIENT_ID));
            editor.putString(PREF_E2EE_CLIENT_ID, e2eeClientId);
        }
        if (intent.hasExtra(EXTRA_E2EE_TRANSPORT_KEY)) {
            e2eeTransportKey = safe(intent.getStringExtra(EXTRA_E2EE_TRANSPORT_KEY));
            editor.putString(PREF_E2EE_TRANSPORT_KEY, e2eeTransportKey);
        }
        editor.apply();
        Log.i(TAG, "configured apiBaseUrl=" + apiBaseUrl + " e2eeRequired=" + e2eeRequired + " e2eeReady=" + hasE2EESession());
    }

    private void loadConfig() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        apiBaseUrl = safe(prefs.getString(PREF_API_BASE_URL, ""));
        token = safe(prefs.getString(PREF_TOKEN, ""));
        e2eeRequired = prefs.getBoolean(PREF_E2EE_REQUIRED, false);
        e2eeNodeId = safe(prefs.getString(PREF_E2EE_NODE_ID, ""));
        e2eeClientId = safe(prefs.getString(PREF_E2EE_CLIENT_ID, ""));
        e2eeTransportKey = safe(prefs.getString(PREF_E2EE_TRANSPORT_KEY, ""));
    }

    private boolean isLocalShellOrigin(String value) {
        if (value == null || value.trim().isEmpty()) {
            return false;
        }
        try {
            URL url = new URL(value);
            String protocol = safe(url.getProtocol());
            String host = safe(url.getHost());
            return "http".equalsIgnoreCase(protocol) &&
                ("localhost".equalsIgnoreCase(host) || "127.0.0.1".equals(host) || "::1".equals(host));
        } catch (Exception ignored) {
            return false;
        }
    }

    private void resumePolling() {
        loadConfig();
        if (apiBaseUrl.isEmpty()) {
            Log.w(TAG, "skip resume: apiBaseUrl is empty");
            stopSelf();
            return;
        }
        Log.i(TAG, "resume polling apiBaseUrl=" + apiBaseUrl);
        running = true;
        startForegroundCompat(FOREGROUND_ID, buildReplyPlaceholderNotification());
        scheduleNextPoll(0);
    }

    private void pausePolling() {
        Log.i(TAG, "pause polling");
        running = false;
        stopPollingTask();
        stopForegroundCompat();
        stopSelf();
    }

    private void stopAll() {
        running = false;
        stopPollingTask();
        for (ReplyState state : states.values()) {
            notificationManager.cancel(state.notificationId);
        }
        for (String sessionKey : getCompletedKeys()) {
            notificationManager.cancel(notificationIdFor(sessionKey));
        }
        notificationManager.cancel(FOREGROUND_ID);
        notificationSignatures.clear();
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().remove(PREF_COMPLETED_KEYS).apply();
        states.clear();
        notificationMode = NotificationMode.NONE;
        stopForegroundCompat();
        stopSelf();
    }

    private void stopPollingTask() {
        if (pollingTask != null) {
            pollingTask.cancel(true);
            pollingTask = null;
        }
    }

    private void pollOnceSafely() {
        if (!running) {
            return;
        }
        long nextDelaySeconds = IDLE_POLL_INTERVAL_SECONDS;
        try {
            nextDelaySeconds = applyReplyingSessions(fetchReplyingSessions());
        } catch (Exception ex) {
            Log.w(TAG, "poll failed", ex);
            nextDelaySeconds = IDLE_POLL_INTERVAL_SECONDS;
        } finally {
            scheduleNextPoll(nextDelaySeconds);
        }
    }

    private void scheduleNextPoll(long delaySeconds) {
        if (!running || executor == null || executor.isShutdown()) {
            return;
        }
        if (pollingTask != null && !pollingTask.isDone() && !pollingTask.isCancelled()) {
            pollingTask.cancel(false);
        }
        pollingTask = executor.schedule(this::pollOnceSafely, delaySeconds, TimeUnit.SECONDS);
    }

    private Map<String, ReplyState> fetchReplyingSessions() throws Exception {
        URL url = new URL(apiBaseUrl + "/api/replying-sessions");
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        if (conn instanceof HttpsURLConnection && MainActivity.isLocalNetworkHost(url.getHost())) {
            HttpsURLConnection https = (HttpsURLConnection) conn;
            https.setSSLSocketFactory(localTrustAllSocketFactory());
            https.setHostnameVerifier(new HostnameVerifier() {
                @Override
                public boolean verify(String hostname, SSLSession session) {
                    return MainActivity.isLocalNetworkHost(hostname);
                }
            });
        }
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(8000);
        conn.setRequestProperty("Accept", "application/json");
        if (!token.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }
        if (e2eeRequired) {
            if (!hasE2EESession()) {
                conn.disconnect();
                throw new IllegalStateException("e2ee session missing");
            }
            conn.setRequestProperty(E2EE_HEADER, "1");
            conn.setRequestProperty(CLIENT_ID_HEADER, e2eeClientId);
            addRequestProofHeaders(conn, "GET", url);
        }
        int status = conn.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();
        String body = readAll(stream);
        boolean protectedResponse = "1".equals(safe(conn.getHeaderField(E2EE_HEADER)));
        conn.disconnect();
        if (status < 200 || status >= 300) {
            if (status == 401 && e2eeRequired) {
                clearE2EESession();
            }
            throw new IllegalStateException("HTTP " + status + ": " + body);
        }
        if (protectedResponse) {
            body = decryptProtectedBody(body);
        }

        JSONObject root = new JSONObject(body);
        JSONArray sessions = root.optJSONArray("sessions");
        Map<String, ReplyState> next = new HashMap<>();
        if (sessions == null) {
            return next;
        }
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject item = sessions.optJSONObject(i);
            if (item == null) {
                continue;
            }
            String sessionKey = safe(item.optString("sessionKey", ""));
            if (sessionKey.isEmpty()) {
                continue;
            }
            ReplyState state = new ReplyState(sessionKey);
            state.rootId = safe(item.optString("rootId", ""));
            state.rootTitle = safe(item.optString("rootTitle", ""));
            state.sessionTitle = safe(item.optString("sessionTitle", ""));
            state.summary = safe(item.optString("summary", ""));
            state.updatedAt = safe(item.optString("updatedAt", ""));
            state.status = ReplyStatus.REPLYING;
            Log.i(TAG, "fetched session=" + sessionKey + " summaryLength=" + state.summary.length());
            next.put(sessionKey, state);
        }
        return next;
    }

    private boolean hasE2EESession() {
        return !e2eeClientId.isEmpty() && !e2eeTransportKey.isEmpty();
    }

    private void clearE2EESession() {
        e2eeClientId = "";
        e2eeTransportKey = "";
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .remove(PREF_E2EE_CLIENT_ID)
            .remove(PREF_E2EE_TRANSPORT_KEY)
            .apply();
    }

    private String decryptProtectedBody(String body) throws Exception {
        if (!hasE2EESession()) {
            throw new IllegalStateException("e2ee session missing");
        }
        JSONObject envelope = new JSONObject(body);
        byte[] key = Base64.decode(e2eeTransportKey, Base64.DEFAULT);
        byte[] nonce = Base64.decode(envelope.optString("nonce", ""), Base64.DEFAULT);
        byte[] ciphertext = Base64.decode(envelope.optString("ciphertext", ""), Base64.DEFAULT);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
        byte[] plaintext = cipher.doFinal(ciphertext);
        return new String(plaintext, StandardCharsets.UTF_8);
    }

    private void addRequestProofHeaders(HttpURLConnection conn, String method, URL url) throws Exception {
        String ts = utcTimestamp();
        String proofPath = requestProofPath(url);
        byte[] key = Base64.decode(e2eeTransportKey, Base64.DEFAULT);
        String proof = buildRequestProof(key, method, proofPath, ts, e2eeClientId);
        conn.setRequestProperty(TS_HEADER, ts);
        conn.setRequestProperty(PROOF_HEADER, proof);
    }

    private static String utcTimestamp() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private static String requestProofPath(URL url) {
        String path = safe(url == null ? "" : url.getPath());
        if (path.isEmpty()) {
            path = "/";
        }
        path = path.replaceFirst("^/n/[^/]+", "");
        if (path.isEmpty()) {
            path = "/";
        }
        String query = url == null ? "" : safe(url.getQuery());
        return query.isEmpty() ? path : path + "?" + query;
    }

    private static String buildRequestProof(byte[] key, String method, String path, String ts, String clientId) throws Exception {
        String joined = "mindfs-request-proof\u001f" + method + "\u001f" + path + "\u001f" + ts + "\u001f" + clientId;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] sum = digest.digest(joined.getBytes(StandardCharsets.UTF_8));
        Mac hmac = Mac.getInstance("HmacSHA256");
        hmac.init(new SecretKeySpec(key, "HmacSHA256"));
        return Base64.encodeToString(hmac.doFinal(sum), Base64.NO_WRAP);
    }

    private static synchronized SSLSocketFactory localTrustAllSocketFactory() throws Exception {
        if (localTrustAllSocketFactory != null) {
            return localTrustAllSocketFactory;
        }
        TrustManager[] trustManagers = new TrustManager[] {
            new X509TrustManager() {
                @Override
                public void checkClientTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public void checkServerTrusted(X509Certificate[] chain, String authType) {}

                @Override
                public X509Certificate[] getAcceptedIssuers() {
                    return new X509Certificate[0];
                }
            },
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trustManagers, new SecureRandom());
        localTrustAllSocketFactory = context.getSocketFactory();
        return localTrustAllSocketFactory;
    }

    private long applyReplyingSessions(Map<String, ReplyState> next) {
        Log.i(TAG, "poll success sessions=" + next.size());
        Set<String> currentKeys = new HashSet<>(next.keySet());
        for (ReplyState incoming : next.values()) {
            ReplyState state = states.get(incoming.sessionKey);
            if (state == null) {
                state = incoming;
                states.put(state.sessionKey, state);
            } else {
                boolean wasCompleted = state.status == ReplyStatus.COMPLETED;
                state.rootId = incoming.rootId;
                state.rootTitle = incoming.rootTitle;
                state.sessionTitle = incoming.sessionTitle;
                if (wasCompleted || !incoming.summary.isEmpty()) {
                    state.summary = incoming.summary;
                }
                state.updatedAt = incoming.updatedAt;
                state.status = ReplyStatus.REPLYING;
            }
            removeCompletedKey(state.sessionKey);
        }

        for (ReplyState state : states.values()) {
            if (state.status == ReplyStatus.REPLYING && !currentKeys.contains(state.sessionKey)) {
                state.status = ReplyStatus.COMPLETED;
                addCompletedKey(state.sessionKey);
                vibrateReplyCompletion();
            }
        }

        List<ReplyState> visibleStates = visibleStates();
        if (currentKeys.isEmpty()) {
            if (!visibleStates.isEmpty()) {
                showReplyNotifications(visibleStates);
                stopForegroundDetachCompat();
            } else {
                stopForegroundCompat();
            }
            return IDLE_POLL_INTERVAL_SECONDS;
        } else {
            showReplyNotifications(visibleStates);
            return ACTIVE_POLL_INTERVAL_SECONDS;
        }
    }

    private void showReplyNotifications(List<ReplyState> states) {
        if (states == null || states.isEmpty()) {
            return;
        }
        sortMostRecentFirst(states);
        if (states.size() == 1) {
            showSingleReplyNotification(states.get(0));
            return;
        }
        boolean hasReplying = hasReplyingState(states);
        if (notificationMode != NotificationMode.GROUP) {
            notificationManager.cancel(FOREGROUND_ID);
            notificationSignatures.remove(FOREGROUND_ID);
        }
        notificationMode = NotificationMode.GROUP;
        Notification summary = buildReplyGroupSummaryNotification(states);
        boolean foregroundStarted = false;
        if (!hasReplying) {
            notifyIfChanged(FOREGROUND_ID, summary, buildGroupSummarySignature(states));
        } else {
            try {
                startForegroundIfChanged(FOREGROUND_ID, summary, buildGroupSummarySignature(states));
                foregroundStarted = true;
            } catch (RuntimeException ex) {
                Log.w(TAG, "start foreground failed, posting notification only", ex);
                notifyIfChanged(FOREGROUND_ID, summary, buildGroupSummarySignature(states));
            }
        }
        for (ReplyState state : states) {
            notifyIfChanged(state.notificationId, buildReplyChildNotification(state), buildStateSignature(state, true));
        }
        if (!foregroundStarted && hasReplying) {
            notifyIfChanged(FOREGROUND_ID, summary, buildGroupSummarySignature(states));
        }
    }

    private void showSingleReplyNotification(ReplyState state) {
        if (notificationMode != NotificationMode.SINGLE) {
            for (ReplyState item : states.values()) {
                notificationManager.cancel(item.notificationId);
                notificationSignatures.remove(item.notificationId);
            }
        }
        notificationMode = NotificationMode.SINGLE;
        boolean replying = state.status == ReplyStatus.REPLYING;
        Notification notification = buildReplyNotification(state);
        String signature = buildStateSignature(state, false);
        if (!replying) {
            notifyIfChanged(FOREGROUND_ID, notification, signature);
            return;
        }
        try {
            startForegroundIfChanged(FOREGROUND_ID, notification, signature);
        } catch (RuntimeException ex) {
            Log.w(TAG, "start foreground failed, posting notification only", ex);
            notifyIfChanged(FOREGROUND_ID, notification, signature);
        }
    }

    private void notifyIfChanged(int notificationId, Notification notification, String signature) {
        if (signature.equals(notificationSignatures.get(notificationId))) {
            return;
        }
        notificationManager.notify(notificationId, notification);
        notificationSignatures.put(notificationId, signature);
    }

    private void startForegroundIfChanged(int notificationId, Notification notification, String signature) {
        if (signature.equals(notificationSignatures.get(notificationId))) {
            return;
        }
        startForegroundCompat(notificationId, notification);
        notificationSignatures.put(notificationId, signature);
    }

    private String buildGroupSummarySignature(List<ReplyState> states) {
        StringBuilder builder = new StringBuilder(hasReplyingState(states) ? "group:replying" : "group:done");
        builder.append(':').append(states.size());
        for (ReplyState state : states) {
            builder.append('|').append(buildStateSignature(state, true));
        }
        return builder.toString();
    }

    private String buildStateSignature(ReplyState state, boolean grouped) {
        return (grouped ? "child" : "single") +
            ":" + state.sessionKey +
            ":" + state.rootId +
            ":" + state.rootTitle +
            ":" + state.sessionTitle +
            ":" + state.summary +
            ":" + state.status.name();
    }

    private List<ReplyState> visibleStates() {
        List<ReplyState> items = new ArrayList<>();
        for (ReplyState state : states.values()) {
            if (state.status == ReplyStatus.REPLYING || state.status == ReplyStatus.COMPLETED) {
                items.add(state);
            }
        }
        return items;
    }

    private void sortMostRecentFirst(List<ReplyState> items) {
        Collections.sort(items, new Comparator<ReplyState>() {
            @Override
            public int compare(ReplyState left, ReplyState right) {
                return right.updatedAt.compareTo(left.updatedAt);
            }
        });
    }

    private boolean hasReplyingState(List<ReplyState> states) {
        for (ReplyState state : states) {
            if (state.status == ReplyStatus.REPLYING) {
                return true;
            }
        }
        return false;
    }

    private Notification buildReplyGroupSummaryNotification(List<ReplyState> states) {
        ReplyState target = states.get(0);
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) {
            launchIntent = new Intent(this, MainActivity.class);
        }
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launchIntent.putExtra("rootId", target.rootId);
        launchIntent.putExtra("sessionKey", target.sessionKey);

        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            FOREGROUND_ID,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        boolean hasReplying = hasReplyingState(states);
        String status = hasReplying ? "回复中" : "回复完成";
        String title = "MindFS";
        String text = buildAggregateLine(target);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, hasReplying ? VISIBLE_PROGRESS_CHANNEL_ID : ALERT_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.drawable.ic_stat_mindfs_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(contentIntent)
            .setOngoing(hasReplying)
            .setOnlyAlertOnce(hasReplying)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(hasReplying ? Notification.CATEGORY_SERVICE : Notification.CATEGORY_STATUS)
            .setGroup(REPLY_GROUP_KEY)
            .setGroupSummary(true)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
            .setStyle(new Notification.InboxStyle().setSummaryText(status));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O && !hasReplying) {
            builder.setSound(replyAlertSoundUri());
        }
        Notification.InboxStyle style = new Notification.InboxStyle();
        for (ReplyState state : states) {
            style.addLine(buildAggregateLine(state));
        }
        style.setSummaryText(status);
        builder.setStyle(style);
        if (!TextUtils.isEmpty(text)) {
            builder.setTicker(text);
        }
        return builder.build();
    }

    private String buildAggregateText(List<ReplyState> states) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < states.size(); i++) {
            if (i > 0) {
                builder.append('\n');
            }
            builder.append(buildAggregateLine(states.get(i)));
        }
        return builder.toString();
    }

    private String buildAggregateLine(ReplyState state) {
        String title = buildReplyTitle(state, state.status == ReplyStatus.COMPLETED ? "完成" : "回复中");
        if (state.summary.isEmpty()) {
            return title;
        }
        return title + ": " + state.summary;
    }

    private Notification buildReplyPlaceholderNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, VISIBLE_PROGRESS_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.drawable.ic_stat_mindfs_notification)
            .setContentTitle("MindFS")
            .setContentText("正在检查后台回复")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(Notification.CATEGORY_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    private Notification buildReplyNotification(ReplyState state) {
        boolean replying = state.status == ReplyStatus.REPLYING;
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) {
            launchIntent = new Intent(this, MainActivity.class);
        }
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launchIntent.putExtra("rootId", state.rootId);
        launchIntent.putExtra("sessionKey", state.sessionKey);

        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            state.notificationId,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String title = buildReplyTitle(state, replying ? "回复中" : "完成");
        String text = state.summary;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, replying ? VISIBLE_PROGRESS_CHANNEL_ID : ALERT_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.drawable.ic_stat_mindfs_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(contentIntent)
            .setOngoing(replying)
            .setOnlyAlertOnce(replying)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(replying ? Notification.CATEGORY_SERVICE : Notification.CATEGORY_STATUS)
            .setStyle(new Notification.BigTextStyle().bigText(text));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O && !replying) {
            builder.setSound(replyAlertSoundUri());
        }
        if (!TextUtils.isEmpty(text)) {
            builder.setTicker(text);
        }
        return builder.build();
    }

    private Notification buildReplyChildNotification(ReplyState state) {
        boolean replying = state.status == ReplyStatus.REPLYING;
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launchIntent == null) {
            launchIntent = new Intent(this, MainActivity.class);
        }
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        launchIntent.putExtra("rootId", state.rootId);
        launchIntent.putExtra("sessionKey", state.sessionKey);

        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            state.notificationId,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        String title = buildReplyTitle(state, replying ? "回复中" : "完成");
        String text = state.summary;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, replying ? VISIBLE_PROGRESS_CHANNEL_ID : ALERT_CHANNEL_ID)
            : new Notification.Builder(this);
        builder
            .setSmallIcon(R.drawable.ic_stat_mindfs_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(contentIntent)
            .setOngoing(replying)
            .setOnlyAlertOnce(replying)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setCategory(replying ? Notification.CATEGORY_SERVICE : Notification.CATEGORY_STATUS)
            .setGroup(REPLY_GROUP_KEY)
            .setGroupSummary(false)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY)
            .setStyle(new Notification.BigTextStyle().bigText(text));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O && !replying) {
            builder.setSound(replyAlertSoundUri());
        }
        if (!TextUtils.isEmpty(text)) {
            builder.setTicker(text);
        }
        return builder.build();
    }

    private String buildReplyTitle(ReplyState state, String status) {
        return buildReplyTitlePrefix(state) + " · " + status;
    }

    private String buildReplyTitlePrefix(ReplyState state) {
        String root = state.rootTitle.isEmpty() ? state.rootId : state.rootTitle;
        if (root.isEmpty()) {
            root = "MindFS";
        }
        String title = state.sessionTitle.isEmpty() ? "会话" : state.sessionTitle;
        return root + " · " + title;
    }

    private String buildReplyItemTitle(ReplyState state, String status) {
        String title = state.sessionTitle.isEmpty() ? "会话" : state.sessionTitle;
        return title + " · " + status;
    }

    private void clearCompleted() {
        Iterator<Map.Entry<String, ReplyState>> iterator = states.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, ReplyState> entry = iterator.next();
            ReplyState state = entry.getValue();
            if (state.status == ReplyStatus.COMPLETED) {
                notificationManager.cancel(state.notificationId);
                iterator.remove();
            }
        }
        Set<String> completedKeys = getCompletedKeys();
        for (String sessionKey : completedKeys) {
            notificationManager.cancel(notificationIdFor(sessionKey));
        }
        notificationManager.cancel(FOREGROUND_ID);
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().remove(PREF_COMPLETED_KEYS).apply();
    }

    private Set<String> getCompletedKeys() {
        return new HashSet<>(getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getStringSet(PREF_COMPLETED_KEYS, new HashSet<>()));
    }

    private void addCompletedKey(String sessionKey) {
        Set<String> keys = getCompletedKeys();
        keys.add(sessionKey);
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putStringSet(PREF_COMPLETED_KEYS, keys).apply();
    }

    private void removeCompletedKey(String sessionKey) {
        Set<String> keys = getCompletedKeys();
        if (!keys.remove(sessionKey)) {
            return;
        }
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putStringSet(PREF_COMPLETED_KEYS, keys).apply();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || notificationManager == null) {
            return;
        }
        NotificationChannel progress = new NotificationChannel(
            PROGRESS_CHANNEL_ID,
            "MindFS reply progress",
            NotificationManager.IMPORTANCE_LOW
        );
        progress.setDescription("MindFS background reply progress");
        progress.setSound(null, null);
        progress.enableVibration(false);
        progress.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        notificationManager.createNotificationChannel(progress);

        NotificationChannel visibleProgress = new NotificationChannel(
            VISIBLE_PROGRESS_CHANNEL_ID,
            "MindFS reply progress",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        visibleProgress.setDescription("MindFS background reply progress");
        visibleProgress.setSound(null, null);
        visibleProgress.enableVibration(false);
        visibleProgress.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        notificationManager.createNotificationChannel(visibleProgress);

        NotificationChannel alert = new NotificationChannel(
            ALERT_CHANNEL_ID,
            "MindFS reply alerts",
            NotificationManager.IMPORTANCE_DEFAULT
        );
        alert.setDescription("MindFS reply completion alerts");
        alert.enableVibration(false);
        alert.setSound(
            replyAlertSoundUri(),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        alert.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        notificationManager.createNotificationChannel(alert);
    }

    private Uri replyAlertSoundUri() {
        return Uri.parse("android.resource://" + getPackageName() + "/" + R.raw.mindfs_reply_alert);
    }

    private void startForegroundCompat(int notificationId, Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(notificationId, notification);
        }
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    private void stopForegroundDetachCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(Service.STOP_FOREGROUND_DETACH);
        } else {
            stopForeground(false);
        }
    }

    private void vibrateReplyCompletion() {
        Vibrator vibrator = getReplyVibrator();
        if (vibrator == null || !vibrator.hasVibrator()) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createWaveform(ALERT_VIBRATION_PATTERN, -1));
        } else {
            vibrator.vibrate(ALERT_VIBRATION_PATTERN, -1);
        }
    }

    private Vibrator getReplyVibrator() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager manager = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            if (manager != null) {
                return manager.getDefaultVibrator();
            }
        }
        return (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static int notificationIdFor(String sessionKey) {
        return NOTIFICATION_BASE_ID + Math.abs(sessionKey.hashCode() % 100000);
    }

    private enum ReplyStatus {
        REPLYING,
        COMPLETED
    }

    private enum NotificationMode {
        NONE,
        SINGLE,
        GROUP
    }

    private static final class ReplyState {
        final String sessionKey;
        final int notificationId;
        String rootId = "";
        String rootTitle = "";
        String sessionTitle = "";
        String summary = "";
        String updatedAt = "";
        ReplyStatus status = ReplyStatus.REPLYING;

        ReplyState(String sessionKey) {
            this.sessionKey = sessionKey;
            this.notificationId = notificationIdFor(sessionKey);
        }
    }
}
