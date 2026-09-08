package com.gkdrulebuilder.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.MenuItem;
import android.view.View;
import android.view.Window;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public class MainActivity extends Activity {
    private WebView webView;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        );
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.rgb(14, 19, 26));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(14, 19, 26));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new AndroidBridge(this, webView), "GkdAndroidBridge");
        webView.loadUrl("file:///android_asset/index.html#android");
        if (getActionBar() != null) {
            getActionBar().hide();
        }
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == android.R.id.home && webView != null) {
            webView.evaluateJavascript(
                "window.__GkdAndroidBack && window.__GkdAndroidBack()",
                null
            );
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    public static class AndroidBridge {
        private final Context context;
        private final WebView webView;
        private final Handler mainHandler = new Handler(Looper.getMainLooper());
        private final ExecutorService networkExecutor = Executors.newCachedThreadPool();
        private final ScheduledExecutorService timeoutExecutor = Executors.newScheduledThreadPool(1);

        AndroidBridge(Context context) {
            this.context = context;
            this.webView = null;
        }

        AndroidBridge(Context context, WebView webView) {
            this.context = context;
            this.webView = webView;
        }

        @JavascriptInterface
        public void copyToClipboard(String text) {
            ClipboardManager manager =
                (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (manager != null) {
                manager.setPrimaryClip(ClipData.newPlainText("GKD Rule Studio", text));
            }
        }

        @JavascriptInterface
        public void setBackVisible(boolean visible) {
            if (!(context instanceof Activity)) return;
            mainHandler.post(() -> {
                Activity activity = (Activity) context;
                if (activity.getActionBar() != null) {
                    activity.getActionBar().setDisplayHomeAsUpEnabled(visible);
                }
            });
        }

        /**
         * 保存前端导出的文件（base64）。API 29+ 写入公共下载目录
         * Download/GKD Rule Studio/（MediaStore，无需权限）；老系统落到应用
         * 外部私有目录并 Toast 提示完整路径。
         */
        @JavascriptInterface
        public void saveFile(String fileName, String mimeType, String base64) {
            final byte[] bytes;
            try {
                bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
            } catch (Exception cause) {
                toast("导出失败：文件内容解码失败");
                return;
            }
            final String safeName = fileName == null ? "" : fileName.trim();
            if (safeName.isEmpty() || safeName.contains("/") || safeName.contains("\\")) {
                toast("导出失败：文件名非法");
                return;
            }
            networkExecutor.execute(() -> {
                String savedLabel;
                try {
                    savedLabel = saveFileInternal(safeName, mimeType, bytes);
                } catch (Exception cause) {
                    String reason = cause.getMessage() == null ? "未知错误" : cause.getMessage();
                    toast("导出失败：" + reason);
                    return;
                }
                toast("已导出 " + savedLabel);
            });
        }

        private String saveFileInternal(String fileName, String mimeType, byte[] bytes)
            throws Exception {
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                values.put(
                    MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/GKD Rule Studio"
                );
                Uri uri = context
                    .getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    throw new Exception("无法创建下载文件");
                }
                try (OutputStream out = context.getContentResolver().openOutputStream(uri)) {
                    if (out == null) {
                        throw new Exception("无法打开输出流");
                    }
                    out.write(bytes);
                    out.flush();
                }
                return "Download/GKD Rule Studio/" + fileName;
            }
            File dir = context.getExternalFilesDir(null);
            if (dir == null) {
                dir = context.getFilesDir();
            }
            File target = new File(dir, fileName);
            try (FileOutputStream out = new FileOutputStream(target)) {
                out.write(bytes);
                out.flush();
            }
            return target.getAbsolutePath();
        }

        private void toast(String text) {
            mainHandler.post(() ->
                Toast.makeText(context, text, Toast.LENGTH_LONG).show()
            );
        }

        @JavascriptInterface
        public void getAppUpdateInfo(String requestId) {
            networkExecutor.execute(() -> {
                try {
                    PackageInfo info = context
                        .getPackageManager()
                        .getPackageInfo(context.getPackageName(), 0);
                    JSONObject result = new JSONObject();
                    result.put("ok", true);
                    result.put("versionName", info.versionName);
                    result.put("versionCode", info.versionCode);
                    emitResult(requestId, result);
                } catch (Exception cause) {
                    emitResult(requestId, errorResult("读取版本失败：" + cause.getMessage(), -1));
                }
            });
        }

        private boolean canInstallPackage() {
            if (Build.VERSION.SDK_INT < 26) return true;
            try {
                return context.getPackageManager().canRequestPackageInstalls();
            } catch (Exception ignored) {
                return true;
            }
        }

        @JavascriptInterface
        public void canInstallApk(String requestId) {
            JSONObject result = new JSONObject();
            try {
                result.put("ok", true);
                result.put("allowed", canInstallPackage());
                result.put("sdk", Build.VERSION.SDK_INT);
            } catch (Exception ignored) {
            }
            emitResult(requestId, result);
        }

        @JavascriptInterface
        public void openInstallSettings() {
            if (Build.VERSION.SDK_INT < 26) return;
            try {
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName())
                );
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
            } catch (Exception cause) {
                toast("无法打开安装设置：" + cause.getMessage());
            }
        }

        /**
         * 依次尝试 urlsJson（JSON 数组）里的下载地址下载 APK 到应用外部私有目录，
         * 全部失败才算失败;下载成功后校验 sha256,不匹配则报错并删除文件。
         * 进度回调:window.__GkdUpdateProgress(requestId, {percent,received,total})。
         */
        @JavascriptInterface
        public void downloadApk(
            String requestId,
            String urlsJson,
            String expectedSha256,
            String fileName
        ) {
            networkExecutor.execute(() -> {
                String lastError = "没有可用的下载地址";
                try {
                    JSONArray urls = new JSONArray(urlsJson);
                    if (urls.length() == 0) {
                        emitResult(requestId, errorResult(lastError, -1));
                        return;
                    }
                    final String safeName = (fileName == null || fileName.trim().isEmpty())
                        ? "gkd-rule-studio-update.apk"
                        : fileName.trim().replace('\\', '_').replace('/', '_');
                    File dir = context.getExternalFilesDir(null);
                    if (dir == null) {
                        dir = context.getFilesDir();
                    }
                    final File target = new File(dir, safeName);
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                    for (int i = 0; i < urls.length(); i++) {
                        String urlValue = urls.optString(i);
                        try {
                            long received = downloadFile(urlValue, target, requestId);
                            String actualSha256 = sha256Of(target);
                            if (
                                expectedSha256 != null &&
                                !expectedSha256.trim().isEmpty() &&
                                !expectedSha256.trim().equalsIgnoreCase(actualSha256)
                            ) {
                                //noinspection ResultOfMethodCallIgnored
                                target.delete();
                                emitResult(
                                    requestId,
                                    errorResult("校验失败:sha256 不匹配", -1)
                                );
                                return;
                            }
                            JSONObject result = new JSONObject();
                            result.put("ok", true);
                            result.put("path", target.getAbsolutePath());
                            result.put("bytes", received);
                            result.put("sha256", actualSha256);
                            emitResult(requestId, result);
                            return;
                        } catch (Exception cause) {
                            // 网络类失败换下一个镜像;哈希不匹配已在上方直接返回
                            lastError = cause.getMessage() == null
                                ? "下载失败（第 " + (i + 1) + " 个地址）"
                                : cause.getMessage();
                        }
                    }
                    emitResult(requestId, errorResult(lastError, -1));
                } catch (Exception cause) {
                    emitResult(
                        requestId,
                        errorResult(cause.getMessage() == null ? "下载失败" : cause.getMessage(), -1)
                    );
                }
            });
        }

        @JavascriptInterface
        public void installApk(String requestId, String filePath) {
            try {
                File file = new File(filePath);
                if (!file.exists()) {
                    emitResult(requestId, errorResult("安装包不存在", -1));
                    return;
                }
                if (!canInstallPackage()) {
                    JSONObject result = new JSONObject();
                    result.put("ok", false);
                    result.put("needPermission", true);
                    result.put("status", -1);
                    result.put("body", "");
                    result.put("error", "需要允许安装未知应用");
                    emitResult(requestId, result);
                    return;
                }
                Uri uri = Uri.parse(
                    "content://" + ApkFileProvider.AUTHORITY + file.getAbsolutePath()
                );
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
                JSONObject result = new JSONObject();
                result.put("ok", true);
                result.put("launched", true);
                emitResult(requestId, result);
            } catch (Exception cause) {
                emitResult(requestId, errorResult(cause.getMessage(), -1));
            }
        }

        /** 下载 URL 到 target（覆盖写入），边下边发进度，返回实际写入字节数。 */
        private long downloadFile(String urlValue, File target, String requestId)
            throws Exception {
            HttpURLConnection connection = (HttpURLConnection) new URL(urlValue).openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(60000);
            connection.setRequestMethod("GET");
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                connection.disconnect();
                throw new Exception("下载失败：HTTP " + status);
            }
            long total = Math.max(0, connection.getContentLengthLong());
            long received = 0;
            long lastEmitAt = 0;
            try (
                InputStream input = new BufferedInputStream(connection.getInputStream());
                OutputStream output = new FileOutputStream(target)
            ) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    output.write(buffer, 0, count);
                    received += count;
                    long now = System.currentTimeMillis();
                    if (now - lastEmitAt >= 250 || received >= total) {
                        lastEmitAt = now;
                        emitProgress(requestId, total, received);
                    }
                }
            } finally {
                connection.disconnect();
            }
            if (total > 0 && received != total) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                throw new Exception("下载中断：已接收 " + received + "/" + total + " 字节");
            }
            return received;
        }

        private String sha256Of(File file) throws Exception {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream stream = new BufferedInputStream(new FileInputStream(file))) {
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = stream.read(buffer)) != -1) {
                    digest.update(buffer, 0, count);
                }
            }
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) {
                hex.append(String.format("%02x", b));
            }
            return hex.toString();
        }

        private void emitProgress(String requestId, long total, long received) {
            if (webView == null) return;
            JSONObject payload = new JSONObject();
            try {
                payload.put("percent", total > 0 ? (int) (received * 100 / total) : -1);
                payload.put("received", received);
                payload.put("total", total);
            } catch (Exception ignored) {
            }
            final String script = "window.__GkdUpdateProgress && window.__GkdUpdateProgress("
                + JSONObject.quote(requestId)
                + ","
                + payload.toString()
                + ")";
            mainHandler.post(() -> {
                if (webView != null) {
                    webView.evaluateJavascript(script, null);
                }
            });
        }

        @JavascriptInterface
        public void postJson(
            String requestId,
            String url,
            String headersJson,
            String bodyJson,
            int timeoutMs
        ) {
            int safeTimeoutMs = safeTimeoutMs(timeoutMs);
            AtomicBoolean completed = new AtomicBoolean(false);
            AtomicReference<HttpURLConnection> activeConnection = new AtomicReference<>(null);
            final ScheduledFuture<?>[] watchdog = new ScheduledFuture<?>[1];
            Runnable scheduleWatchdog = () -> {
                watchdog[0] = timeoutExecutor.schedule(() -> {
                    if (!completed.compareAndSet(false, true)) return;
                    HttpURLConnection connection = activeConnection.get();
                    if (connection != null) {
                        connection.disconnect();
                    }
                    emitResult(requestId, errorResult("timeout", -1));
                }, safeTimeoutMs + 1500L, TimeUnit.MILLISECONDS);
            };
            scheduleWatchdog.run();

            networkExecutor.execute(() -> {
                try {
                    JSONObject result;
                    try {
                        result = doPostJson(
                            url,
                            headersJson,
                            bodyJson,
                            safeTimeoutMs,
                            activeConnection
                        );
                    } catch (Exception firstCause) {
                        if (!isRetriableNetworkAbort(firstCause)) {
                            throw firstCause;
                        }
                        // Reschedule the watchdog for the retry so it gets a full timeout window.
                        cancelWatchdog(watchdog[0]);
                        scheduleWatchdog.run();
                        result = doPostJson(
                            url,
                            headersJson,
                            bodyJson,
                            safeTimeoutMs,
                            activeConnection
                        );
                    }
                    if (completed.compareAndSet(false, true)) {
                        emitResult(requestId, result);
                    }
                } catch (Exception cause) {
                    if (completed.compareAndSet(false, true)) {
                        emitResult(
                            requestId,
                            errorResult(
                                cause.getMessage() == null ? "请求失败" : cause.getMessage(),
                                -1
                            )
                        );
                    }
                } finally {
                    cancelWatchdog(watchdog[0]);
                    activeConnection.set(null);
                }
            });
        }

        private static void cancelWatchdog(ScheduledFuture<?> future) {
            if (future != null) {
                future.cancel(false);
            }
        }

        private JSONObject doPostJson(
            String urlValue,
            String headersJson,
            String bodyJson,
            int safeTimeoutMs,
            AtomicReference<HttpURLConnection> activeConnection
        ) throws Exception {
            HttpURLConnection connection = (HttpURLConnection) new URL(urlValue).openConnection();
            activeConnection.set(connection);
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(safeTimeoutMs);
            connection.setReadTimeout(safeTimeoutMs);
            connection.setDoOutput(true);

            JSONObject headers = new JSONObject(headersJson);
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                connection.setRequestProperty(key, headers.optString(key));
            }

            byte[] bytes = bodyJson.getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream outputStream = connection.getOutputStream()) {
                outputStream.write(bytes);
            }

            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 400
                ? connection.getInputStream()
                : connection.getErrorStream();
            String body = readStream(stream);
            connection.disconnect();

            JSONObject result = new JSONObject();
            result.put("ok", status >= 200 && status < 300);
            result.put("status", status);
            result.put("body", body);
            if (status < 200 || status >= 300) {
                result.put("error", "HTTP " + status);
            }
            return result;
        }

        private int safeTimeoutMs(int timeoutMs) {
            return Math.max(5000, Math.min(timeoutMs, 300000));
        }

        private boolean isRetriableNetworkAbort(Exception cause) {
            String message = cause.getMessage();
            if (message == null) return false;
            String lower = message.toLowerCase();
            return lower.contains("software caused connection abort")
                || lower.contains("connection reset")
                || lower.contains("broken pipe");
        }

        private JSONObject errorResult(String error, int status) {
            JSONObject result = new JSONObject();
            try {
                result.put("ok", false);
                result.put("status", status);
                result.put("body", "");
                result.put("error", error);
            } catch (Exception ignored) {
            }
            return result;
        }

        private String readStream(InputStream stream) throws Exception {
            if (stream == null) return "";
            StringBuilder builder = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8)
            )) {
                String line;
                while ((line = reader.readLine()) != null) {
                    builder.append(line).append('\n');
                }
            }
            return builder.toString().trim();
        }

        private void emitResult(String requestId, JSONObject result) {
            if (webView == null) return;
            mainHandler.post(() -> {
                String script = "window.__GkdAndroidBridgeResult && window.__GkdAndroidBridgeResult("
                    + JSONObject.quote(requestId)
                    + ","
                    + result.toString()
                    + ")";
                webView.evaluateJavascript(script, null);
            });
        }
    }
}
