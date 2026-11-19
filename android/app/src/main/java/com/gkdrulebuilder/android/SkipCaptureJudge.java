package com.gkdrulebuilder.android;

import java.util.List;

/**
 * 纯逻辑：把被点击的控件压成一个可比较的键，并判断点击后它是否消失。
 *
 * 抽出来是为了能在 JVM 单测里覆盖，不依赖 Android 的 AccessibilityNodeInfo。
 */
public final class SkipCaptureJudge {
    /** 点击后复查的等待时间；服务用它调度，导出时也写进 outcomeBasis。 */
    public static final long AFTER_DELAY_MS = 1500L;

    public static final String OUTCOME_SUCCESS = "success";
    public static final String OUTCOME_FAILURE = "failure";
    public static final String OUTCOME_UNKNOWN = "unknown";

    public static final String REASON_NODE_GONE = "node-gone";
    public static final String REASON_WINDOW_CHANGED = "window-changed";
    public static final String REASON_NODE_STILL_THERE = "node-still-there";
    public static final String REASON_AMBIGUOUS_WINDOW = "ambiguous-window-change";
    public static final String REASON_BEFORE_MISS = "before-miss";
    public static final String REASON_NO_AFTER = "no-after";

    public static final String BASIS_NODE_ABSENT = "node_absent_after_" + AFTER_DELAY_MS + "ms";
    public static final String BASIS_NODE_PRESENT = "node_present_after_" + AFTER_DELAY_MS + "ms";
    public static final String BASIS_BEFORE_MISS = "before_snapshot_miss";
    public static final String BASIS_AFTER_MISS = "after_snapshot_miss";
    public static final String BASIS_AMBIGUOUS_WINDOW = "ambiguous_window_change";
    public static final String BASIS_UNKNOWN = "unknown";

    private SkipCaptureJudge() {
    }

    public static final class Verdict {
        public final String outcome;
        public final String reason;

        Verdict(String outcome, String reason) {
            this.outcome = outcome;
            this.reason = reason;
        }
    }

    /**
     * 控件标识优先级：vid > 资源 id > 文字 > 描述 > 结构。
     * 结构键只在没有任何语义属性时使用，稳定性最差。
     */
    public static String nodeKey(
        String vid,
        String viewId,
        String text,
        String desc,
        String className,
        int width,
        int height,
        int index
    ) {
        if (isNotBlank(vid)) return "vid:" + vid.trim();
        if (isNotBlank(viewId)) return "id:" + viewId.trim();
        if (isNotBlank(text)) return "text:" + text.trim() + "|" + simpleClass(className);
        if (isNotBlank(desc)) return "desc:" + desc.trim() + "|" + simpleClass(className);
        return "struct:" + simpleClass(className) + "|" + Math.max(0, width) + "x"
            + Math.max(0, height) + "|" + index;
    }

    public static String simpleClass(String className) {
        if (className == null) return "";
        int dot = className.lastIndexOf('.');
        return dot >= 0 ? className.substring(dot + 1) : className;
    }

    public static boolean isNotBlank(String value) {
        return value != null && value.trim().length() > 0;
    }

    /**
     * @param beforeFound 点击前快照里能否找到被点控件；找不到说明抓晚了
     * @param afterKeys   点击后快照里所有控件的键
     * @param windowChanged 点击后窗口/Activity 是否变化
     */
    public static Verdict judge(
        boolean beforeFound,
        String key,
        List<String> afterKeys,
        boolean windowChanged
    ) {
        if (!beforeFound || !isNotBlank(key)) {
            return new Verdict(OUTCOME_UNKNOWN, REASON_BEFORE_MISS);
        }
        if (afterKeys == null) {
            return new Verdict(OUTCOME_UNKNOWN, REASON_NO_AFTER);
        }
        if (!afterKeys.contains(key)) {
            return new Verdict(OUTCOME_SUCCESS, REASON_NODE_GONE);
        }
        if (windowChanged) {
            // 控件还在、页面又换了：分不清是跳转型广告还是新页面里有同名控件，
            // 宁可丢样本也不要把误判写成成功。
            return new Verdict(OUTCOME_UNKNOWN, REASON_AMBIGUOUS_WINDOW);
        }
        return new Verdict(OUTCOME_FAILURE, REASON_NODE_STILL_THERE);
    }

    /**
     * 把判定结果翻译成下游可读的「依据」，避免把 success 误读成 GKD 规则动作成功。
     */
    public static String outcomeBasis(String outcome, String reason) {
        if (OUTCOME_SUCCESS.equals(outcome)) return BASIS_NODE_ABSENT;
        if (OUTCOME_FAILURE.equals(outcome)) return BASIS_NODE_PRESENT;
        if (REASON_BEFORE_MISS.equals(reason)) return BASIS_BEFORE_MISS;
        if (REASON_NO_AFTER.equals(reason)) return BASIS_AFTER_MISS;
        if (REASON_AMBIGUOUS_WINDOW.equals(reason)) return BASIS_AMBIGUOUS_WINDOW;
        return BASIS_UNKNOWN;
    }
}
