/** 放大镜拖动时的坐标换算纯函数。
 * ScreenshotCanvas 使用它做：屏幕坐标 ↔ 图片坐标 ↔ 快照坐标的转换
 * 以及放大镜内节点框的定位（computeMagnifiedNodeRect）。 */

export interface DragLocalPoint {
  localX: number;
  localY: number;
}

export interface DragPointerPoint {
  clientX: number;
  clientY: number;
}

export function computeRelativeDragLocalPoint({
  startLocal,
  startPointer,
  currentPointer,
  imageWidth,
  imageHeight,
}: {
  startLocal: DragLocalPoint;
  startPointer: DragPointerPoint;
  currentPointer: DragPointerPoint;
  imageWidth: number;
  imageHeight: number;
}): DragLocalPoint {
  return {
    localX: clamp(
      startLocal.localX + currentPointer.clientX - startPointer.clientX,
      0,
      imageWidth,
    ),
    localY: clamp(
      startLocal.localY + currentPointer.clientY - startPointer.clientY,
      0,
      imageHeight,
    ),
  };
}

export function chooseDragStartLocalPoint({
  visibleLocal,
  savedLocal,
  fallbackLocal,
}: {
  visibleLocal: DragLocalPoint | null;
  savedLocal: DragLocalPoint | null;
  fallbackLocal: DragLocalPoint;
}): DragLocalPoint {
  return visibleLocal ?? savedLocal ?? fallbackLocal;
}

export function computeMagnifierStageCenter({
  imageOffsetLeft,
  imageOffsetTop,
  localX,
  localY,
}: {
  imageOffsetLeft: number;
  imageOffsetTop: number;
  localX: number;
  localY: number;
}): { stageX: number; stageY: number } {
  return {
    stageX: imageOffsetLeft + localX,
    stageY: imageOffsetTop + localY,
  };
}

export function computeMagnifiedNodeRect({
  nodeBounds,
  screenWidth,
  screenHeight,
  imageWidth,
  imageHeight,
  magnifierLocalX,
  magnifierLocalY,
  magnifierSize,
  zoom,
}: {
  nodeBounds: { left: number; top: number; right: number; bottom: number };
  screenWidth: number;
  screenHeight: number;
  imageWidth: number;
  imageHeight: number;
  magnifierLocalX: number;
  magnifierLocalY: number;
  magnifierSize: number;
  zoom: number;
}): { left: number; top: number; width: number; height: number } {
  const left = Math.min(nodeBounds.left, nodeBounds.right);
  const right = Math.max(nodeBounds.left, nodeBounds.right);
  const top = Math.min(nodeBounds.top, nodeBounds.bottom);
  const bottom = Math.max(nodeBounds.top, nodeBounds.bottom);
  const localLeft = (left / screenWidth) * imageWidth;
  const localTop = (top / screenHeight) * imageHeight;
  const localRight = (right / screenWidth) * imageWidth;
  const localBottom = (bottom / screenHeight) * imageHeight;

  return {
    left: magnifierSize / 2 + (localLeft - magnifierLocalX) * zoom,
    top: magnifierSize / 2 + (localTop - magnifierLocalY) * zoom,
    width: (localRight - localLeft) * zoom,
    height: (localBottom - localTop) * zoom,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return value;
  return Math.min(Math.max(value, min), max);
}
