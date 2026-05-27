import { describe, expect, it } from "vitest";
import {
  canCreateSnapshotFlow,
  getAdjacentFlowSnapshotId,
  getAdjacentFlowStepId,
  getSelectedFlowSnapshotIds,
} from "./flowSteps";

describe("flow step navigation", () => {
  const steps = [
    { id: "first" },
    { id: "second" },
    { id: "third" },
  ];

  it("returns previous and next step ids around the active step", () => {
    expect(getAdjacentFlowStepId(steps, "second", -1)).toBe("first");
    expect(getAdjacentFlowStepId(steps, "second", 1)).toBe("third");
  });

  it("returns null at boundaries or without an active step", () => {
    expect(getAdjacentFlowStepId(steps, "first", -1)).toBeNull();
    expect(getAdjacentFlowStepId(steps, "third", 1)).toBeNull();
    expect(getAdjacentFlowStepId(steps, null, 1)).toBeNull();
    expect(getAdjacentFlowStepId(steps, "missing", 1)).toBeNull();
  });
});

describe("flow snapshot navigation", () => {
  const snapshots = [
    { id: 101 },
    { id: 102 },
    { id: 103 },
  ];

  it("returns previous and next snapshot ids around the current snapshot", () => {
    expect(getAdjacentFlowSnapshotId(snapshots, 102, -1)).toBe(101);
    expect(getAdjacentFlowSnapshotId(snapshots, 102, 1)).toBe(103);
  });

  it("returns null at boundaries or when current snapshot is not in the pool", () => {
    expect(getAdjacentFlowSnapshotId(snapshots, 101, -1)).toBeNull();
    expect(getAdjacentFlowSnapshotId(snapshots, 103, 1)).toBeNull();
    expect(getAdjacentFlowSnapshotId(snapshots, 999, 1)).toBeNull();
    expect(getAdjacentFlowSnapshotId([], 101, 1)).toBeNull();
  });
});

describe("flow creation controls", () => {
  it("allows creating a flow from either HTTP or ADB snapshots", () => {
    expect(
      canCreateSnapshotFlow({
        hasHttpClient: true,
        hasAdbClient: false,
        selectedCount: 2,
        openingFlow: false,
      }),
    ).toBe(true);
    expect(
      canCreateSnapshotFlow({
        hasHttpClient: false,
        hasAdbClient: true,
        selectedCount: 2,
        openingFlow: false,
      }),
    ).toBe(true);
  });

  it("keeps the create flow button disabled without a client, selection, or while loading", () => {
    expect(
      canCreateSnapshotFlow({
        hasHttpClient: false,
        hasAdbClient: false,
        selectedCount: 2,
        openingFlow: false,
      }),
    ).toBe(false);
    expect(
      canCreateSnapshotFlow({
        hasHttpClient: true,
        hasAdbClient: false,
        selectedCount: 0,
        openingFlow: false,
      }),
    ).toBe(false);
    expect(
      canCreateSnapshotFlow({
        hasHttpClient: false,
        hasAdbClient: true,
        selectedCount: 2,
        openingFlow: true,
      }),
    ).toBe(false);
  });

  it("loads selected flow snapshots from the full snapshot list, not only the filtered view", () => {
    expect(
      getSelectedFlowSnapshotIds(
        [{ id: 101 }, { id: 102 }, { id: 103 }],
        new Set([103, 101]),
      ),
    ).toEqual([101, 103]);
  });
});
