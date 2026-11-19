package com.gkdrulebuilder.android;

import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * 把无障碍节点树序列化成和 GKD 快照一致的 JSON，便于后续直接喂给规则生成。
 *
 * 输出结构与 src/types/gkdSnapshot.ts 的 RawGkdSnapshot 对齐：
 * { appId, activityId, screenWidth, screenHeight, isLandscape, nodes: [...] }
 */
public final class SkipCaptureTrees {
    /** 单个快照最多保留的节点数，防止异常界面把内存打满。 */
    public static final int DEFAULT_MAX_NODES = 1200;

    private SkipCaptureTrees() {
    }

    public static final class Captured {
        public final String json;
        public final Set<String> keys;
        public final int nodeCount;

        Captured(String json, Set<String> keys, int nodeCount) {
            this.json = json;
            this.keys = keys;
            this.nodeCount = nodeCount;
        }
    }

    public static Captured capture(
        AccessibilityNodeInfo root,
        String appId,
        String activityId,
        int screenWidth,
        int screenHeight,
        int maxNodes
    ) throws Exception {
        Set<String> keys = new LinkedHashSet<>();
        JSONArray nodes = new JSONArray();
        Deque<Frame> stack = new ArrayDeque<>();
        stack.push(new Frame(root, -1, 0, 0, true));

        int nextId = 0;
        while (!stack.isEmpty() && nodes.length() < maxNodes) {
            Frame frame = stack.pop();
            AccessibilityNodeInfo node = frame.node;
            int id = nextId++;
            try {
                JSONObject attr = describe(node, frame.depth, frame.index);
                String className = node.getClassName() == null
                    ? ""
                    : node.getClassName().toString();
                String viewId = node.getViewIdResourceName();
                String vid = shortVid(viewId);
                String text = stringOf(node.getText());
                String desc = stringOf(node.getContentDescription());
                keys.add(SkipCaptureJudge.nodeKey(
                    vid,
                    viewId,
                    text,
                    desc,
                    className,
                    attr.optInt("width", 0),
                    attr.optInt("height", 0),
                    frame.index
                ));

                JSONObject item = new JSONObject();
                item.put("id", id);
                item.put("pid", frame.parentId);
                item.put("idQf", vid != null);
                item.put("textQf", text != null && text.length() > 0);
                item.put("attr", attr);
                nodes.put(item);

                int childCount = node.getChildCount();
                for (int index = childCount - 1; index >= 0; index -= 1) {
                    AccessibilityNodeInfo child = node.getChild(index);
                    if (child != null) {
                        stack.push(new Frame(child, id, frame.depth + 1, index, false));
                    }
                }
            } finally {
                recycle(node, frame.isRoot);
            }
        }

        JSONObject snapshot = new JSONObject();
        snapshot.put("id", System.currentTimeMillis());
        snapshot.put("appId", appId == null ? "" : appId);
        snapshot.put("activityId", activityId);
        snapshot.put("screenWidth", screenWidth);
        snapshot.put("screenHeight", screenHeight);
        snapshot.put("isLandscape", screenWidth > screenHeight);
        snapshot.put("nodes", nodes);
        return new Captured(snapshot.toString(), keys, nodes.length());
    }

    /** 与 GKD 快照一致：vid 是资源名的短名，id 是完整 resource name。 */
    static String shortVid(String viewIdResourceName) {
        if (viewIdResourceName == null) return null;
        int slash = viewIdResourceName.indexOf('/');
        return slash >= 0 ? viewIdResourceName.substring(slash + 1) : viewIdResourceName;
    }

    private static JSONObject describe(
        AccessibilityNodeInfo node,
        int depth,
        int index
    ) throws Exception {
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        JSONObject attr = new JSONObject();
        attr.put("id", node.getViewIdResourceName());
        attr.put("vid", shortVid(node.getViewIdResourceName()));
        attr.put("name", node.getClassName() == null ? "" : node.getClassName().toString());
        attr.put("text", node.getText() == null ? null : node.getText().toString());
        attr.put(
            "desc",
            node.getContentDescription() == null
                ? null
                : node.getContentDescription().toString()
        );
        attr.put("clickable", node.isClickable());
        attr.put("focusable", node.isFocusable());
        attr.put("checkable", node.isCheckable());
        attr.put("checked", node.isChecked());
        attr.put("editable", node.isEditable());
        attr.put("longClickable", node.isLongClickable());
        attr.put("visibleToUser", node.isVisibleToUser());
        attr.put("left", bounds.left);
        attr.put("top", bounds.top);
        attr.put("right", bounds.right);
        attr.put("bottom", bounds.bottom);
        attr.put("width", Math.max(0, bounds.width()));
        attr.put("height", Math.max(0, bounds.height()));
        attr.put("childCount", node.getChildCount());
        attr.put("index", index);
        attr.put("depth", depth);
        return attr;
    }

    private static String stringOf(CharSequence value) {
        return value == null ? null : value.toString();
    }

    private static void recycle(AccessibilityNodeInfo node, boolean isRoot) {
        if (node == null || isRoot) return;
        if (Build.VERSION.SDK_INT < 33) {
            node.recycle();
        }
    }

    private static final class Frame {
        final AccessibilityNodeInfo node;
        final int parentId;
        final int depth;
        final int index;
        final boolean isRoot;

        Frame(AccessibilityNodeInfo node, int parentId, int depth, int index, boolean isRoot) {
            this.node = node;
            this.parentId = parentId;
            this.depth = depth;
            this.index = index;
            this.isRoot = isRoot;
        }
    }
}
