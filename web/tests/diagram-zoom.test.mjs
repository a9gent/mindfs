import assert from "node:assert/strict";
import { diagramGesture, zoomDiagramAt } from "../src/components/diagramZoom.ts";

const initial = { x: 0, y: 0, scale: 1 };
assert.deepEqual(zoomDiagramAt(initial, 2, { x: 100, y: 50 }), { x: -100, y: -50, scale: 2 });
assert.deepEqual(zoomDiagramAt(initial, 1, { x: 10, y: 20 }, { x: 30, y: 50 }), { x: 20, y: 30, scale: 1 });
assert.equal(zoomDiagramAt(initial, 100, { x: 0, y: 0 }).scale, 16);
assert.equal(zoomDiagramAt(initial, 0.001, { x: 0, y: 0 }).scale, 0.25);
assert.deepEqual(diagramGesture([{ x: 0, y: 0 }, { x: 6, y: 8 }]), { center: { x: 3, y: 4 }, distance: 10 });
assert.deepEqual(diagramGesture([{ x: 6, y: 8 }]), { center: { x: 6, y: 8 }, distance: 0 });
const zoomed = zoomDiagramAt(initial, 3, { x: 12, y: 24 });
assert.deepEqual(zoomDiagramAt(zoomed, 1 / 3, { x: 12, y: 24 }), initial);
