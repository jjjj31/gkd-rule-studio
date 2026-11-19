package com.gkdrulebuilder.android;

import android.accessibilityservice.AccessibilityService;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.ByteArrayOutputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 记录“用户点了哪个控件、点完它有没有消失”。
 *
 * 注意：无障碍服务只能拿到 TYPE_VIEW_CLICKED（控件级点击），拿不到原始触摸坐标；
 * 坐标需要 adb。这里只做控件级记录，正好对应选择器需要的目标节点。
 */
public class SkipCaptureService extends AccessibilityService {
    /** 点击后多久再抓一次，用来判断广告是否消失。 */
    private static final long AFTER_DELAY_MS = SkipCaptureJudge.AFTER_DELAY_MS;
    /** 点击前缓冲树的有效期。 */
    private static final long BUFFER_TTL_MS = 3000;
    /** 缓冲树刷新间隔，避免频繁序列化。 */
    private static final long BUFFER_MIN_INTERVAL_MS = 1200;
    /** 同一次点击可能连发多个事件，按这个窗口去重。 */
    private static final long CLICK_DEDUPE_MS = 700;
    private static final int MAX_NODES = SkipCaptureTrees.DEFAULT_MAX_NODES;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Map<String, String> activityByPackage = new ConcurrentHashMap<>();
    private final AtomicInteger insertsSincePrune = new AtomicInteger();

    private ExecutorService worker;
    private ExecutorService screenshotExecutor;
    private SkipCaptureStore store;
    private int screenWidth;
    private int screenHeight;

    private volatile SkipCaptureTrees.Captured buffer;
    private volatile long bufferAt;
    private volatile boolean bufferBusy;
    private volatile String lastClickKey = "";
    private volatile long lastClickAt;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        if (worker != null) worker.shutdownNow();
        if (screenshotExecutor != null) screenshotExecutor.shutdownNow();
        worker = Executors.newSingleThreadExecutor();
        screenshotExecutor = Executors.newSingleThreadExecutor();
        store = SkipCaptureStore.get(this);
        measureScreen();
        SkipCaptureRuntime.attach(this);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || !SkipCapturePrefs.isEnabled(this)) return;
        String packageName = event.getPackageName() == null
            ? null
            : event.getPackageName().toString();
        if (packageName == null) return;
        if (getPackageName().equals(packageName)) return;
        if (SkipCapturePrefs.isIgnored(this, packageName)) return;

        int type = event.getEventType();
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            CharSequence className = event.getClassName();
            if (className != null) {
                activityByPackage.put(packageName, className.toString());
            }
            refreshBufferLater(packageName);
            return;
        }
        if (type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            refreshBufferLater(packageName);
            return;
        }
        if (type == AccessibilityEvent.TYPE_VIEW_CLICKED) {
            handleClick(event, packageName);
        }
    }

    @Override
    public void onInterrupt() {
        // 服务被系统中断时不保留半截数据。
        buffer = null;
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        measureScreen();
    }

    @Override
    public void onDestroy() {
        SkipCaptureRuntime.detach(this);
        if (worker != null) worker.shutdownNow();
        if (screenshotExecutor != null) screenshotExecutor.shutdownNow();
        super.onDestroy();
    }

    private void handleClick(AccessibilityEvent event, String packageName) {
        AccessibilityNodeInfo source = event.getSource();
        if (source == null) return;

        final String key;
        final String className;
        final String text;
        try {
            if (!source.isVisibleToUser()) return;
            key = keyOf(source);
            className = stringOf(source.getClassName());
            text = stringOf(source.getText());
        } finally {
            recycle(source);
        }

        long now = SystemClock.uptimeMillis();
        if (key.equals(lastClickKey) && now - lastClickAt < CLICK_DEDUPE_MS) return;
        lastClickKey = key;
        lastClickAt = now;

        final Attempt attempt = new Attempt();
        attempt.startedAt = System.currentTimeMillis();
        attempt.clickedAt = now;
        attempt.packageName = packageName;
        attempt.appLabel = appLabel(packageName);
        attempt.activityId = activityByPackage.get(packageName);
        attempt.clickedKey = key;
        attempt.clickedClass = className;
        attempt.clickedText = text;

        SkipCaptureTrees.Captured cached = buffer;
        boolean usable = cached != null
            && cached.keys.contains(key)
            && now - bufferAt <= BUFFER_TTL_MS;
        if (usable) {
            attempt.before = cached;
            attempt.beforeSource = "buffer";
        } else {
            attempt.beforeSource = "live";
        }

        submitToWorker(() -> runAttempt(attempt));
    }

    private void runAttempt(Attempt attempt) {
        try {
            if (attempt.before == null) {
                attempt.before = captureNow(attempt.packageName);
            }
            if (attempt.before == null) return;
            attempt.beforeFound = attempt.before.keys.contains(attempt.clickedKey);
            if (SkipCapturePrefs.captureScreenshots(this)) {
                attempt.beforePng = captureScreenshotJpeg();
            }
        } catch (Exception ignored) {
            return;
        }

        mainHandler.postDelayed(
            () -> {
                submitToWorker(() -> finishAttempt(attempt));
            },
            AFTER_DELAY_MS
        );
    }

    private void finishAttempt(Attempt attempt) {
        try {
            SkipCaptureTrees.Captured after = captureNow(attempt.packageName);
            byte[] afterPng = SkipCapturePrefs.captureScreenshots(this)
                ? captureScreenshotJpeg()
                : null;
            String currentActivity = activityByPackage.get(attempt.packageName);
            boolean windowChanged = currentActivity != null
                && attempt.activityId != null
                && !currentActivity.equals(attempt.activityId);

            SkipCaptureJudge.Verdict verdict = SkipCaptureJudge.judge(
                attempt.beforeFound,
                attempt.clickedKey,
                after == null ? null : new java.util.ArrayList<>(after.keys),
                windowChanged
            );

            SkipCaptureStore.Record record = new SkipCaptureStore.Record();
            record.createdAt = attempt.startedAt;
            record.packageName = attempt.packageName;
            record.appLabel = attempt.appLabel;
            record.activityId = attempt.activityId;
            record.outcome = verdict.outcome;
            record.reason = verdict.reason;
            record.clickedKey = attempt.clickedKey;
            record.clickedClass = attempt.clickedClass;
            record.clickedText = attempt.clickedText;
            record.durationMs = System.currentTimeMillis() - attempt.startedAt;
            record.nodeCount = attempt.before.nodeCount;
            record.beforeSource = attempt.beforeSource;
            record.beforeJson = attempt.before.json;
            record.afterJson = after == null ? null : after.json;
            record.beforePng = attempt.beforePng;
            record.afterPng = afterPng;

            if (store != null) {
                store.insert(record);
                if (insertsSincePrune.incrementAndGet() % 20 == 0) {
                    store.prune(SkipCapturePrefs.maxRecords(this));
                }
            }
        } catch (Exception ignored) {
            // 单次记录失败不能影响后续点击。
        }
    }

    private void refreshBufferLater(String packageName) {
        long now = SystemClock.uptimeMillis();
        if (bufferBusy || now - bufferAt < BUFFER_MIN_INTERVAL_MS) return;
        bufferBusy = true;
        boolean submitted = submitToWorker(() -> {
            try {
                SkipCaptureTrees.Captured captured = captureNow(packageName);
                if (captured != null) {
                    buffer = captured;
                    bufferAt = SystemClock.uptimeMillis();
                }
            } catch (Exception ignored) {
            } finally {
                bufferBusy = false;
            }
        });
        if (!submitted) {
            bufferBusy = false;
        }
    }

    /** 服务销毁后延迟任务仍可能触发，提交前再确认一次执行器可用。 */
    private boolean submitToWorker(Runnable task) {
        ExecutorService current = worker;
        if (current == null || current.isShutdown()) return false;
        try {
            current.execute(task);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private SkipCaptureTrees.Captured captureNow(String packageName) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        try {
            String rootPackage = root.getPackageName() == null
                ? packageName
                : root.getPackageName().toString();
            if (rootPackage != null && getPackageName().equals(rootPackage)) return null;
            String activity = activityByPackage.get(rootPackage);
            return SkipCaptureTrees.capture(
                root,
                rootPackage,
                activity,
                screenWidth,
                screenHeight,
                MAX_NODES
            );
        } catch (Exception ignored) {
            return null;
        } finally {
            recycle(root);
        }
    }

    private String keyOf(AccessibilityNodeInfo node) {
        String viewId = node.getViewIdResourceName();
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        return SkipCaptureJudge.nodeKey(
            SkipCaptureTrees.shortVid(viewId),
            viewId,
            stringOf(node.getText()),
            stringOf(node.getContentDescription()),
            stringOf(node.getClassName()),
            bounds.width(),
            bounds.height(),
            indexOf(node)
        );
    }

    /** 结构兜底键需要子节点在父节点里的位置，最多向上找 60 个兄弟。 */
    private int indexOf(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo parent = null;
        try {
            parent = node.getParent();
            if (parent == null) return 0;
            int count = Math.min(parent.getChildCount(), 60);
            for (int i = 0; i < count; i += 1) {
                AccessibilityNodeInfo child = parent.getChild(i);
                if (child == null) continue;
                try {
                    if (child.equals(node)) return i;
                } finally {
                    recycle(child);
                }
            }
            return 0;
        } catch (Exception ignored) {
            return 0;
        } finally {
            recycle(parent);
        }
    }

    private byte[] captureScreenshotJpeg() {
        if (Build.VERSION.SDK_INT < 30 || screenshotExecutor == null) return null;
        final CountDownLatch latch = new CountDownLatch(1);
        final byte[][] result = new byte[1][];
        try {
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                screenshotExecutor,
                new TakeScreenshotCallback() {
                    @Override
                    public void onSuccess(ScreenshotResult screenshot) {
                        HardwareBuffer hardwareBuffer = screenshot.getHardwareBuffer();
                        try {
                            Bitmap bitmap = Bitmap.wrapHardwareBuffer(
                                hardwareBuffer,
                                screenshot.getColorSpace()
                            );
                            if (bitmap != null) {
                                // 缩到 1080 宽再压，单张从约 250KB 降到约 80KB，
                                // 否则 500 条记录就会占掉几百 MB。
                                if (bitmap.getWidth() > 1080) {
                                    int height = Math.max(
                                        1,
                                        bitmap.getHeight() * 1080 / bitmap.getWidth()
                                    );
                                    Bitmap scaled = Bitmap.createScaledBitmap(
                                        bitmap,
                                        1080,
                                        height,
                                        true
                                    );
                                    bitmap.recycle();
                                    bitmap = scaled;
                                }
                                ByteArrayOutputStream output = new ByteArrayOutputStream();
                                bitmap.compress(Bitmap.CompressFormat.JPEG, 70, output);
                                result[0] = output.toByteArray();
                                bitmap.recycle();
                            }
                        } catch (Exception ignored) {
                        } finally {
                            hardwareBuffer.close();
                            latch.countDown();
                        }
                    }

                    @Override
                    public void onFailure(int errorCode) {
                        latch.countDown();
                    }
                }
            );
            latch.await(2, TimeUnit.SECONDS);
        } catch (Exception ignored) {
            return null;
        }
        return result[0];
    }

    private void measureScreen() {
        try {
            WindowManager manager = (WindowManager) getSystemService(WINDOW_SERVICE);
            if (manager == null) return;
            if (Build.VERSION.SDK_INT >= 30) {
                Rect bounds = manager.getMaximumWindowMetrics().getBounds();
                screenWidth = bounds.width();
                screenHeight = bounds.height();
            } else {
                DisplayMetrics metrics = new DisplayMetrics();
                manager.getDefaultDisplay().getRealMetrics(metrics);
                screenWidth = metrics.widthPixels;
                screenHeight = metrics.heightPixels;
            }
        } catch (Exception ignored) {
            screenWidth = 0;
            screenHeight = 0;
        }
    }

    private String appLabel(String packageName) {
        try {
            PackageManager manager = getPackageManager();
            return manager
                .getApplicationLabel(manager.getApplicationInfo(packageName, 0))
                .toString();
        } catch (Exception ignored) {
            return packageName;
        }
    }

    private static String stringOf(CharSequence value) {
        return value == null ? null : value.toString();
    }

    private static void recycle(AccessibilityNodeInfo node) {
        if (node == null) return;
        if (Build.VERSION.SDK_INT < 33) {
            node.recycle();
        }
    }

    private static final class Attempt {
        long startedAt;
        long clickedAt;
        String packageName;
        String appLabel;
        String activityId;
        String clickedKey;
        String clickedClass;
        String clickedText;
        String beforeSource;
        boolean beforeFound;
        SkipCaptureTrees.Captured before;
        byte[] beforePng;
    }
}
