package com.gkdrulebuilder.android;

import java.lang.ref.WeakReference;

/** 记录无障碍服务是否已连接，供桥接层查询状态。 */
public final class SkipCaptureRuntime {
    private static volatile WeakReference<SkipCaptureService> service;

    private SkipCaptureRuntime() {
    }

    static void attach(SkipCaptureService instance) {
        service = new WeakReference<>(instance);
    }

    static void detach(SkipCaptureService instance) {
        WeakReference<SkipCaptureService> current = service;
        if (current != null && current.get() == instance) {
            service = null;
        }
    }

    public static boolean isConnected() {
        WeakReference<SkipCaptureService> current = service;
        return current != null && current.get() != null;
    }
}
