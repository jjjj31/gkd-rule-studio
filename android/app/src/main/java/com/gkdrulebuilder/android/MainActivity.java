package com.gkdrulebuilder.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.MenuItem;
import android.view.View;
import android.view.Window;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
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
            getActionBar().setDisplayHomeAsUpEnabled(false);
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
