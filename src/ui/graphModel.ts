import type { Project, ProjectNode, Relation } from '../types';

export interface ProjectedRelation {
  id: string;
  source: string;
  target: string;
  relations: Relation[];
  projected: boolean;
  offset: number;
}

export const FAR_ZOOM_THRESHOLD = .58;
export const COMPACT_CARD = Object.freeze({ width: 245, height: 112 });
export const CIRCLE_DIAMETER = 64;
export function canvasPosition(point: { x: number; y: number }) { return { x: point.x + COMPACT_CARD.width / 2, y: point.y + COMPACT_CARD.height / 2 }; }
export function documentPosition(point: { x: number; y: number }) { return { x: point.x - COMPACT_CARD.width / 2, y: point.y - COMPACT_CARD.height / 2 }; }
export function relationLabel(relation: Pick<Relation, 'label'>): string { return relation.label?.trim() ?? ''; }

/** Flow may announce the same selection after a controlled-node update. */
export function stableSelection(previous: string[], next: string[]): string[] {
  if (previous.length !== next.length) return next;
  const ids = new Set(next);
  return previous.every((id) => ids.has(id)) ? previous : next;
}

/** The projection is a view only: original relation endpoints never change. */
export function projectGraph(project: Project, collapsedIds: readonly string[], visibleIds?: ReadonlySet<string>) {
  const active = project.nodes.filter((node) => !node.deletedAt);
  const activeIds = new Set(active.map((node) => node.id));
  const collapsed = new Set(collapsedIds.filter((id) => activeIds.has(id)));
  const parents = new Map(project.memberships.filter((item) => activeIds.has(item.groupNodeId) && activeIds.has(item.memberNodeId))
    .map((item) => [item.memberNodeId, item.groupNodeId]));
  const projectId = (id: string) => {
    const parent = parents.get(id);
    return parent && collapsed.has(parent) ? parent : id;
  };
  const nodes = active.filter((node) => projectId(node.id) === node.id && (!visibleIds || visibleIds.has(node.id)
    || project.memberships.some((item) => item.groupNodeId === node.id && visibleIds.has(item.memberNodeId))));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const relations: ProjectedRelation[] = [];
  const aggregates = new Map<string, ProjectedRelation>();
  for (const relation of project.relations.filter((item) => !item.deletedAt)) {
    const source = projectId(relation.sourceNodeId), target = projectId(relation.targetNodeId);
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    const projected = source !== relation.sourceNodeId || target !== relation.targetNodeId;
    if (projected && source === target) continue;
    if (!projected) {
      relations.push({ id: relation.id, source, target, relations: [relation], projected: false, offset: 0 });
      continue;
    }
    const endpoints = !relation.directed || relation.bidirectional ? [source, target].sort() : [source, target];
    const key = JSON.stringify([...endpoints, relation.directed, relation.bidirectional, relation.assessment, relationLabel(relation)]);
    const existing = aggregates.get(key);
    if (existing) existing.relations.push(relation);
    else {
      const edge = { id: `projection:${key}`, source, target, relations: [relation], projected: true, offset: 0 };
      aggregates.set(key, edge);
      relations.push(edge);
    }
  }
  const pairs = new Map<string, ProjectedRelation[]>();
  for (const edge of relations) {
    const key = JSON.stringify([edge.source, edge.target].sort());
    pairs.set(key, [...(pairs.get(key) ?? []), edge]);
  }
  for (const edges of pairs.values()) edges.sort((a, b) => a.id.localeCompare(b.id)).forEach((edge, index) => {
    edge.offset = (index - (edges.length - 1) / 2) * 32;
  });
  return { nodes, relations };
}

export function nodeGlyph(project: Project, node: ProjectNode): string {
  if (node.iconEmoji) return node.iconEmoji;
  const iconKey = project.nodeTypes.find((type) => type.id === node.typeId)?.iconKey ?? 'circle';
  const glyphs: Record<string, string> = { user: '♙', building: '▦', phone: '☎', mail: '✉', globe: '◎', link: '↗', 'map-pin': '⌖', calendar: '◷', 'file-text': '▤', image: '▧', music: '♫', video: '▷', 'check-circle': '✓', folder: '▱', tag: '◇', circle: '○', book: '▥', briefcase: '▣', database: '▨', flag: '⚑', hash: '#', search: '⌕', shield: '⬡', star: '☆' };
  return glyphs[iconKey] ?? '◈';
}

export function safeExternalUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch { return undefined; }
}
