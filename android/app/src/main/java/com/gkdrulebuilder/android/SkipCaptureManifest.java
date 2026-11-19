package com.gkdrulebuilder.android;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 导出 zip 里 manifest.json 的内容。
 *
 * 抽成纯函数是为了能在 JVM 单测里覆盖，不依赖 Android 的 org.json。
 */
public final class SkipCaptureManifest {
    /** 1：exportedAt/records/note；2：加 schemaVersion、afterDelayMs、gkd* 与逐条 outcomeBasis。 */
    public static final int SCHEMA_VERSION = 2;

    public static final String CHANNEL_STABLE = "stable";
    public static final String CHANNEL_BETA = "beta";
    public static final String CHANNEL_UNKNOWN = "unknown";

    public static final String NOTE =
        "每条记录包含点击前/后的无障碍树；before 是点击前的界面，用于生成规则。"
            + "outcome 是「被点控件是否消失」的判定，不等于 GKD 规则动作是否成功。";

    private SkipCaptureManifest() {
    }

    /** 只接受应用内已有的两个渠道值，其它一律写成 unknown。 */
    public static String normalizeChannel(String channel) {
        if (CHANNEL_BETA.equals(channel)) return CHANNEL_BETA;
        if (CHANNEL_STABLE.equals(channel)) return CHANNEL_STABLE;
        return CHANNEL_UNKNOWN;
    }

    public static Map<String, Object> build(
        long exportedAt,
        int records,
        String gkdChannel,
        GkdAppInfo.Info gkd
    ) {
        LinkedHashMap<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("schemaVersion", SCHEMA_VERSION);
        manifest.put("exportedAt", exportedAt);
        manifest.put("records", records);
        manifest.put("afterDelayMs", SkipCaptureJudge.AFTER_DELAY_MS);
        manifest.put("gkdChannel", normalizeChannel(gkdChannel));
        if (gkd != null) {
            if (gkd.packageName != null) manifest.put("gkdPackage", gkd.packageName);
            if (gkd.versionName != null) manifest.put("gkdVersionName", gkd.versionName);
            if (gkd.versionCode != null) manifest.put("gkdVersionCode", gkd.versionCode);
        }
        manifest.put("note", NOTE);
        return manifest;
    }
}
