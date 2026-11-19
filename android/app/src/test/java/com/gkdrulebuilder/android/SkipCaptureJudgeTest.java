package com.gkdrulebuilder.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

public class SkipCaptureJudgeTest {
    @Test
    public void nodeKeyPrefersVidThenIdThenTextThenDesc() {
        assertEquals(
            "vid:close_button",
            SkipCaptureJudge.nodeKey(
                "close_button",
                "com.demo:id/close_button",
                "关闭",
                "关闭广告",
                "android.widget.Button",
                90,
                40,
                1
            )
        );
        assertEquals(
            "id:com.demo:id/close_button",
            SkipCaptureJudge.nodeKey(
                null,
                "com.demo:id/close_button",
                "关闭",
                "关闭广告",
                "android.widget.Button",
                90,
                40,
                1
            )
        );
        assertEquals(
            "text:关闭|Button",
            SkipCaptureJudge.nodeKey(
                null,
                null,
                "关闭",
                "关闭广告",
                "android.widget.Button",
                90,
                40,
                1
            )
        );
        assertEquals(
            "desc:关闭广告|ImageView",
            SkipCaptureJudge.nodeKey(
                null,
                null,
                null,
                "关闭广告",
                "android.widget.ImageView",
                40,
                40,
                2
            )
        );
    }

    @Test
    public void structuralKeyUsesSizeAndIndex() {
        assertEquals(
            "struct:View|120x80|3",
            SkipCaptureJudge.nodeKey(
                null,
                null,
                "  ",
                null,
                "android.view.View",
                120,
                80,
                3
            )
        );
    }

    @Test
    public void simpleClassStripsPackage() {
        assertEquals(
            "LinearLayout",
            SkipCaptureJudge.simpleClass("android.widget.LinearLayout")
        );
        assertEquals("", SkipCaptureJudge.simpleClass(null));
    }

    @Test
    public void judgeTreatsGoneNodeAsSuccess() {
        SkipCaptureJudge.Verdict verdict = SkipCaptureJudge.judge(
            true,
            "vid:close_button",
            Arrays.asList("vid:other", "text:跳过|TextView"),
            false
        );
        assertEquals(SkipCaptureJudge.OUTCOME_SUCCESS, verdict.outcome);
        assertEquals(SkipCaptureJudge.REASON_NODE_GONE, verdict.reason);
    }

    @Test
    public void judgeTreatsStillPresentNodeAsFailure() {
        SkipCaptureJudge.Verdict verdict = SkipCaptureJudge.judge(
            true,
            "vid:close_button",
            Collections.singletonList("vid:close_button"),
            false
        );
        assertEquals(SkipCaptureJudge.OUTCOME_FAILURE, verdict.outcome);
        assertEquals(SkipCaptureJudge.REASON_NODE_STILL_THERE, verdict.reason);
    }

    @Test
    public void judgeKeepsAmbiguousWindowChangeOutOfTrainingData() {
        SkipCaptureJudge.Verdict verdict = SkipCaptureJudge.judge(
            true,
            "vid:close_button",
            Collections.singletonList("vid:close_button"),
            true
        );
        assertEquals(SkipCaptureJudge.OUTCOME_UNKNOWN, verdict.outcome);
        assertEquals(SkipCaptureJudge.REASON_AMBIGUOUS_WINDOW, verdict.reason);
    }

    @Test
    public void judgeRejectsMissingBeforeTree() {
        SkipCaptureJudge.Verdict verdict = SkipCaptureJudge.judge(
            false,
            "vid:close_button",
            Collections.<String>emptyList(),
            false
        );
        assertEquals(SkipCaptureJudge.OUTCOME_UNKNOWN, verdict.outcome);
        assertEquals(SkipCaptureJudge.REASON_BEFORE_MISS, verdict.reason);
        assertFalse(verdict.reason.isEmpty());
    }

    @Test
    public void judgeRejectsMissingAfterTree() {
        SkipCaptureJudge.Verdict verdict = SkipCaptureJudge.judge(
            true,
            "vid:close_button",
            null,
            false
        );
        assertEquals(SkipCaptureJudge.OUTCOME_UNKNOWN, verdict.outcome);
        assertEquals(SkipCaptureJudge.REASON_NO_AFTER, verdict.reason);
        assertTrue(verdict.outcome.equals(SkipCaptureJudge.OUTCOME_UNKNOWN));
    }

    @Test
    public void outcomeBasisNamesTheActualCriterion() {
        assertEquals(
            "node_absent_after_1500ms",
            SkipCaptureJudge.outcomeBasis(
                SkipCaptureJudge.OUTCOME_SUCCESS,
                SkipCaptureJudge.REASON_NODE_GONE
            )
        );
        assertEquals(
            "node_present_after_1500ms",
            SkipCaptureJudge.outcomeBasis(
                SkipCaptureJudge.OUTCOME_FAILURE,
                SkipCaptureJudge.REASON_NODE_STILL_THERE
            )
        );
        assertEquals(
            "before_snapshot_miss",
            SkipCaptureJudge.outcomeBasis(
                SkipCaptureJudge.OUTCOME_UNKNOWN,
                SkipCaptureJudge.REASON_BEFORE_MISS
            )
        );
        assertEquals(
            "after_snapshot_miss",
            SkipCaptureJudge.outcomeBasis(
                SkipCaptureJudge.OUTCOME_UNKNOWN,
                SkipCaptureJudge.REASON_NO_AFTER
            )
        );
        assertEquals(
            "ambiguous_window_change",
            SkipCaptureJudge.outcomeBasis(
                SkipCaptureJudge.OUTCOME_UNKNOWN,
                SkipCaptureJudge.REASON_AMBIGUOUS_WINDOW
            )
        );
        assertEquals(
            "unknown",
            SkipCaptureJudge.outcomeBasis(SkipCaptureJudge.OUTCOME_UNKNOWN, "other")
        );
    }
}
