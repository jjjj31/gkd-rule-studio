package com.gkdrulebuilder.android;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

/** 跳过记录的开关与忽略名单。默认关闭，必须由用户显式打开。 */
public final class SkipCapturePrefs {
    private static final String FILE = "skip_capture";
    private static final String KEY_ENABLED = "enabled";
    private static final String KEY_SCREENSHOTS = "screenshots";
    private static final String KEY_IGNORED = "ignored_packages";
    private static final String KEY_MAX_RECORDS = "max_records";

    private SkipCapturePrefs() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static boolean isEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    public static boolean captureScreenshots(Context context) {
        return prefs(context).getBoolean(KEY_SCREENSHOTS, true);
    }

    public static void setCaptureScreenshots(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_SCREENSHOTS, enabled).apply();
    }

    public static boolean isIgnored(Context context, String packageName) {
        return ignored(context).contains(packageName);
    }

    public static Set<String> ignored(Context context) {
        return new HashSet<>(prefs(context).getStringSet(KEY_IGNORED, Collections.emptySet()));
    }

    public static void setIgnored(Context context, Set<String> packages) {
        prefs(context).edit().putStringSet(KEY_IGNORED, new HashSet<>(packages)).apply();
    }

    public static int maxRecords(Context context) {
        return Math.max(200, prefs(context).getInt(KEY_MAX_RECORDS, 500));
    }
}
