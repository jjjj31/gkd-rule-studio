package com.gkdrulebuilder.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Map;

public class SkipCaptureManifestTest {
    @Test
    public void manifestDeclaresSchemaAndOutcomeBasis() {
        Map<String, Object> manifest = SkipCaptureManifest.build(
            1700000000000L,
            3,
            "beta",
            null
        );

        assertEquals(SkipCaptureManifest.SCHEMA_VERSION, manifest.get("schemaVersion"));
        assertEquals(1700000000000L, manifest.get("exportedAt"));
        assertEquals(3, manifest.get("records"));
        assertEquals(SkipCaptureJudge.AFTER_DELAY_MS, manifest.get("afterDelayMs"));
        assertEquals("beta", manifest.get("gkdChannel"));
        assertTrue(manifest.get("note").toString().contains("不等于 GKD 规则动作是否成功"));
        assertFalse(manifest.containsKey("gkdPackage"));
    }

    @Test
    public void manifestCarriesInstalledGkdVersion() {
        Map<String, Object> manifest = SkipCaptureManifest.build(
            1L,
            1,
            "stable",
            new GkdAppInfo.Info("li.songe.gkd", "1.13.2", 11302)
        );

        assertEquals("li.songe.gkd", manifest.get("gkdPackage"));
        assertEquals("1.13.2", manifest.get("gkdVersionName"));
        assertEquals(11302, manifest.get("gkdVersionCode"));
        assertEquals("stable", manifest.get("gkdChannel"));
    }

    @Test
    public void unknownChannelIsNotGuessed() {
        assertEquals("unknown", SkipCaptureManifest.normalizeChannel(null));
        assertEquals("unknown", SkipCaptureManifest.normalizeChannel("debug"));
        assertEquals("stable", SkipCaptureManifest.normalizeChannel("stable"));
        assertEquals("beta", SkipCaptureManifest.normalizeChannel("beta"));
    }
}
