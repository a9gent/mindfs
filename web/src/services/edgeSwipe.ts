export type SidebarSide = "left" | "right";

export type SwipeDragMode = "open" | "close";

export type SwipeIntent = "horizontal" | "vertical" | null;

/**
 * Classify the intent of the first few pixels of movement on an edge hot zone
 * or sidebar body. Horizontal drags drive the drawer, vertical drags are left
 * to native scrolling.
 */
export function classifySwipeIntent(dx: number, dy: number, axisRatio = 1.2): SwipeIntent {
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX < 8 && absY < 8) {
    return null;
  }
  if (absX >= absY * axisRatio) {
    return "horizontal";
  }
  if (absY > absX * axisRatio) {
    return "vertical";
  }
  return null;
}

/**
 * Drawer openness in [0, 1] for the given drag delta.
 * 0 = fully closed, 1 = fully open.
 *  - "open" drags start from the closed state and follow the finger towards 1.
 *  - "close" drags start from the open state and follow towards 0.
 * The sign of dx is expressed in screen coordinates (positive = rightwards).
 */
export function swipeProgress(
  side: SidebarSide,
  mode: SwipeDragMode,
  dx: number,
  width: number,
): number {
  if (width <= 0) {
    return mode === "open" ? 0 : 1;
  }
  // Direction along which the drawer opens, in screen coordinates.
  // Left drawer opens rightwards (+1), right drawer opens leftwards (-1).
  const openDirection = side === "left" ? 1 : -1;
  const traveled = (dx * openDirection) / width;
  if (mode === "open") {
    return clamp01(traveled);
  }
  return clamp01(1 + traveled);
}

/**
 * Decide whether a released drag settles open or closed. Slow releases follow
 * the 0.5 position threshold; fast flicks in either direction win early.
 */
export function swipeRelease(progress: number, velocityPxPerMs: number, width: number): SwipeDragMode {
  const projected = velocityPxPerMs !== 0 && width > 0
    ? progress + (velocityPxPerMs * 120) / width
    : progress;
  if (velocityPxPerMs > 0.45) {
    return "open";
  }
  if (velocityPxPerMs < -0.45) {
    return "close";
  }
  return projected >= 0.5 ? "open" : "close";
}

export function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
