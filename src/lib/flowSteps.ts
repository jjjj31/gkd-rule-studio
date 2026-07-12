/** 纯函数辅助：相邻步骤/快照 id 查找、流程创建条件判断。被 DesktopApp 和 AndroidLiteApp 共用。 */

export interface FlowStepLike {
  id: string;
}

export interface FlowSnapshotLike {
  id: number;
}

export interface SnapshotFlowCreationState {
  hasHttpClient: boolean;
  hasAdbClient: boolean;
  selectedCount: number;
  openingFlow: boolean;
}

export function getAdjacentFlowStepId(
  steps: FlowStepLike[],
  activeStepId: string | null,
  direction: -1 | 1,
): string | null {
  if (!activeStepId) return null;
  const index = steps.findIndex((step) => step.id === activeStepId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= steps.length) {
    return null;
  }
  return steps[nextIndex].id;
}

export function getAdjacentFlowSnapshotId(
  snapshots: FlowSnapshotLike[],
  currentSnapshotId: number | null,
  direction: -1 | 1,
): number | null {
  if (currentSnapshotId === null) return null;
  const index = snapshots.findIndex((snapshot) => snapshot.id === currentSnapshotId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= snapshots.length) {
    return null;
  }
  return snapshots[nextIndex].id;
}

export function canCreateSnapshotFlow({
  hasHttpClient,
  hasAdbClient,
  selectedCount,
  openingFlow,
}: SnapshotFlowCreationState): boolean {
  return (hasHttpClient || hasAdbClient) && selectedCount > 0 && !openingFlow;
}

export function getSelectedFlowSnapshotIds(
  snapshots: FlowSnapshotLike[],
  selectedIds: Set<number>,
): number[] {
  return snapshots
    .filter((snapshot) => selectedIds.has(snapshot.id))
    .map((snapshot) => snapshot.id);
}
