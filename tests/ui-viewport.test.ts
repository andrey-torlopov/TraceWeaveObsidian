import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAR_ZOOM_THRESHOLD } from '../src/ui/graphModel';
import { fitGraphViewport, presentationBounds, type FitNode } from '../src/ui/viewport';

function assertFits(nodes: FitNode[], width: number, height: number) {
  const viewport = fitGraphViewport(nodes, width, height); assert.ok(viewport);
  const bounds = presentationBounds(nodes, viewport.zoom < FAR_ZOOM_THRESHOLD)!;
  const left = bounds.x * viewport.zoom + viewport.x, top = bounds.y * viewport.zoom + viewport.y;
  assert.ok(left >= -.001 && top >= -.001);
  assert.ok(left + bounds.width * viewport.zoom <= width + .001);
  assert.ok(top + bounds.height * viewport.zoom <= height + .001);
  return viewport;
}
test('fit anticipates all three normal cards including an expanded reader', () => {
  const nodes = [{ x: 122.5, y: 56, expanded: true }, { x: 402.5, y: 56, expanded: false }, { x: 802.5, y: 156, expanded: false }];
  const before = JSON.stringify(nodes), viewport = assertFits(nodes, 1150, 650);
  assert.ok(viewport.zoom >= FAR_ZOOM_THRESHOLD);
  assert.equal(JSON.stringify(nodes), before);
});
test('fit for a broad allowed graph stays in circle mode and includes extreme coordinates', () => {
  const nodes = Array.from({ length: 100 }, (_, index) => ({ x: -999000 + index * 20000, y: index % 2 ? 999000 : -999000, expanded: index % 3 === 0 }));
  const viewport = assertFits(nodes, 640, 480);
  assert.ok(viewport.zoom < .12); // The previous minimum zoom could not include this valid graph.
});
test('threshold gap stays below circle boundary instead of oscillating between dimensions', () => {
  const nodes = [{ x: 122.5, y: 56, expanded: false }, { x: 402.5, y: 56, expanded: false }];
  const viewport = assertFits(nodes, 320, 200);
  assert.ok(viewport.zoom < FAR_ZOOM_THRESHOLD);
  assert.deepEqual(fitGraphViewport(nodes, 320, 200), viewport);
});
test('empty or not-yet-measured canvas has no fabricated fit', () => {
  assert.equal(fitGraphViewport([], 640, 480), null);
  assert.equal(fitGraphViewport([{ x: 0, y: 0, expanded: true }], 0, 480), null);
});
