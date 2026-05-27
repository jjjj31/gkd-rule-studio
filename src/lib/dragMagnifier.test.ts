import { describe, expect, it } from "vitest";
import {
  chooseDragStartLocalPoint,
  computeMagnifiedNodeRect,
  computeMagnifierStageCenter,
  computeRelativeDragLocalPoint,
} from "./dragMagnifier";

describe("drag magnifier", () => {
  it("moves by pointer delta instead of teleporting to the touched location", () => {
    const startLocal = { localX: 200, localY: 300 };
    const startPointer = { clientX: 50, clientY: 700 };
    const currentPointer = { clientX: 58, clientY: 684 };

    const next = computeRelativeDragLocalPoint({
      startLocal,
      startPointer,
      currentPointer,
      imageWidth: 1000,
      imageHeight: 2000,
    });

    expect(next).toEqual({ localX: 208, localY: 284 });
    expect(next.localY).not.toBe(684);
  });

  it("clamps the virtual cursor inside the image bounds", () => {
    const next = computeRelativeDragLocalPoint({
      startLocal: { localX: 6, localY: 8 },
      startPointer: { clientX: 100, clientY: 100 },
      currentPointer: { clientX: 20, clientY: 40 },
      imageWidth: 1000,
      imageHeight: 2000,
    });

    expect(next).toEqual({ localX: 0, localY: 0 });
  });

  it("continues from the saved hidden magnifier position when visible state is gone", () => {
    expect(
      chooseDragStartLocalPoint({
        visibleLocal: null,
        savedLocal: { localX: 420, localY: 860 },
        fallbackLocal: { localX: 100, localY: 100 },
      }),
    ).toEqual({ localX: 420, localY: 860 });
  });

  it("keeps the magnifier center on the target point even at image edges", () => {
    expect(
      computeMagnifierStageCenter({
        imageOffsetLeft: 20,
        imageOffsetTop: 30,
        localX: 0,
        localY: 1999,
      }),
    ).toEqual({ stageX: 20, stageY: 2029 });
  });

  it("maps a selected node rectangle into magnifier coordinates", () => {
    const rect = computeMagnifiedNodeRect({
      nodeBounds: { left: 490, top: 980, right: 510, bottom: 1020 },
      screenWidth: 1000,
      screenHeight: 2000,
      imageWidth: 500,
      imageHeight: 1000,
      magnifierLocalX: 250,
      magnifierLocalY: 500,
      magnifierSize: 154,
      zoom: 2,
    });

    expect(rect).toEqual({
      left: 67,
      top: 57,
      width: 20,
      height: 40,
    });
  });
});
