package com.gkdrulebuilder.android;

import android.content.Context;

import org.json.JSONObject;

/** 供 WebView 调用的跳过记录查询接口。 */
public final class SkipCaptureBridge {
    private SkipCaptureBridge() {
    }

    public static JSONObject status(Context context) throws Exception {
        JSONObject result = new JSONObject();
        JSONObject stat = SkipCaptureStore.get(context).status();
        result.put("ok", true);
        result.put("enabled", SkipCapturePrefs.isEnabled(context));
        result.put("serviceConnected", SkipCaptureRuntime.isConnected());
        result.put("screenshots", SkipCapturePrefs.captureScreenshots(context));
        result.put("maxRecords", SkipCapturePrefs.maxRecords(context));
        result.put("count", stat.optLong("count"));
        result.put("bytes", stat.optLong("bytes"));
        return result;
    }

    public static JSONObject list(Context context, int offset, int limit) throws Exception {
        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("items", SkipCaptureStore.get(context).list(offset, limit));
        return result;
    }

    public static JSONObject detail(Context context, long id) throws Exception {
        JSONObject item = SkipCaptureStore.get(context).detail(id);
        JSONObject result = new JSONObject();
        result.put("ok", item != null);
        if (item == null) {
            result.put("error", "记录不存在或已清理");
        } else {
            result.put("item", item);
        }
        return result;
    }

    public static JSONObject clear(Context context) throws Exception {
        int deleted = SkipCaptureStore.get(context).clear();
        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("deleted", deleted);
        return result;
    }
}
