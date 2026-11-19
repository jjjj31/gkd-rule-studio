package com.gkdrulebuilder.android;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

/**
 * 读取手机上已安装的 GKD 版本，只用于导出时标注数据来源。
 *
 * 正式版和测试版共用包名 li.songe.gkd，只有 debug 构建带 .debug 后缀，
 * 所以这里只取包名和版本号，渠道由应用内的目标版本设置决定。
 */
public final class GkdAppInfo {
    private static final String PACKAGE_STABLE = "li.songe.gkd";
    private static final String PACKAGE_DEBUG = "li.songe.gkd.debug";

    private GkdAppInfo() {
    }

    public static final class Info {
        public final String packageName;
        public final String versionName;
        public final Integer versionCode;

        Info(String packageName, String versionName, Integer versionCode) {
            this.packageName = packageName;
            this.versionName = versionName;
            this.versionCode = versionCode;
        }
    }

    /** 没装 GKD 时返回 null，导出里就不写 gkdPackage 等字段。 */
    public static Info read(Context context) {
        PackageManager manager = context.getPackageManager();
        for (String packageName : new String[]{PACKAGE_STABLE, PACKAGE_DEBUG}) {
            try {
                PackageInfo info = manager.getPackageInfo(packageName, 0);
                return new Info(packageName, info.versionName, versionCodeOf(info));
            } catch (PackageManager.NameNotFoundException ignored) {
                // 继续试下一个候选包名
            }
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    private static Integer versionCodeOf(PackageInfo info) {
        return info.versionCode;
    }
}
