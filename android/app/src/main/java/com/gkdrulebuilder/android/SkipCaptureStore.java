package com.gkdrulebuilder.android;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 跳过记录的本地存储。树 JSON 用 gzip 压缩后存 BLOB，截图单独存 BLOB。
 * 数据只留在应用私有目录，导出时生成 zip。
 */
public final class SkipCaptureStore extends SQLiteOpenHelper {
    private static final String DB_NAME = "skip-captures.db";
    private static final int DB_VERSION = 1;
    private static volatile SkipCaptureStore instance;

    public static SkipCaptureStore get(Context context) {
        if (instance == null) {
            synchronized (SkipCaptureStore.class) {
                if (instance == null) {
                    instance = new SkipCaptureStore(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    private SkipCaptureStore(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE captures ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "created_at INTEGER NOT NULL,"
                + "package_name TEXT,"
                + "app_label TEXT,"
                + "activity_id TEXT,"
                + "outcome TEXT NOT NULL,"
                + "reason TEXT,"
                + "clicked_key TEXT,"
                + "clicked_class TEXT,"
                + "clicked_text TEXT,"
                + "duration_ms INTEGER,"
                + "node_count INTEGER,"
                + "before_source TEXT,"
                + "before_json BLOB,"
                + "after_json BLOB,"
                + "before_png BLOB,"
                + "after_png BLOB"
                + ")"
        );
        db.execSQL("CREATE INDEX idx_captures_created ON captures(created_at DESC)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // 目前只有 v1；升级时保留数据，后续按版本增量迁移。
    }

    public static final class Record {
        public long createdAt;
        public String packageName;
        public String appLabel;
        public String activityId;
        public String outcome;
        public String reason;
        public String clickedKey;
        public String clickedClass;
        public String clickedText;
        public long durationMs;
        public int nodeCount;
        public String beforeSource;
        public String beforeJson;
        public String afterJson;
        public byte[] beforePng;
        public byte[] afterPng;
    }

    public long insert(Record record) {
        ContentValues values = new ContentValues();
        values.put("created_at", record.createdAt);
        values.put("package_name", record.packageName);
        values.put("app_label", record.appLabel);
        values.put("activity_id", record.activityId);
        values.put("outcome", record.outcome);
        values.put("reason", record.reason);
        values.put("clicked_key", record.clickedKey);
        values.put("clicked_class", record.clickedClass);
        values.put("clicked_text", record.clickedText);
        values.put("duration_ms", record.durationMs);
        values.put("node_count", record.nodeCount);
        values.put("before_source", record.beforeSource);
        values.put("before_json", gzipOrNull(record.beforeJson));
        values.put("after_json", gzipOrNull(record.afterJson));
        values.put("before_png", record.beforePng);
        values.put("after_png", record.afterPng);
        return getWritableDatabase().insert("captures", null, values);
    }

    public JSONObject status() throws Exception {
        SQLiteDatabase db = getReadableDatabase();
        JSONObject result = new JSONObject();
        try (Cursor cursor = db.rawQuery(
            "SELECT COUNT(*),"
                + "COALESCE(SUM(LENGTH(before_json) + LENGTH(after_json)"
                + " + COALESCE(LENGTH(before_png), 0) + COALESCE(LENGTH(after_png), 0)), 0)"
                + " FROM captures",
            null
        )) {
            if (cursor.moveToFirst()) {
                result.put("count", cursor.getLong(0));
                result.put("bytes", cursor.getLong(1));
            } else {
                result.put("count", 0);
                result.put("bytes", 0);
            }
        }
        return result;
    }

    public JSONArray list(int offset, int limit) throws Exception {
        int safeLimit = Math.max(1, Math.min(limit, 200));
        int safeOffset = Math.max(0, offset);
        JSONArray items = new JSONArray();
        try (Cursor cursor = getReadableDatabase().rawQuery(
            "SELECT id, created_at, package_name, app_label, activity_id, outcome,"
                + " reason, clicked_key, clicked_class, clicked_text, duration_ms,"
                + " node_count, before_source FROM captures"
                + " ORDER BY id DESC LIMIT ? OFFSET ?",
            new String[]{String.valueOf(safeLimit), String.valueOf(safeOffset)}
        )) {
            while (cursor.moveToNext()) {
                items.put(readSummary(cursor));
            }
        }
        return items;
    }

    public JSONObject detail(long id) throws Exception {
        try (Cursor cursor = getReadableDatabase().rawQuery(
            "SELECT id, created_at, package_name, app_label, activity_id, outcome,"
                + " reason, clicked_key, clicked_class, clicked_text, duration_ms,"
                + " node_count, before_source, before_json, after_json,"
                + " before_png IS NOT NULL, after_png IS NOT NULL"
                + " FROM captures WHERE id = ?",
            new String[]{String.valueOf(id)}
        )) {
            if (!cursor.moveToNext()) return null;
            JSONObject item = readSummary(cursor);
            item.put("before", parseJson(gunzip(cursor.getBlob(13))));
            item.put("after", parseJson(gunzip(cursor.getBlob(14))));
            item.put("hasBeforeScreenshot", cursor.getInt(15) != 0);
            item.put("hasAfterScreenshot", cursor.getInt(16) != 0);
            return item;
        }
    }

    public int clear() {
        return getWritableDatabase().delete("captures", null, null);
    }

    /** 只保留最近 keep 条，避免长期使用把存储撑满。 */
    public void prune(int keep) {
        int safeKeep = Math.max(50, keep);
        getWritableDatabase().execSQL(
            "DELETE FROM captures WHERE id NOT IN"
                + " (SELECT id FROM captures ORDER BY id DESC LIMIT " + safeKeep + ")"
        );
    }

    /**
     * 导出最近 limit 条为 zip（每条一个 JSON），返回生成的临时文件。
     *
     * @param gkdChannel 应用内选择的目标 GKD 版本（stable / beta），写进 manifest 说明数据来源
     */
    public File exportZip(Context context, int limit, String gkdChannel) throws Exception {
        int safeLimit = Math.max(1, Math.min(limit, 1000));
        File target = new File(
            context.getCacheDir(),
            "skip-captures-" + System.currentTimeMillis() + ".zip"
        );
        int written = 0;
        try (
            ZipOutputStream zip = new ZipOutputStream(new FileOutputStream(target));
            Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT id, created_at, package_name, app_label, activity_id, outcome,"
                    + " reason, clicked_key, clicked_class, clicked_text, duration_ms,"
                    + " node_count, before_source, before_json, after_json"
                    + " FROM captures ORDER BY id DESC LIMIT ?",
                new String[]{String.valueOf(safeLimit)}
            )
        ) {
            while (cursor.moveToNext()) {
                JSONObject item = readSummary(cursor);
                item.put("before", parseJson(gunzip(cursor.getBlob(13))));
                item.put("after", parseJson(gunzip(cursor.getBlob(14))));
                zip.putNextEntry(new ZipEntry("captures/" + cursor.getLong(0) + ".json"));
                zip.write(item.toString().getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
                written += 1;
            }

            JSONObject manifest = new JSONObject();
            Map<String, Object> fields = SkipCaptureManifest.build(
                System.currentTimeMillis(),
                written,
                gkdChannel,
                GkdAppInfo.read(context)
            );
            for (Map.Entry<String, Object> field : fields.entrySet()) {
                manifest.put(field.getKey(), field.getValue());
            }
            zip.putNextEntry(new ZipEntry("manifest.json"));
            zip.write(manifest.toString().getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        return target;
    }

    private JSONObject readSummary(Cursor cursor) throws Exception {
        JSONObject item = new JSONObject();
        item.put("id", cursor.getLong(0));
        item.put("createdAt", cursor.getLong(1));
        item.put("packageName", cursor.isNull(2) ? "" : cursor.getString(2));
        item.put("appLabel", cursor.isNull(3) ? "" : cursor.getString(3));
        item.put("activityId", cursor.isNull(4) ? null : cursor.getString(4));
        item.put("outcome", cursor.getString(5));
        item.put("reason", cursor.isNull(6) ? "" : cursor.getString(6));
        item.put("clickedKey", cursor.isNull(7) ? "" : cursor.getString(7));
        item.put("clickedClass", cursor.isNull(8) ? "" : cursor.getString(8));
        item.put("clickedText", cursor.isNull(9) ? "" : cursor.getString(9));
        item.put("durationMs", cursor.getLong(10));
        item.put("nodeCount", cursor.getInt(11));
        item.put("beforeSource", cursor.isNull(12) ? "" : cursor.getString(12));
        item.put(
            "outcomeBasis",
            SkipCaptureJudge.outcomeBasis(
                cursor.getString(5),
                cursor.isNull(6) ? "" : cursor.getString(6)
            )
        );
        return item;
    }

    private static JSONObject parseJson(String value) {
        if (value == null) return null;
        try {
            return new JSONObject(value);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static byte[] gzipOrNull(String text) {
        if (text == null) return null;
        try {
            return gzip(text);
        } catch (IOException ignored) {
            return null;
        }
    }

    static byte[] gzip(String text) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(buffer)) {
            gzip.write(text.getBytes(StandardCharsets.UTF_8));
        }
        return buffer.toByteArray();
    }

    static String gunzip(byte[] data) throws IOException {
        if (data == null) return null;
        try (
            GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(data));
            ByteArrayOutputStream buffer = new ByteArrayOutputStream()
        ) {
            byte[] chunk = new byte[16 * 1024];
            int count;
            while ((count = gzip.read(chunk)) != -1) {
                buffer.write(chunk, 0, count);
            }
            return buffer.toString("UTF-8");
        }
    }
}
