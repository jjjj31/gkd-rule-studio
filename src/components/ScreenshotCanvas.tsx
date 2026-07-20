/**
 * 截图画布组件。
 * 显示 gkd 快照的截图，支持两种交互模式：
 * - click（桌面版）：鼠标点一下 = 选中目标
 * - dragMagnifier（安卓版）：手指拖动一个 2.6 倍放大镜，松手 = 选中目标
 * 选中后绘制节点框（picked/hit/support 三种颜色）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import {
  chooseDragStartLocalPoint,
  computeMagnifiedNodeRect,
  computeMagnifierStageCenter,
  computeRelativeDragLocalPoint,
  type DragLocalPoint,
} from "../lib/dragMagnifier";
import type {
  NodePickResult,
  NodePoint,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { SelectorCandidate, SelectorValidation } from "../types/ruleDraft";

interface ScreenshotCanvasProps {
  snapshot: ParsedGkdSnapshot;
  pickResult: NodePickResult | null;
  selectedCandidate: SelectorCandidate | null;
  aiValidation?: SelectorValidation | null;
  interactionMode?: "click" | "dragMagnifier";
  onPointSelected: (point: NodePoint) => void;
}

export function ScreenshotCanvas({
  snapshot,
  pickResult,
  selectedCandidate,
  aiValidation,
  interactionMode = "click",
  onPointSelected,
}: ScreenshotCanvasProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragPointerIdRef = useRef<number | null>(null);
  const lastDragPointRef = useRef<NodePoint | null>(null);
  const dragStartRef = useRef<DragStartState | null>(null);
  const savedMagnifierLocalRef = useRef<DragLocalPoint | null>(null);
  const hideMagnifierTimerRef = useRef<ReturnType<
    typeof window.setTimeout
  > | null>(null);
  const dragWatchdogTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(
    null,
  );
  const [imageBox, setImageBox] = useState<ImageBox | null>(null);
  const [magnifier, setMagnifier] = useState<MagnifierState | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const nextTouchIsScrollRef = useRef(false);

  useLayoutEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    savedMagnifierLocalRef.current = null;
    clearHideMagnifierTimer();

    const updateImageBox = () => setImageBox(getContainedImageBox(img));
    updateImageBox();

    const observer = new ResizeObserver(updateImageBox);
    observer.observe(img);
    window.addEventListener("resize", updateImageBox);

    return () => {
      clearHideMagnifierTimer();
      observer.disconnect();
      window.removeEventListener("resize", updateImageBox);
    };
  }, [snapshot.screenshotUrl]);

  useEffect(() => {
    const release = () => releaseDragCapture(true);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("touchend", release);
    window.addEventListener("touchcancel", release);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      clearIdleTimer();
      releaseDragCapture(true);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, []);

  function handleClick(event: MouseEvent<HTMLDivElement>): void {
    if (interactionMode === "dragMagnifier") return;
    const img = imgRef.current;
    if (!img) return;

    const box = getContainedImageBox(img);
    setImageBox(box);

    const point = toSnapshotPointFromClient(
      event.clientX,
      event.clientY,
      event.currentTarget,
      box,
      snapshot,
    );
    if (!point) return;

    onPointSelected(point);
  }

  function handleMouseMove(event: MouseEvent<HTMLDivElement>): void {
    if (interactionMode === "dragMagnifier") return;
    const img = imgRef.current;
    if (!img) return;

    const box = imageBox ?? getContainedImageBox(img);
    updateMagnifierFromClient(event.clientX, event.clientY, event.currentTarget, box);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (interactionMode !== "dragMagnifier") return;

    clearIdleTimer();

    if (nextTouchIsScrollRef.current) {
      nextTouchIsScrollRef.current = false;
      event.currentTarget.style.touchAction = "pan-y";
      return;
    }

    event.preventDefault();
    event.currentTarget.style.touchAction = "none";

    const img = imgRef.current;
    if (!img) return;

    const box = getContainedImageBox(img);
    setImageBox(box);
    clearHideMagnifierTimer();
    clearDragWatchdogTimer();
    dragPointerIdRef.current = event.pointerId;
    dragStartRef.current = {
      localPoint: getDragStartLocalPoint(
        box,
        magnifier,
        savedMagnifierLocalRef.current,
        pickResult,
        snapshot,
      ),
      pointer: {
        clientX: event.clientX,
        clientY: event.clientY,
      },
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Android WebView may reject capture during interrupted touch sequences.
    }
    dragWatchdogTimerRef.current = window.setTimeout(() => {
      releaseDragCapture(false);
    }, 8000);
    lastDragPointRef.current = updateMagnifierFromLocalPoint(
      dragStartRef.current.localPoint,
      box,
    );
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (
      interactionMode !== "dragMagnifier" ||
      dragPointerIdRef.current !== event.pointerId
    ) {
      return;
    }
    event.preventDefault();

    const img = imgRef.current;
    const dragStart = dragStartRef.current;
    if (!img || !dragStart) return;

    const box = imageBox ?? getContainedImageBox(img);
    lastDragPointRef.current = updateMagnifierFromLocalPoint(
      computeRelativeDragLocalPoint({
        startLocal: dragStart.localPoint,
        startPointer: dragStart.pointer,
        currentPointer: {
          clientX: event.clientX,
          clientY: event.clientY,
        },
        imageWidth: box.width,
        imageHeight: box.height,
      }),
      box,
    );
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
    if (interactionMode !== "dragMagnifier") return;

    // Cooldown scroll touch ended — reset touch-action
    if (dragPointerIdRef.current === null) {
      event.currentTarget.style.touchAction = "";
      return;
    }

    if (dragPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();

    const img = imgRef.current;
    const dragStart = dragStartRef.current;
    const box = img ? imageBox ?? getContainedImageBox(img) : null;
    const nextPoint =
      box && dragStart
        ? updateMagnifierFromLocalPoint(
          computeRelativeDragLocalPoint({
            startLocal: dragStart.localPoint,
            startPointer: dragStart.pointer,
            currentPointer: {
              clientX: event.clientX,
              clientY: event.clientY,
            },
            imageWidth: box.width,
            imageHeight: box.height,
          }),
          box,
        )
      : lastDragPointRef.current;

    releaseDragCapture(false);
    if (nextPoint) {
      onPointSelected(nextPoint);
      scheduleHideMagnifier();
      startIdleCooldown();
    }
  }

  function handlePointerCancel(event: PointerEvent<HTMLDivElement>): void {
    if (interactionMode !== "dragMagnifier") return;

    if (dragPointerIdRef.current === null) {
      event.currentTarget.style.touchAction = "";
      return;
    }

    if (dragPointerIdRef.current !== event.pointerId) return;
    releaseDragCapture(true);
  }

  function releaseDragCapture(hideMagnifier: boolean): void {
    const pointerId = dragPointerIdRef.current;
    const stage = stageRef.current;
    if (pointerId !== null && stage?.hasPointerCapture(pointerId)) {
      try {
        stage.releasePointerCapture(pointerId);
      } catch {
        // Capture may already be gone after WebView cancellation.
      }
    }
    clearDragWatchdogTimer();
    dragPointerIdRef.current = null;
    dragStartRef.current = null;
    lastDragPointRef.current = null;
    if (stage) {
      stage.style.touchAction = "";
    }
    if (hideMagnifier) setMagnifier(null);
    if (!hideMagnifier) startIdleCooldown();
  }

  function clearDragWatchdogTimer(): void {
    if (dragWatchdogTimerRef.current === null) return;
    window.clearTimeout(dragWatchdogTimerRef.current);
    dragWatchdogTimerRef.current = null;
  }

  function clearHideMagnifierTimer(): void {
    if (hideMagnifierTimerRef.current === null) return;
    window.clearTimeout(hideMagnifierTimerRef.current);
    hideMagnifierTimerRef.current = null;
  }

  function scheduleHideMagnifier(): void {
    clearHideMagnifierTimer();
    hideMagnifierTimerRef.current = window.setTimeout(() => {
      setMagnifier(null);
      hideMagnifierTimerRef.current = null;
    }, 2000);
  }

  function clearIdleTimer(): void {
    if (idleTimerRef.current === null) return;
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  }

  function startIdleCooldown(): void {
    clearIdleTimer();
    idleTimerRef.current = window.setTimeout(() => {
      nextTouchIsScrollRef.current = true;
      idleTimerRef.current = null;
    }, 2000);
  }

  function updateMagnifierFromClient(
    clientX: number,
    clientY: number,
    stage: HTMLDivElement,
    box: ImageBox,
  ): NodePoint | null {
    const localPoint = toLocalImagePointFromClient(clientX, clientY, stage, box);
    if (!localPoint) {
      setMagnifier(null);
      return null;
    }

    const snapshotPoint = localPointToSnapshotPoint(localPoint, box, snapshot);
    const center = computeMagnifierStageCenter({
      imageOffsetLeft: box.offsetLeft,
      imageOffsetTop: box.offsetTop,
      localX: localPoint.localX,
      localY: localPoint.localY,
    });

    setMagnifier({
      localX: localPoint.localX,
      localY: localPoint.localY,
      stageX: center.stageX,
      stageY: center.stageY,
      snapshotX: snapshotPoint.x,
      snapshotY: snapshotPoint.y,
    });

    return snapshotPoint;
  }

  function updateMagnifierFromLocalPoint(
    localPoint: { localX: number; localY: number },
    box: ImageBox,
  ): NodePoint {
    savedMagnifierLocalRef.current = {
      localX: localPoint.localX,
      localY: localPoint.localY,
    };
    const snapshotPoint = localPointToSnapshotPoint(localPoint, box, snapshot);
    const center = computeMagnifierStageCenter({
      imageOffsetLeft: box.offsetLeft,
      imageOffsetTop: box.offsetTop,
      localX: localPoint.localX,
      localY: localPoint.localY,
    });

    setMagnifier({
      localX: localPoint.localX,
      localY: localPoint.localY,
      stageX: center.stageX,
      stageY: center.stageY,
      snapshotX: snapshotPoint.x,
      snapshotY: snapshotPoint.y,
    });

    return snapshotPoint;
  }

  return (
    <div className="screenshot-shell">
      <div
        ref={stageRef}
        className={`screenshot-stage ${
          interactionMode === "dragMagnifier" ? "screenshot-stage-drag" : ""
        } ${magnifier ? "screenshot-stage-magnifying" : ""}`}
        onClick={handleClick}
        onMouseLeave={() => {
          if (interactionMode !== "dragMagnifier") setMagnifier(null);
        }}
        onMouseMove={handleMouseMove}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <img
          ref={imgRef}
          alt="GKD snapshot"
          className="screenshot-image"
          src={snapshot.screenshotUrl}
          onLoad={() => {
            const img = imgRef.current;
            if (img) setImageBox(getContainedImageBox(img));
          }}
        />
        {imageBox &&
          effectiveValidation(selectedCandidate, aiValidation).supportNodes.map((node) => (
            <NodeRect
              key={`support-${node.id}`}
              box={imageBox}
              kind="support"
              node={node}
              snapshot={snapshot}
            />
          ))}
        {imageBox &&
          effectiveValidation(selectedCandidate, aiValidation).clickNodes.map((node) => (
            <NodeRect
              key={`hit-${node.id}`}
              box={imageBox}
              kind="hit"
              node={node}
              snapshot={snapshot}
            />
          ))}
        {imageBox && pickResult && (
          <NodeRect
            box={imageBox}
            kind="picked"
            node={pickResult.pickedNode}
            snapshot={snapshot}
          />
        )}
        {imageBox && magnifier && (
          <Magnifier
            box={imageBox}
            magnifier={magnifier}
            overlayNodes={buildMagnifierOverlayNodes(pickResult, selectedCandidate, aiValidation)}
            screenshotUrl={snapshot.screenshotUrl}
            snapshot={snapshot}
          />
        )}
      </div>
    </div>
  );
}

interface ImageBox {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

interface MagnifierState {
  localX: number;
  localY: number;
  stageX: number;
  stageY: number;
  snapshotX: number;
  snapshotY: number;
}

interface DragStartState {
  localPoint: DragLocalPoint;
  pointer: { clientX: number; clientY: number };
}

function Magnifier({
  magnifier,
  screenshotUrl,
  snapshot,
  box,
  overlayNodes,
}: {
  magnifier: MagnifierState;
  screenshotUrl: string;
  snapshot: ParsedGkdSnapshot;
  box: ImageBox;
  overlayNodes: MagnifierOverlayNode[];
}) {
  const size = 154;
  const zoom = 2.6;

  return (
    <div
      className="screenshot-magnifier"
      style={{
        left: `${magnifier.stageX - size / 2}px`,
        top: `${magnifier.stageY - size / 2}px`,
        width: `${size}px`,
        height: `${size}px`,
        backgroundImage: `url("${screenshotUrl}")`,
        backgroundSize: `${box.width * zoom}px ${box.height * zoom}px`,
        backgroundPosition: `${size / 2 - magnifier.localX * zoom}px ${
          size / 2 - magnifier.localY * zoom
        }px`,
      }}
    >
      <span className="magnifier-coordinate">
        {magnifier.snapshotX}, {magnifier.snapshotY}
      </span>
      {overlayNodes.map(({ node, kind }) => (
        <MagnifierNodeRect
          key={`${kind}-${node.id}`}
          box={box}
          kind={kind}
          magnifier={magnifier}
          node={node}
          size={size}
          snapshot={snapshot}
          zoom={zoom}
        />
      ))}
    </div>
  );
}

interface MagnifierOverlayNode {
  node: NormalizedSnapshotNode;
  kind: "picked" | "hit" | "support";
}

function buildMagnifierOverlayNodes(
  pickResult: NodePickResult | null,
  selectedCandidate: SelectorCandidate | null,
  aiValidation?: SelectorValidation | null,
): MagnifierOverlayNode[] {
  const nodes: MagnifierOverlayNode[] = [];
  const validation = effectiveValidation(selectedCandidate, aiValidation);

  validation.supportNodes.forEach((node) => {
    nodes.push({ node, kind: "support" });
  });
  validation.clickNodes.forEach((node) => {
    nodes.push({ node, kind: "hit" });
  });
  if (pickResult) {
    nodes.push({ node: pickResult.pickedNode, kind: "picked" });
  }

  return nodes;
}

function effectiveValidation(
  selectedCandidate: SelectorCandidate | null,
  aiValidation?: SelectorValidation | null,
): SelectorValidation {
  return (
    selectedCandidate?.validation ??
    aiValidation ??
    { hitCount: 0, clickNodes: [], supportNodes: [] }
  );
}

function MagnifierNodeRect({
  node,
  snapshot,
  kind,
  box,
  magnifier,
  size,
  zoom,
}: {
  node: NormalizedSnapshotNode;
  snapshot: ParsedGkdSnapshot;
  kind: "picked" | "hit" | "support";
  box: ImageBox;
  magnifier: MagnifierState;
  size: number;
  zoom: number;
}) {
  const rect = computeMagnifiedNodeRect({
    nodeBounds: {
      left: node.attr.left,
      top: node.attr.top,
      right: node.attr.right,
      bottom: node.attr.bottom,
    },
    screenWidth: snapshot.screenWidth,
    screenHeight: snapshot.screenHeight,
    imageWidth: box.width,
    imageHeight: box.height,
    magnifierLocalX: magnifier.localX,
    magnifierLocalY: magnifier.localY,
    magnifierSize: size,
    zoom,
  });

  return (
    <span
      className={`magnifier-node-rect magnifier-node-rect-${kind}`}
      style={{
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    />
  );
}

function NodeRect({
  node,
  snapshot,
  kind,
  box,
}: {
  node: NormalizedSnapshotNode;
  snapshot: ParsedGkdSnapshot;
  kind: "picked" | "hit" | "support";
  box: ImageBox;
}) {
  const left = Math.min(node.attr.left, node.attr.right);
  const right = Math.max(node.attr.left, node.attr.right);
  const top = Math.min(node.attr.top, node.attr.bottom);
  const bottom = Math.max(node.attr.top, node.attr.bottom);

  return (
    <div
      className={`node-rect node-rect-${kind}`}
      style={{
        left: `${box.offsetLeft + (left / snapshot.screenWidth) * box.width}px`,
        top: `${box.offsetTop + (top / snapshot.screenHeight) * box.height}px`,
        width: `${((right - left) / snapshot.screenWidth) * box.width}px`,
        height: `${((bottom - top) / snapshot.screenHeight) * box.height}px`,
      }}
    />
  );
}

function getContainedImageBox(img: HTMLImageElement): ImageBox {
  const rect = img.getBoundingClientRect();
  const naturalWidth = img.naturalWidth || rect.width || 1;
  const naturalHeight = img.naturalHeight || rect.height || 1;
  const containerRatio = rect.width / rect.height;
  const imageRatio = naturalWidth / naturalHeight;

  if (containerRatio > imageRatio) {
    const height = rect.height;
    const width = height * imageRatio;
    return {
      offsetLeft: (rect.width - width) / 2,
      offsetTop: 0,
      width,
      height,
    };
  }

  const width = rect.width;
  const height = width / imageRatio;
  return {
    offsetLeft: 0,
    offsetTop: (rect.height - height) / 2,
    width,
    height,
  };
}

function toSnapshotPointFromClient(
  clientX: number,
  clientY: number,
  stage: HTMLDivElement,
  box: ImageBox,
  snapshot: ParsedGkdSnapshot,
): NodePoint | null {
  const localPoint = toLocalImagePointFromClient(clientX, clientY, stage, box);
  if (!localPoint) return null;

  return localPointToSnapshotPoint(localPoint, box, snapshot);
}

function localPointToSnapshotPoint(
  point: { localX: number; localY: number },
  box: ImageBox,
  snapshot: ParsedGkdSnapshot,
): NodePoint {
  return {
    x: Math.round((point.localX / box.width) * snapshot.screenWidth),
    y: Math.round((point.localY / box.height) * snapshot.screenHeight),
  };
}

function toLocalImagePointFromClient(
  clientX: number,
  clientY: number,
  stage: HTMLDivElement,
  box: ImageBox,
): { localX: number; localY: number } | null {
  const rect = stage.getBoundingClientRect();
  const localX = clientX - rect.left - box.offsetLeft;
  const localY = clientY - rect.top - box.offsetTop;

  if (localX < 0 || localY < 0 || localX > box.width || localY > box.height) {
    return null;
  }

  return { localX, localY };
}

function getDragStartLocalPoint(
  box: ImageBox,
  magnifier: MagnifierState | null,
  savedLocal: DragLocalPoint | null,
  pickResult: NodePickResult | null,
  snapshot: ParsedGkdSnapshot,
): DragLocalPoint {
  const visibleLocal = magnifier
    ? {
      localX: magnifier.localX,
      localY: magnifier.localY,
    }
    : null;

  let fallbackLocal: DragLocalPoint;
  if (!pickResult) {
    fallbackLocal = {
      localX: box.width / 2,
      localY: box.height / 2,
    };
  } else {
    const node = pickResult.pickedNode;
    const centerX = (Math.min(node.attr.left, node.attr.right) +
      Math.max(node.attr.left, node.attr.right)) / 2;
    const centerY = (Math.min(node.attr.top, node.attr.bottom) +
      Math.max(node.attr.top, node.attr.bottom)) / 2;

    fallbackLocal = {
      localX: clamp((centerX / snapshot.screenWidth) * box.width, 0, box.width),
      localY: clamp((centerY / snapshot.screenHeight) * box.height, 0, box.height),
    };
  }

  return chooseDragStartLocalPoint({
    visibleLocal,
    savedLocal,
    fallbackLocal,
  });
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return value;
  return Math.min(Math.max(value, min), max);
}
