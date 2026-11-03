package com.gkdrulebuilder.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class FeedbackDiagnosticsTest {
    @Test
    public void systemVersionContainsOnlyExpectedBuildFields() {
        assertEquals(
            "Google Pixel 9; Android 16 (SDK 36)",
            FeedbackDiagnostics.formatSystemVersion(" Google ", "Pixel 9", "16", 36)
        );
    }

    @Test
    public void crashRetentionExpiresAtSevenDays() {
        long modifiedAt = 1_000L;
        assertFalse(
            FeedbackDiagnostics.isExpired(
                modifiedAt,
                modifiedAt + FeedbackDiagnostics.CRASH_RETENTION_MILLIS - 1
            )
        );
        assertTrue(
            FeedbackDiagnostics.isExpired(
                modifiedAt,
                modifiedAt + FeedbackDiagnostics.CRASH_RETENTION_MILLIS
            )
        );
    }

    @Test
    public void utf8TruncationDropsACharacterThatWouldExceedTheByteLimit() {
        assertEquals("A", FeedbackDiagnostics.truncateUtf8("A\uD83D\uDE00B", 4));
        assertEquals("A\uD83D\uDE00", FeedbackDiagnostics.truncateUtf8("A\uD83D\uDE00B", 5));
    }

    @Test
    public void diagnosticsJsonEscapesStackTextAndKeepsBothFields() {
        assertEquals(
            "{\"systemVersion\":\"Pixel 9\\nAndroid 16\",\"lastCrash\":\"bad \\\"value\\\"\"}",
            FeedbackDiagnostics.diagnosticsJson(
                "Pixel 9\nAndroid 16",
                "bad \"value\""
            )
        );
    }

    @Test
    public void crashSummaryStartsWithTheException() {
        String crash = FeedbackDiagnostics.formatCrash(
            new IllegalStateException("diagnostic test")
        );
        assertTrue(crash.startsWith("java.lang.IllegalStateException: diagnostic test"));
        assertTrue(crash.contains("FeedbackDiagnosticsTest"));
    }
}
