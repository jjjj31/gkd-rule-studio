package com.gkdrulebuilder.android;

import android.content.Context;
import android.os.Build;
import android.os.Process;
import android.util.AtomicFile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/** Read-only diagnostics for the optional user-feedback flow. */
public final class FeedbackDiagnostics {
    static final int MAX_CRASH_BYTES = 8 * 1024;
    static final long CRASH_RETENTION_MILLIS = TimeUnit.DAYS.toMillis(7);

    private static final String CRASH_FILE_NAME = "feedback-last-crash.txt";
    private static final Object INSTALL_LOCK = new Object();
    private static final Object WRITE_LOCK = new Object();
    private static final ThreadLocal<Boolean> HANDLER_ACTIVE = new ThreadLocal<>();
    private static boolean installed;

    private FeedbackDiagnostics() {}

    /** Installs one process-wide crash recorder as early as the Activity can. */
    public static void install(Context context) {
        if (context == null) return;
        Context appContext = context.getApplicationContext();
        if (appContext == null) appContext = context;

        synchronized (INSTALL_LOCK) {
            if (installed) return;
            Thread.UncaughtExceptionHandler current =
                Thread.getDefaultUncaughtExceptionHandler();
            if (current instanceof CrashCaptureHandler) {
                installed = true;
                return;
            }
            try {
                Thread.setDefaultUncaughtExceptionHandler(
                    new CrashCaptureHandler(appContext, current)
                );
                installed = true;
            } catch (Throwable ignored) {
                // Diagnostics must never make startup fail.
            }
        }
    }

    /** Returns only the limited device description and the recent crash text. */
    public static String getDiagnosticsJson(Context context) {
        String systemVersion = formatSystemVersion(
            Build.MANUFACTURER,
            Build.MODEL,
            Build.VERSION.RELEASE,
            Build.VERSION.SDK_INT
        );
        String lastCrash = "";
        if (context != null) {
            try {
                Context appContext = context.getApplicationContext();
                if (appContext == null) appContext = context;
                lastCrash = readLastCrash(appContext, System.currentTimeMillis());
            } catch (Throwable ignored) {
                // A damaged diagnostics file must not break the bridge.
            }
        }
        return diagnosticsJson(systemVersion, lastCrash);
    }

    static String formatSystemVersion(
        String manufacturer,
        String model,
        String release,
        int sdkInt
    ) {
        return normalizeBuildValue(manufacturer)
            + " "
            + normalizeBuildValue(model)
            + "; Android "
            + normalizeBuildValue(release)
            + " (SDK "
            + sdkInt
            + ")";
    }

    static String diagnosticsJson(String systemVersion, String lastCrash) {
        return "{\"systemVersion\":"
            + jsonQuote(systemVersion)
            + ",\"lastCrash\":"
            + jsonQuote(lastCrash)
            + "}";
    }

    static boolean isExpired(long modifiedAtMillis, long nowMillis) {
        return modifiedAtMillis <= 0
            || nowMillis - modifiedAtMillis >= CRASH_RETENTION_MILLIS;
    }

    static String truncateUtf8(String value, int maxBytes) {
        if (value == null || value.isEmpty() || maxBytes <= 0) return "";
        if (value.getBytes(StandardCharsets.UTF_8).length <= maxBytes) return value;

        StringBuilder result = new StringBuilder(Math.min(value.length(), maxBytes));
        int usedBytes = 0;
        for (int index = 0; index < value.length();) {
            int codePoint = value.codePointAt(index);
            int charCount = Character.charCount(codePoint);
            String part = value.substring(index, index + charCount);
            int partBytes = part.getBytes(StandardCharsets.UTF_8).length;
            if (usedBytes + partBytes > maxBytes) break;
            result.append(part);
            usedBytes += partBytes;
            index += charCount;
        }
        return result.toString();
    }

    private static String readLastCrash(Context context, long nowMillis) throws IOException {
        if (context == null) return "";
        AtomicFile file = crashFile(context);
        File baseFile = file.getBaseFile();
        File backupFile = new File(baseFile.getPath() + ".bak");
        if (!baseFile.isFile() && !backupFile.isFile()) return "";

        long modifiedAt = baseFile.isFile()
            ? baseFile.lastModified()
            : backupFile.lastModified();
        if (isExpired(modifiedAt, nowMillis)) {
            synchronized (WRITE_LOCK) {
                try {
                    file.delete();
                } catch (Throwable ignored) {
                    // A later read will retry cleanup.
                }
            }
            return "";
        }

        try (InputStream input = file.openRead()) {
            ByteArrayOutputStream output = new ByteArrayOutputStream(MAX_CRASH_BYTES + 4);
            byte[] buffer = new byte[1024];
            while (output.size() < MAX_CRASH_BYTES + 4) {
                int wanted = Math.min(buffer.length, MAX_CRASH_BYTES + 4 - output.size());
                int read = input.read(buffer, 0, wanted);
                if (read < 0) break;
                output.write(buffer, 0, read);
            }
            return truncateUtf8(
                new String(output.toByteArray(), StandardCharsets.UTF_8),
                MAX_CRASH_BYTES
            );
        }
    }

    private static void writeLastCrash(Context context, Throwable error) {
        if (context == null || error == null) return;
        String text = truncateUtf8(formatCrash(error), MAX_CRASH_BYTES);
        if (text.isEmpty()) return;

        synchronized (WRITE_LOCK) {
            AtomicFile file = crashFile(context);
            FileOutputStream output = null;
            try {
                output = file.startWrite();
                output.write(text.getBytes(StandardCharsets.UTF_8));
                output.flush();
                file.finishWrite(output);
            } catch (Throwable writeError) {
                if (output != null) {
                    try {
                        file.failWrite(output);
                    } catch (Throwable ignored) {
                        // The original crash still goes to the platform handler.
                    }
                }
            }
        }
    }

    static String formatCrash(Throwable error) {
        if (error == null) return "";
        try {
            StringWriter buffer = new StringWriter();
            PrintWriter writer = new PrintWriter(buffer);
            error.printStackTrace(writer);
            writer.flush();
            return truncateUtf8(buffer.toString(), MAX_CRASH_BYTES);
        } catch (Throwable formattingError) {
            return truncateUtf8(String.valueOf(error), MAX_CRASH_BYTES);
        }
    }

    private static AtomicFile crashFile(Context context) {
        File directory = context.getNoBackupFilesDir();
        if (directory == null) directory = context.getFilesDir();
        return new AtomicFile(new File(directory, CRASH_FILE_NAME));
    }

    private static String normalizeBuildValue(String value) {
        if (value == null) return "unknown";
        String normalized = value.trim();
        return normalized.isEmpty() ? "unknown" : normalized;
    }

    private static String jsonQuote(String value) {
        if (value == null || value.isEmpty()) return "\"\"";
        StringBuilder result = new StringBuilder(value.length() + 16);
        result.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"': result.append("\\\""); break;
                case '\\': result.append("\\\\"); break;
                case '\b': result.append("\\b"); break;
                case '\f': result.append("\\f"); break;
                case '\n': result.append("\\n"); break;
                case '\r': result.append("\\r"); break;
                case '\t': result.append("\\t"); break;
                default:
                    if (character < 0x20) {
                        result.append(String.format("\\u%04x", (int) character));
                    } else {
                        result.append(character);
                    }
            }
        }
        return result.append('"').toString();
    }

    private static final class CrashCaptureHandler implements Thread.UncaughtExceptionHandler {
        private final Context context;
        private final Thread.UncaughtExceptionHandler delegate;

        CrashCaptureHandler(Context context, Thread.UncaughtExceptionHandler delegate) {
            this.context = context;
            this.delegate = delegate;
        }

        @Override
        public void uncaughtException(Thread thread, Throwable error) {
            if (Boolean.TRUE.equals(HANDLER_ACTIVE.get())) {
                terminateProcess();
                return;
            }

            HANDLER_ACTIVE.set(Boolean.TRUE);
            try {
                try {
                    writeLastCrash(context, error);
                } catch (Throwable ignored) {
                    // Crash capture is best effort; the platform handler runs next.
                }

                if (delegate == null) {
                    terminateProcess();
                    return;
                }
                try {
                    delegate.uncaughtException(thread, error);
                } catch (Throwable delegateError) {
                    // Do not recurse through the same handler if the platform handler fails.
                    terminateProcess();
                }
            } finally {
                HANDLER_ACTIVE.remove();
            }
        }

        private static void terminateProcess() {
            try {
                Process.killProcess(Process.myPid());
            } catch (Throwable ignored) {
                // The crashing thread still exits when this best-effort call fails.
            }
        }
    }
}
