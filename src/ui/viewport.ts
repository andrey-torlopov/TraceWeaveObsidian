import { getViewportForBounds } from '@xyflow/react';
import { CIRCLE_DIAMETER, COMPACT_CARD, FAR_ZOOM_THRESHOLD } from './graphModel';

export const EXPANDED_CARD = Object.freeze({ width: 365, height: 448 });
export const MIN_GRAPH_ZOOM = .00001;
export const MAX_GRAPH_ZOOM = 2.5;
export interface FitNode { x: number; y: number; expanded: boolean }
interface Bounds { x: number; y: number; width: number; height: number }

/** Bounds are derived from final presentation dimensions, never the previous zoom's measurements. */
export function presentationBounds(nodes: readonly FitNode[], circle: boolean): Bounds | null {
  if (!nodes.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    const size = circle ? { width: CIRCLE_DIAMETER, height: CIRCLE_DIAMETER } : node.expanded ? EXPANDED_CARD : COMPACT_CARD;
    left = Math.min(left, node.x - size.width / 2); right = Math.max(right, node.x + size.width / 2);
    top = Math.min(top, node.y - size.height / 2); bottom = Math.max(bottom, node.y + size.height / 2);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function fitGraphViewport(nodes: readonly FitNode[], width: number, height: number) {
  if (width <= 0 || height <= 0 || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const normalBounds = presentationBounds(nodes, false);
  if (!normalBounds) return null;
  const normal = getViewportForBounds(normalBounds, width, height, MIN_GRAPH_ZOOM, MAX_GRAPH_ZOOM, .18);
  if (normal.zoom >= FAR_ZOOM_THRESHOLD) return normal;
  const circles = presentationBounds(nodes, true)!;
  // The gap case has a circle-fit zoom above the threshold but a card-fit zoom below it.
  // Staying just below the threshold keeps circles visible and prevents representation oscillation.
  return getViewportForBounds(circles, width, height, MIN_GRAPH_ZOOM, FAR_ZOOM_THRESHOLD - .001, .18);
}
