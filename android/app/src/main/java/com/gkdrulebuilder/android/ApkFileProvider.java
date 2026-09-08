package com.gkdrulebuilder.android;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简文件 provider:只用来把下载好的 APK 以 content:// 暴露给系统安装器。
 * URI 规则:content://com.gkdrulebuilder.android.apkprovider/<绝对路径>。
 * 不引入 androidx,安装 APK 只需 openFile 一个能力。
 */
public class ApkFileProvider extends ContentProvider {
    public static final String AUTHORITY = "com.gkdrulebuilder.android.apkprovider";

    /** 应用外部私有目录前缀,openFile 只允许此目录下的文件。 */
    private String allowedPrefix;

    @Override
    public boolean onCreate() {
        File externalDir = getContext().getExternalFilesDir(null);
        if (externalDir != null) {
            allowedPrefix = externalDir.getAbsolutePath();
        } else {
            allowedPrefix = getContext().getFilesDir().getAbsolutePath();
        }
        return true;
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String path = uri.getPath();
        if (path == null) {
            throw new FileNotFoundException("无文件路径");
        }
        File file = new File(path);
        // 边界检查:只允许访问应用私有下载目录下的文件
        if (!file.getAbsolutePath().startsWith(allowedPrefix)) {
            throw new FileNotFoundException("访问被拒绝:" + path);
        }
        if (!file.exists()) {
            throw new FileNotFoundException("文件不存在:" + path);
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(
        Uri uri,
        String[] projection,
        String selection,
        String[] selectionArgs,
        String sortOrder
    ) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}