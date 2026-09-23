export type DiagramTransform = { x: number; y: number; scale: number };
export type DiagramPoint = { x: number; y: number };

// Keep the diagram point under the gesture midpoint stationary while zooming.
export function zoomDiagramAt(transform: DiagramTransform, factor: number, from: DiagramPoint, to = from): DiagramTransform {
  const scale = Math.min(16, Math.max(0.25, transform.scale * factor));
  const ratio = scale / transform.scale;
  return { scale, x: to.x - (from.x - transform.x) * ratio, y: to.y - (from.y - transform.y) * ratio };
}

export function diagramGesture(points: DiagramPoint[]) {
  const [a, b = a] = points;
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(b.x - a.x, b.y - a.y) };
}
