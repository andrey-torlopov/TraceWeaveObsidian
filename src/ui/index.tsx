import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { Background, BaseEdge, ControlButton, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useStore, useUpdateNodeInternals, type Connection, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import type { Asset, Assessment, Attribute, AttributeKind, Command, Confidence, Evidence, ID, NodeType, Project, ProjectNode, Relation, ResourceCandidate, ViewState, WorkbenchService } from '../types';
import { FAR_ZOOM_THRESHOLD, canvasPosition, documentPosition, nodeGlyph, projectGraph, relationLabel, safeExternalUrl, stableSelection } from './graphModel';
import { SafeMarkdown } from './markdown';
import { metadataDrafts } from './drafts';
import { NODE_ICON_KEYS } from '../domain';
import { VaultNotePicker } from './VaultNotePicker';
import { MAX_GRAPH_ZOOM, MIN_GRAPH_ZOOM, fitGraphViewport } from './viewport';

const assessmentNames: Record<Assessment, string> = { unreviewed: 'Не проверено', confirmed_by_user: 'Подтверждено', hypothesis: 'Гипотеза', refuted_by_user: 'Опровергнуто' };
const confidenceNames: Record<Exclude<Confidence, null>, string> = { low: 'Низкая', medium: 'Средняя', high: 'Высокая' };
const attributeNames: Record<AttributeKind, string> = { text: 'Текст', number: 'Число', boolean: 'Да / нет', date: 'Дата', datetime: 'Дата и время', url: 'URL', geo: 'Координаты' };
const defaultView: ViewState = { mode: 'graph', selectedId: null, collapsedGroupIds: [], expandedNodeIds: [] };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
type Run = (operation: () => Promise<unknown>) => Promise<void>;
type DialogState = { kind: 'project' | 'note' | 'adopt' | 'group' | 'report' | 'settings' | 'types' | 'resources' | 'reports' | 'attach' } | { kind: 'node'; id: ID } | { kind: 'asset'; id: ID } | { kind: 'relation'; id?: ID; source?: ID; target?: ID } | null;

function date(value: string) { return new Date(value).toLocaleString('ru-RU'); }
function localDateTime(value: Attribute['value']): string {
  if (typeof value !== 'string' || !value) return '';
  const valueDate = new Date(value);
  if (!Number.isFinite(valueDate.valueOf())) return '';
  const part = (value: number) => String(value).padStart(2, '0');
  return `${valueDate.getFullYear()}-${part(valueDate.getMonth() + 1)}-${part(valueDate.getDate())}T${part(valueDate.getHours())}:${part(valueDate.getMinutes())}`;
}
function activeTrashBatches(project: Project) {
  return project.deletionBatches.filter((batch) => project.nodes.some((node) => node.deletionBatchId === batch.id) || project.relations.some((relation) => relation.deletionBatchId === batch.id));
}
function bytes(value: number) {
  if (value < 1024) return `${value} Б`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} КиБ`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} МиБ`;
  return `${(value / 1073741824).toFixed(2)} ГиБ`;
}
function typeName(project: Project, node: ProjectNode) { return project.nodeTypes.find((type) => type.id === node.typeId)?.name ?? 'Без типа'; }
function attributeValue(attribute: Attribute): string {
  const value = attribute.value;
  if (value === null) return 'Неизвестно';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (typeof value !== 'object') return String(value);
  return 'precision' in value ? `${value.value} (${value.precision === 'year' ? 'год' : value.precision === 'month' ? 'месяц' : 'день'})` : `${value.latitude}, ${value.longitude}${value.accuracyMeters === null ? '' : ` ± ${value.accuracyMeters} м`}`;
}

function NotePreview({ service, node, revision }: { service: WorkbenchService; node: ProjectNode; revision: number }) {
  const [body, setBody] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setBody(null); setError(null);
    service.readNote(node.id).then((text) => { if (current) setBody(text); }).catch((reason: unknown) => { if (current) setError(errorText(reason)); });
    return () => { current = false; };
  }, [service, node.id, node.notePath, node.noteHash, revision]);
  if (error) return <p className="tw-error" role="alert">{error}</p>;
  if (body === null) return <p className="tw-muted">Чтение заметки…</p>;
  return body.trim() ? <SafeMarkdown text={body} sourcePath={node.notePath} service={service} /> : <p className="tw-muted">Заметка пока пуста. Откройте её в редакторе Obsidian.</p>;
}

function AssetPreview({ asset, service }: { asset: Asset; service: WorkbenchService }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const [failed, setFailed] = useState(false);
  const source = useMemo(() => {
    try { return { url: service.resourceUrl(asset.id), error: null }; }
    catch (error) { return { url: '', error: errorText(error) }; }
  }, [service, asset.id, asset.sha256]);
  useEffect(() => {
    setFailed(false);
    const player = media.current;
    return () => {
      if (player) { player.pause(); player.removeAttribute('src'); player.load(); }
    };
  }, [asset.id]);
  if (source.error) return <p className="tw-error">{source.error}</p>;
  if (failed) return <p className="tw-muted">Формат или кодек не поддерживается. Используйте «Открыть оригинал».</p>;
  if (asset.mediaKind === 'audio') return <audio key={asset.id} ref={(element) => { media.current = element; }} src={source.url} controls preload="metadata" onError={() => setFailed(true)} />;
  if (asset.mediaKind === 'video') return <video key={asset.id} ref={(element) => { media.current = element; }} src={source.url} controls preload="metadata" onError={() => setFailed(true)} />;
  if (/^image\/(png|jpeg|gif|webp|bmp|avif)$/i.test(asset.mimeType) && asset.byteSize <= 32 * 1024 * 1024) return <img src={source.url} alt={asset.title} loading="lazy" onError={() => setFailed(true)} />;
  return <div className="tw-file-fallback"><span aria-hidden="true">▤</span><p>{asset.mimeType === 'application/pdf' ? 'PDF откроется в просмотрщике Obsidian.' : 'Файл хранится в каталоге материалов. Для этого формата встроенный просмотр не используется.'}</p></div>;
}

function MediaPanel({ project, node, service, run }: { project: Project; node: ProjectNode; service: WorkbenchService; run: Run }) {
  const attachments = project.attachments.filter((item) => item.nodeId === node.id).sort((a, b) => Number(b.role === 'primary') - Number(a.role === 'primary') || a.sortOrder - b.sortOrder);
  const [selected, setSelected] = useState<string | null>(null);
  const current = attachments.find((item) => item.id === selected) ?? attachments[0];
  const asset = project.assets.find((item) => item.id === current?.assetId && !item.deletedAt);
  useEffect(() => setSelected(null), [node.id]);
  if (!attachments.length) return null;
  return <section className="tw-media-panel" aria-label="Материалы документа">
    <select aria-label="Выбранный материал" value={current?.id ?? ''} onChange={(event) => setSelected(event.target.value)}>{attachments.map((item) => <option key={item.id} value={item.id}>{item.role === 'primary' ? '★ ' : ''}{project.assets.find((value) => value.id === item.assetId)?.title ?? 'Недоступный материал'}</option>)}</select>
    {asset ? <><AssetPreview key={asset.id} asset={asset} service={service} /><div className="tw-row"><span className="tw-muted">{bytes(asset.byteSize)}</span><button onClick={() => void run(() => service.showAsset(asset.id))}>Открыть оригинал</button>{current?.role !== 'primary' && <button onClick={() => void run(() => service.execute([{ kind: 'attachment.primary', attachmentId: current!.id }]))}>Сделать основным</button>}<button className="tw-danger" onClick={() => void run(() => service.execute([{ kind: 'attachment.detach', attachmentId: current!.id }]))}>Отвязать</button></div>{current?.caption && <p>{current.caption}</p>}</> : <p className="tw-error">Материал отсутствует в каталоге.</p>}
  </section>;
}

type CardData = { title: string; node: ProjectNode; project: Project; service: WorkbenchService; expanded: boolean; collapsed: boolean; members: number; selected: boolean; onToggle: (id: ID) => void; onCollapse: (id: ID) => void; onEdit: (id: ID) => void; run: Run } & Record<string, unknown>;
type GraphNode = Node<CardData, 'traceweave'>;
const GraphCard = memo(function GraphCard({ id, data }: NodeProps<GraphNode>) {
  const type = data.project.nodeTypes.find((item) => item.id === data.node.typeId);
  const far = useStore((state) => state.transform[2] < FAR_ZOOM_THRESHOLD);
  const updateInternals = useUpdateNodeInternals();
  useLayoutEffect(() => { updateInternals(id); }, [id, far, data.expanded, updateInternals]);
  return <article title={far ? `${data.title} · ${type?.name ?? ''} · ${assessmentNames[data.node.assessment]}` : undefined} aria-label={data.title} className={`tw-graph-card${far ? ' is-circle' : data.expanded ? ' is-expanded' : ''}${data.selected ? ' is-selected' : ''}${data.node.missing ? ' is-missing' : ''}`} style={{ borderColor: far ? type?.color : undefined, borderTopColor: type?.color ?? 'var(--interactive-accent)' }}>
    <Handle type="target" position={Position.Left} id="target" /><Handle type="source" position={Position.Right} id="source" />
    {far ? <><span className="tw-node-glyph" aria-hidden="true">{nodeGlyph(data.project, data.node)}</span>{data.members > 0 && <button className="tw-circle-members nodrag nopan" aria-label={`${data.collapsed ? 'Раскрыть' : 'Свернуть'} группу ${data.title}`} onClick={() => data.onCollapse(data.node.id)}>{data.members}</button>}</> : <><div className="tw-card-heading"><span className="tw-node-glyph" aria-hidden="true">{nodeGlyph(data.project, data.node)}</span><div><strong title={data.title}>{data.title}</strong><span>{type?.name} · {assessmentNames[data.node.assessment]}</span></div></div>
    {data.node.missing && <span className="tw-error">Заметка отсутствует</span>}
    <div className="tw-row nodrag nopan"><button title="Развернуть карточку" onClick={() => data.onToggle(data.node.id)}>{data.expanded ? 'Свернуть' : 'Читать'}</button>{data.members > 0 && <button onClick={() => data.onCollapse(data.node.id)}>{data.collapsed ? `Раскрыть группу (${data.members})` : `Свернуть группу (${data.members})`}</button>}<button aria-label={`Редактировать ${data.title}`} onClick={() => data.onEdit(data.node.id)}>⋯</button></div>
    {data.expanded && <div className="tw-card-body nodrag nopan nowheel"><NotePreview node={data.node} revision={data.project.revision} service={data.service} /><button onClick={() => void data.run(() => data.service.openNote(data.node.id))}>Открыть заметку</button></div>}</>}
  </article>;
});
type GraphEdgeData = { label: string; offset: number; count: number } & Record<string, unknown>;
type GraphEdge = Edge<GraphEdgeData, 'traceweave'>;
function GraphRelation(props: EdgeProps<GraphEdge>) {
  const { sourceX: sx, sourceY: sy, targetX: tx, targetY: ty } = props;
  const offset = props.data?.offset ?? 0;
  const direction = sx <= tx ? 1 : -1;
  const reach = Math.max(65, Math.abs(tx - sx) * .45);
  const x1 = sx + reach * direction, x2 = tx - reach * direction;
  const path = sx === tx && sy === ty ? `M ${sx} ${sy} C ${sx + 130} ${sy - 130} ${sx - 130} ${sy - 130} ${tx} ${ty}` : `M ${sx} ${sy} C ${x1} ${sy + offset} ${x2} ${ty + offset} ${tx} ${ty}`;
  const labelX = (sx + 3 * x1 + 3 * x2 + tx) / 8, labelY = (sy + 3 * (sy + offset) + 3 * (ty + offset) + ty) / 8;
  return <><BaseEdge id={props.id} path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} style={props.style} interactionWidth={24} />{(props.data?.label || (props.data?.count ?? 0) > 1) && <EdgeLabelRenderer><span className={`tw-edge-label${props.selected ? ' is-selected' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>{props.data?.label}{(props.data?.count ?? 0) > 1 ? `${props.data?.label ? ' ' : ''}×${props.data?.count}` : ''}</span></EdgeLabelRenderer>}</>;
}
const nodeTypes = { traceweave: GraphCard };
const edgeTypes = { traceweave: GraphRelation };

function Graph({ project, service, view, setView, visibleIds, run, setDialog, selection, setSelection, setAggregate }: {
  project: Project; service: WorkbenchService; view: ViewState; setView: React.Dispatch<React.SetStateAction<ViewState>>; visibleIds: ReadonlySet<ID>; run: Run; setDialog: (dialog: DialogState) => void; selection: ID[]; setSelection: React.Dispatch<React.SetStateAction<ID[]>>; setAggregate: (ids: ID[]) => void;
}) {
  const [flow, setFlow] = useState<ReactFlowInstance<GraphNode, GraphEdge> | null>(null);
  const graphElement = useRef<HTMLDivElement>(null), initialFit = useRef(false);
  const projection = useMemo(() => projectGraph(project, view.collapsedGroupIds, visibleIds), [project, view.collapsedGroupIds, visibleIds]);
  const toggle = useCallback((id: ID) => setView((state) => ({ ...state, expandedNodeIds: state.expandedNodeIds.includes(id) ? state.expandedNodeIds.filter((item) => item !== id) : [...state.expandedNodeIds, id] })), [setView]);
  const collapse = useCallback((id: ID) => setView((state) => ({ ...state, collapsedGroupIds: state.collapsedGroupIds.includes(id) ? state.collapsedGroupIds.filter((item) => item !== id) : [...state.collapsedGroupIds, id] })), [setView]);
  const models = useMemo<GraphNode[]>(() => projection.nodes.map((node) => ({ id: node.id, type: 'traceweave', position: canvasPosition(node), zIndex: node.zIndex, data: { title: node.title, node, project, service, expanded: view.expandedNodeIds.includes(node.id), collapsed: view.collapsedGroupIds.includes(node.id), members: project.memberships.filter((item) => item.groupNodeId === node.id).length, selected: view.selectedId === node.id, onToggle: toggle, onCollapse: collapse, onEdit: (id: ID) => setDialog({ kind: 'node', id }), run } })), [projection.nodes, project, service, view.expandedNodeIds, view.collapsedGroupIds, view.selectedId, toggle, collapse, run, setDialog]);
  const [nodes, setNodes] = useState(models);
  useEffect(() => setNodes((current) => {
    const previous = new Map(current.map((node) => [node.id, node]));
    return models.map((node) => {
      const existing = previous.get(node.id);
      return existing ? { ...node, selected: existing.selected, measured: existing.measured } : node;
    });
  }), [models]);
  const edges = useMemo<GraphEdge[]>(() => projection.relations.map((edge) => {
    const relation = edge.relations[0]!;
    return { id: edge.id, source: edge.source, target: edge.target, sourceHandle: 'source', targetHandle: 'target', type: 'traceweave', selected: view.selectedId === relation.id, ariaLabel: relationLabel(relation) || 'Связь', data: { label: relationLabel(relation), offset: edge.offset, count: edge.relations.length }, markerEnd: relation.directed || relation.bidirectional ? { type: MarkerType.ArrowClosed, width: 17, height: 17 } : undefined, markerStart: relation.bidirectional ? { type: MarkerType.ArrowClosed, width: 17, height: 17 } : undefined, style: { stroke: relation.assessment === 'refuted_by_user' ? 'var(--text-error)' : 'var(--text-muted)', strokeWidth: view.selectedId === relation.id ? 2.5 : 1.6, strokeDasharray: relation.assessment === 'hypothesis' ? '6 4' : undefined } };
  }), [projection.relations, view.selectedId]);
  const connect = (connection: Connection) => { if (connection.source && connection.target && connection.source !== connection.target) setDialog({ kind: 'relation', source: connection.source, target: connection.target }); };
  const selectionChange = useCallback(({ nodes: selected }: { nodes: GraphNode[] }) => setSelection((previous) => stableSelection(previous, selected.map((node) => node.id))), [setSelection]);
  const fitVisible = useCallback(async () => {
    const element = graphElement.current;
    if (!flow || !element) return;
    const target = fitGraphViewport(projection.nodes.map((node) => ({ ...canvasPosition(node), expanded: view.expandedNodeIds.includes(node.id) })), element.clientWidth, element.clientHeight);
    if (target) await flow.setViewport(target);
  }, [flow, projection.nodes, view.expandedNodeIds]);
  useEffect(() => {
    if (!flow || initialFit.current) return;
    initialFit.current = true;
    if (!view.viewport) void run(fitVisible);
  }, [flow, fitVisible, view.viewport, run]);
  return <div className="tw-graph" ref={graphElement}><ReactFlow<GraphNode, GraphEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlow} onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))} onNodeDragStop={(_event, _node, moved) => void run(async () => { try { await service.execute([{ kind: 'nodes.move', positions: moved.map((node) => ({ nodeId: node.id, ...documentPosition(node.position) })) }]); } catch (reason) { const confirmed = new Map(models.map((node) => [node.id, node.position])); setNodes((current) => current.map((node) => confirmed.has(node.id) ? { ...node, position: confirmed.get(node.id)! } : node)); throw reason; } })} onConnect={connect}
    onNodeClick={(_event, node) => { setView((current) => ({ ...current, selectedId: node.id })); setAggregate([]); }} onNodeDoubleClick={(_event, node) => toggle(node.id)} onNodeContextMenu={(event, node) => { event.preventDefault(); setView((current) => ({ ...current, selectedId: node.id })); setDialog({ kind: 'node', id: node.id }); }}
    onEdgeClick={(_event, edge) => { const item = projection.relations.find((value) => value.id === edge.id); if (item) { setView((current) => ({ ...current, selectedId: item.relations[0]!.id })); setAggregate(item.relations.map((relation) => relation.id)); } }} onEdgeDoubleClick={(_event, edge) => { const item = projection.relations.find((value) => value.id === edge.id); if (item?.relations.length === 1) setDialog({ kind: 'relation', id: item.relations[0]!.id }); }}
    onSelectionChange={selectionChange} onPaneClick={() => { setView((current) => ({ ...current, selectedId: null })); setAggregate([]); }}
    onMoveEnd={(_event, viewport) => setView((current) => ({ ...current, viewport }))} nodeOrigin={[.5, .5]} defaultViewport={view.viewport} minZoom={MIN_GRAPH_ZOOM} maxZoom={MAX_GRAPH_ZOOM} deleteKeyCode={null} multiSelectionKeyCode="Shift" selectionOnDrag panOnDrag={[1, 2]} zoomOnDoubleClick={false} attributionPosition="bottom-left" proOptions={{ hideAttribution: true }}>
    <Background gap={24} size={1} /><Controls showInteractive={false} showFitView={false}><ControlButton className="react-flow__controls-fitview" title="Показать весь граф" aria-label="Показать весь граф" onClick={() => void run(fitVisible)}><span aria-hidden="true">⛶</span></ControlButton></Controls><MiniMap<GraphNode> pannable zoomable nodeColor={(node) => node.data.project.nodeTypes.find((type) => type.id === node.data.node.typeId)?.color ?? '#7882a4'} />
  </ReactFlow><div className="tw-graph-legend"><span>Shift + клик: несколько карточек</span><button onClick={() => void run(fitVisible)}>Показать всё</button></div></div>;
}

function EvidenceList({ items, project, onSelect }: { items: Evidence[]; project: Project; onSelect: (id: ID) => void }) {
  if (!items.length) return <p className="tw-muted">Источники не указаны.</p>;
  return <ul className="tw-evidence-list">{items.map((item) => <li key={item.id}><strong>{item.label || 'Источник'}</strong>{item.sourceKind === 'node' && item.sourceNodeId && <button onClick={() => onSelect(item.sourceNodeId!)}>{project.nodes.find((node) => node.id === item.sourceNodeId)?.title ?? 'Документ в корзине'}</button>}{item.sourceKind === 'asset' && <span>{project.assets.find((asset) => asset.id === item.assetId)?.title ?? 'Недоступный материал'}</span>}{item.sourceKind === 'url' && (safeExternalUrl(item.url) ? <a href={safeExternalUrl(item.url)} rel="noopener noreferrer" target="_blank">{item.url}</a> : <span>{item.url}</span>)}{item.quote && <blockquote>{item.quote}</blockquote>}{item.locator && <small>{item.locator}</small>}{item.note && <p>{item.note}</p>}{item.accessedAt && <small>Дата обращения: {date(item.accessedAt)}</small>}</li>)}</ul>;
}

function Inspector({ project, service, selectedId, aggregate, onSelect, run, setDialog, importInput, onClose }: { project: Project; service: WorkbenchService; selectedId: ID | null; aggregate: ID[]; onSelect: (id: ID) => void; run: Run; setDialog: (dialog: DialogState) => void; importInput: () => void; onClose: () => void }) {
  const node = project.nodes.find((item) => item.id === selectedId && !item.deletedAt);
  const relation = project.relations.find((item) => item.id === selectedId && !item.deletedAt);
  if (!node && !relation) return <aside className="tw-inspector tw-inspector-empty"><span className="tw-empty-glyph">◈</span><h3>Исследуйте связи</h3><p>Выберите документ или связь. Перетяните соединитель между карточками, чтобы создать отношение.</p><p className="tw-muted">Тексты и вложения хранятся в обычных папках. Связи и настройки — в скрытой папке .twdata.</p></aside>;
  return <aside className="tw-inspector"><div className="tw-section-heading"><span className="tw-eyebrow">{node ? 'ДОКУМЕНТ' : 'СВЯЗЬ'}</span><button aria-label="Закрыть просмотр" onClick={onClose}>×</button></div>
    {node ? <><h2>{nodeGlyph(project, node)} {node.title}</h2><div className="tw-tags"><span>{typeName(project, node)}</span><span>{assessmentNames[node.assessment]}</span>{node.confidence && <span>Уверенность: {confidenceNames[node.confidence]}</span>}</div>
      {node.missing && <p className="tw-error">Файл заметки отсутствует. Выберите «Перепривязать» в редакторе метаданных.</p>}
      <div className="tw-row"><button className="mod-cta" onClick={() => void run(() => service.openNote(node.id))}>Открыть заметку</button><button onClick={() => setDialog({ kind: 'node', id: node.id })}>Метаданные</button><button onClick={importInput}>Добавить файлы</button><button onClick={() => setDialog({ kind: 'attach' })}>Из библиотеки</button></div>
      <MediaPanel key={`media:${node.id}`} project={project} node={node} service={service} run={run} /><NotePreview key={`note:${node.id}`} service={service} node={node} revision={project.revision} />
      <h3>Атрибуты</h3>{node.attributes.length ? <dl className="tw-attributes">{[...node.attributes].sort((a, b) => a.sortOrder - b.sortOrder).map((item) => <React.Fragment key={item.id}><dt>{item.key}</dt><dd>{attributeValue(item)}</dd></React.Fragment>)}</dl> : <p className="tw-muted">Атрибуты не добавлены.</p>}
      <h3>Источники</h3><EvidenceList items={node.evidence} project={project} onSelect={onSelect} />
      <div className="tw-section-heading"><h3>Связи</h3><button onClick={() => setDialog({ kind: 'relation', source: node.id })}>+ Связь</button></div><ul className="tw-relation-list">{project.relations.filter((item) => !item.deletedAt && (item.sourceNodeId === node.id || item.targetNodeId === node.id)).map((item) => {
        const otherId = item.sourceNodeId === node.id ? item.targetNodeId : item.sourceNodeId;
        return <li key={item.id}><button onClick={() => onSelect(otherId)}>{item.bidirectional ? '↔' : item.directed ? item.sourceNodeId === node.id ? '→' : '←' : '—'} {project.nodes.find((value) => value.id === otherId)?.title ?? 'Удалённый документ'}</button><button onClick={() => onSelect(item.id)}>{relationLabel(item) || 'Связь'}</button></li>;
      })}</ul><p className="tw-path">{node.notePath}</p><small>Обновлено: {date(node.updatedAt)}</small>
    </> : relation && <>
      {aggregate.length > 1 && <section className="tw-callout"><strong>Проекция группы: {aggregate.length} связей</strong><p>Исходные концы отношений сохранены.</p>{aggregate.map((id) => { const item = project.relations.find((value) => value.id === id); return item && <button key={id} onClick={() => onSelect(id)}>{project.nodes.find((value) => value.id === item.sourceNodeId)?.title} → {project.nodes.find((value) => value.id === item.targetNodeId)?.title}: {relationLabel(item) || 'Связь'}</button>; })}</section>}
      <h2>{relationLabel(relation) || 'Связь'}</h2><div className="tw-relation-endpoints"><button onClick={() => onSelect(relation.sourceNodeId)}>{project.nodes.find((item) => item.id === relation.sourceNodeId)?.title}</button><span>{relation.bidirectional ? '↔' : relation.directed ? '→' : '—'}</span><button onClick={() => onSelect(relation.targetNodeId)}>{project.nodes.find((item) => item.id === relation.targetNodeId)?.title}</button></div>
      <div className="tw-tags"><span>{assessmentNames[relation.assessment]}</span>{relation.confidence && <span>{confidenceNames[relation.confidence]}</span>}</div><div className="tw-row"><button onClick={() => setDialog({ kind: 'relation', id: relation.id })}>Изменить связь</button><button className="tw-danger" onClick={() => void run(() => service.execute([{ kind: 'elements.trash', nodeIds: [], relationIds: [relation.id], groupMode: 'group_only' }]))}>В корзину</button></div>
      <SafeMarkdown text={relation.noteMarkdown} /><h3>Источники</h3><EvidenceList items={relation.evidence} project={project} onSelect={onSelect} /><small>Создано: {date(relation.createdAt)}</small>
    </>}
  </aside>;
}

function Dossier({ project, nodes, selectedId, onSelect }: { project: Project; nodes: ProjectNode[]; selectedId: ID | null; onSelect: (id: ID) => void }) {
  const [layout, setLayout] = useState<'list' | 'cards'>('list'), [sort, setSort] = useState('title');
  const sorted = [...nodes].sort((a, b) => sort === 'updated' ? b.updatedAt.localeCompare(a.updatedAt) : a.title.localeCompare(b.title, 'ru'));
  return <section className="tw-dossier"><div className="tw-section-heading"><span>{nodes.length} документов</span><div className="tw-row"><select aria-label="Сортировка досье" value={sort} onChange={(event) => setSort(event.target.value)}><option value="title">По названию</option><option value="updated">По обновлению</option></select><button aria-pressed={layout === 'list'} onClick={() => setLayout('list')}>Список</button><button aria-pressed={layout === 'cards'} onClick={() => setLayout('cards')}>Карточки</button></div></div>
    {sorted.length ? <div className={`tw-dossier-${layout}`}>{sorted.map((node) => <button className={`tw-dossier-item${selectedId === node.id ? ' is-selected' : ''}`} key={node.id} onClick={() => onSelect(node.id)}><span className="tw-node-glyph">{nodeGlyph(project, node)}</span><div><strong>{node.title}</strong><span>{typeName(project, node)} · {assessmentNames[node.assessment]}</span>{layout === 'cards' && <p>{node.attributes.slice(0, 3).map((item) => `${item.key}: ${attributeValue(item)}`).join(' · ') || node.subtitle || node.notePath}</p>}</div><span className="tw-muted">{node.missing ? 'Нет файла' : '→'}</span></button>)}</div> : <div className="tw-empty"><h3>Документов по этим условиям нет</h3><p>Измените фильтр или создайте заметку.</p></div>}
  </section>;
}

function Materials({ project, service, run, setDialog, importInput }: { project: Project; service: WorkbenchService; run: Run; setDialog: (dialog: DialogState) => void; importInput: () => void }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState(''), [selected, setSelected] = useState<ID | null>(null), [verification, setVerification] = useState<{ assetId: ID; status: 'ok' | 'missing' | 'changed' }[] | null>(null);
  const assets = project.assets.filter((asset) => !asset.deletedAt && (!kind || asset.mediaKind === kind) && `${asset.title} ${asset.originalName}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const asset = project.assets.find((item) => item.id === selected && !item.deletedAt);
  return <section className="tw-materials"><div className="tw-section-heading"><h2>Материалы</h2><div className="tw-row"><button className="mod-cta" onClick={importInput}>Добавить файлы</button><button onClick={() => setDialog({ kind: 'resources' })}>Найти в папке ресурсов</button><button onClick={() => void run(async () => { setVerification(await service.verifyAssets()); })}>Проверить оригиналы</button></div></div>
    <p className="tw-muted">В каталоге видны все форматы, включая архивы и неизвестные бинарные файлы. Импорт не меняет оригинал.</p><div className="tw-row"><input aria-label="Поиск материалов" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название или исходное имя" /><select aria-label="Тип материала" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">Все форматы</option><option value="image">Изображения</option><option value="audio">Аудио</option><option value="video">Видео</option><option value="text">Текст</option><option value="file">PDF, архивы и файлы</option></select></div>
    {verification && <div className="tw-callout"><strong>Проверка завершена</strong><ul>{verification.map((item) => <li key={item.assetId}>{project.assets.find((value) => value.id === item.assetId)?.title}: {item.status === 'ok' ? 'Оригинал подтверждён' : item.status === 'missing' ? 'Файл отсутствует' : 'Файл изменён'}</li>)}</ul><button onClick={() => setVerification(null)}>Закрыть результат</button></div>}
    <div className={`tw-materials-grid${asset ? ' has-preview' : ''}`}><div className="tw-file-list">{assets.map((item) => <button className={selected === item.id ? 'is-selected' : ''} key={item.id} onClick={() => setSelected(item.id)}><span aria-hidden="true">{item.mediaKind === 'audio' ? '♫' : item.mediaKind === 'video' ? '▷' : item.mediaKind === 'image' ? '▧' : '▤'}</span><div><strong>{item.title}</strong><small>{item.originalName} · {bytes(item.byteSize)}</small></div><small>{project.attachments.filter((value) => value.assetId === item.id).length} привязок</small></button>)}{!assets.length && <div className="tw-empty"><h3>Материалов нет</h3><p>Добавьте файл любого формата или зарегистрируйте файл из папки ресурсов.</p></div>}</div>
      {asset && <div className="tw-material-preview"><div className="tw-section-heading"><h3>{asset.title}</h3><button aria-label="Закрыть материал" onClick={() => setSelected(null)}>×</button></div><AssetPreview key={asset.id} asset={asset} service={service} /><div className="tw-row"><button onClick={() => void run(() => service.showAsset(asset.id))}>Открыть оригинал</button><button onClick={() => setDialog({ kind: 'asset', id: asset.id })}>Метаданные</button></div><dl className="tw-attributes"><dt>Имя</dt><dd>{asset.originalName}</dd><dt>Формат</dt><dd>{asset.mimeType}</dd><dt>Размер</dt><dd>{bytes(asset.byteSize)}</dd><dt>SHA-256</dt><dd className="tw-hash">{asset.sha256}</dd></dl>{asset.sourceUrl && <p>Источник: {safeExternalUrl(asset.sourceUrl) ? <a href={safeExternalUrl(asset.sourceUrl)} target="_blank" rel="noopener noreferrer">{asset.sourceUrl}</a> : asset.sourceUrl}</p>}{asset.sourceAuthor && <p>Автор: {asset.sourceAuthor}</p>}<SafeMarkdown text={asset.noteMarkdown} /></div>}
    </div></section>;
}

function Trash({ project, service, run }: { project: Project; service: WorkbenchService; run: Run }) {
  const batches = activeTrashBatches(project);
  return <section className="tw-trash"><h2>Корзина</h2><p className="tw-muted">Удаление из графа сохраняет Markdown и оригиналы файлов. Восстановление возвращает пакет удаления вместе со связями.</p>{batches.length ? [...batches].reverse().map((batch) => <article key={batch.id} className="tw-trash-batch"><div><strong>{date(batch.createdAt)}</strong><ul>{batch.nodeIds.map((id) => <li key={id}>{project.nodes.find((node) => node.id === id)?.title ?? id}</li>)}{batch.relationIds.map((id) => <li key={id}>Связь: {project.relations.find((relation) => relation.id === id)?.label || 'Без подписи'}</li>)}</ul></div><button onClick={() => void run(() => service.execute([{ kind: 'trash.restore', batchId: batch.id }]))}>Восстановить</button></article>) : <div className="tw-empty"><h3>Корзина пуста</h3></div>}</section>;
}

function useDraftState<T>(service: WorkbenchService, key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const store = metadataDrafts(service);
  const first = useRef(initial);
  const get = useCallback(() => store.has(key) ? store.get<T>(key)! : first.current, [store, key]);
  const value = useSyncExternalStore(store.subscribe, get, get);
  const update = useCallback<React.Dispatch<React.SetStateAction<T>>>((next) => {
    const previous = store.has(key) ? store.get<T>(key)! : first.current;
    store.set(key, typeof next === 'function' ? (next as (value: T) => T)(previous) : next);
  }, [store, key]);
  return [value, update];
}

function useDraftField<T>(service: WorkbenchService, key: string, name: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  return useDraftState(service, `${key}/${name}`, initial);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="tw-field"><span>{label}</span>{children}</label>; }
function AssessmentFields({ assessment, confidence, onAssessment, onConfidence }: { assessment: Assessment; confidence: Confidence; onAssessment: (value: Assessment) => void; onConfidence: (value: Confidence) => void }) {
  return <div className="tw-form-columns"><Field label="Оценка"><select value={assessment} onChange={(event) => onAssessment(event.target.value as Assessment)}>{Object.entries(assessmentNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field><Field label="Уверенность"><select value={confidence ?? ''} onChange={(event) => onConfidence(event.target.value as Confidence || null)}><option value="">Не указана</option>{Object.entries(confidenceNames).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field></div>;
}

function AttributeEditor({ values, onChange }: { values: Attribute[]; onChange: (values: Attribute[]) => void }) {
  const update = (id: ID, changes: Partial<Attribute>) => onChange(values.map((item) => item.id === id ? { ...item, ...changes } : item));
  return <section><div className="tw-section-heading"><h3>Типизированные атрибуты</h3><button type="button" onClick={() => onChange([...values, { id: uid(), key: '', valueType: 'text', value: '', sortOrder: values.length }])}>+ Атрибут</button></div>{values.map((item, index) => <div className="tw-edit-block" key={item.id}><div className="tw-form-columns"><Field label="Название"><input required value={item.key} onChange={(event) => update(item.id, { key: event.target.value })} /></Field><Field label="Тип"><select value={item.valueType} onChange={(event) => { const kind = event.target.value as AttributeKind; update(item.id, { valueType: kind, value: kind === 'boolean' ? false : kind === 'number' ? 0 : kind === 'date' ? { value: '', precision: 'day' } : kind === 'geo' ? { latitude: 0, longitude: 0, accuracyMeters: null } : '' }); }}>{Object.entries(attributeNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field></div>
      <label className="tw-check"><input type="checkbox" checked={item.value === null} onChange={(event) => update(item.id, { value: event.target.checked ? null : item.valueType === 'boolean' ? false : item.valueType === 'number' ? 0 : item.valueType === 'date' ? { value: '', precision: 'day' } : item.valueType === 'geo' ? { latitude: 0, longitude: 0, accuracyMeters: null } : '' })} />Значение неизвестно</label>
      {item.value !== null && (item.valueType === 'boolean' ? <Field label="Значение"><select value={String(item.value)} onChange={(event) => update(item.id, { value: event.target.value === 'true' })}><option value="true">Да</option><option value="false">Нет</option></select></Field> : item.valueType === 'date' && typeof item.value === 'object' && 'precision' in item.value ? <div className="tw-form-columns"><Field label="Дата"><input required pattern={item.value.precision === 'year' ? '\\d{4}' : item.value.precision === 'month' ? '\\d{4}-\\d{2}' : '\\d{4}-\\d{2}-\\d{2}'} title="ГГГГ, ГГГГ-ММ или ГГГГ-ММ-ДД согласно точности" value={item.value.value} onChange={(event) => update(item.id, { value: { value: event.target.value, precision: (item.value as { precision: 'year' | 'month' | 'day' }).precision } })} /></Field><Field label="Точность"><select value={item.value.precision} onChange={(event) => update(item.id, { value: { value: (item.value as { value: string }).value, precision: event.target.value as 'year' | 'month' | 'day' } })}><option value="day">День</option><option value="month">Месяц</option><option value="year">Год</option></select></Field></div> : item.valueType === 'geo' && typeof item.value === 'object' && 'latitude' in item.value ? <div className="tw-form-columns"><Field label="Широта"><input type="number" step="any" min="-90" max="90" required value={item.value.latitude} onChange={(event) => update(item.id, { value: { ...(item.value as { latitude: number; longitude: number; accuracyMeters: number | null }), latitude: Number(event.target.value) } })} /></Field><Field label="Долгота"><input type="number" step="any" min="-180" max="180" required value={item.value.longitude} onChange={(event) => update(item.id, { value: { ...(item.value as { latitude: number; longitude: number; accuracyMeters: number | null }), longitude: Number(event.target.value) } })} /></Field><Field label="Точность, м"><input type="number" step="any" min="0.000001" value={item.value.accuracyMeters ?? ''} onChange={(event) => update(item.id, { value: { ...(item.value as { latitude: number; longitude: number; accuracyMeters: number | null }), accuracyMeters: event.target.value ? Number(event.target.value) : null } })} /></Field></div> : <Field label="Значение"><input required type={item.valueType === 'number' ? 'number' : item.valueType === 'url' ? 'url' : item.valueType === 'datetime' ? 'datetime-local' : 'text'} step={item.valueType === 'number' ? 'any' : undefined} value={item.valueType === 'datetime' ? localDateTime(item.value) : typeof item.value === 'object' ? '' : String(item.value)} onChange={(event) => update(item.id, { value: item.valueType === 'number' ? Number(event.target.value) : item.valueType === 'datetime' && event.target.value ? new Date(event.target.value).toISOString() : event.target.value })} /></Field>)}
      <div className="tw-row"><button type="button" disabled={index === 0} onClick={() => { const reordered = [...values]; [reordered[index - 1], reordered[index]] = [reordered[index]!, reordered[index - 1]!]; onChange(reordered.map((value, order) => ({ ...value, sortOrder: order }))); }}>Выше</button><button type="button" className="tw-danger" onClick={() => onChange(values.filter((value) => value.id !== item.id))}>Удалить атрибут</button></div>
    </div>)}</section>;
}

function EvidenceEditor({ values, project, onChange }: { values: Evidence[]; project: Project; onChange: (values: Evidence[]) => void }) {
  const update = (id: ID, changes: Partial<Evidence>) => onChange(values.map((item) => item.id === id ? { ...item, ...changes } : item));
  return <section><div className="tw-section-heading"><h3>Источники</h3><button type="button" onClick={() => onChange([...values, { id: uid(), sourceKind: 'url', sourceNodeId: null, assetId: null, url: '', label: '', quote: null, locator: null, note: null, accessedAt: null }])}>+ Источник</button></div>{values.map((item) => <div className="tw-edit-block" key={item.id}><div className="tw-form-columns"><Field label="Подпись"><input value={item.label} onChange={(event) => update(item.id, { label: event.target.value })} /></Field><Field label="Вид источника"><select value={item.sourceKind} onChange={(event) => update(item.id, { sourceKind: event.target.value as Evidence['sourceKind'], sourceNodeId: null, assetId: null, url: null })}><option value="url">URL</option><option value="node">Документ</option><option value="asset">Материал</option></select></Field></div>
      {item.sourceKind === 'url' ? <Field label="URL"><input required type="url" value={item.url ?? ''} onChange={(event) => update(item.id, { url: event.target.value })} /></Field> : item.sourceKind === 'node' ? <Field label="Документ"><select required value={item.sourceNodeId ?? ''} onChange={(event) => update(item.id, { sourceNodeId: event.target.value })}><option value="">Выберите документ</option>{project.nodes.filter((node) => !node.deletedAt).map((node) => <option value={node.id} key={node.id}>{node.title}</option>)}</select></Field> : <Field label="Материал"><select required value={item.assetId ?? ''} onChange={(event) => update(item.id, { assetId: event.target.value })}><option value="">Выберите материал</option>{project.assets.filter((asset) => !asset.deletedAt).map((asset) => <option key={asset.id} value={asset.id}>{asset.title}</option>)}</select></Field>}
      <Field label="Цитата"><textarea value={item.quote ?? ''} onChange={(event) => update(item.id, { quote: event.target.value || null })} /></Field><Field label="Локатор: страница, таймкод, раздел"><input value={item.locator ?? ''} onChange={(event) => update(item.id, { locator: event.target.value || null })} /></Field><Field label="Комментарий"><textarea value={item.note ?? ''} onChange={(event) => update(item.id, { note: event.target.value || null })} /></Field><Field label="Дата обращения"><input type="date" value={item.accessedAt?.slice(0, 10) ?? ''} onChange={(event) => update(item.id, { accessedAt: event.target.value ? `${event.target.value}T00:00:00.000Z` : null })} /></Field><button className="tw-danger" type="button" onClick={() => onChange(values.filter((value) => value.id !== item.id))}>Удалить источник</button>
    </div>)}</section>;
}

function NodeEditor({ project, node, service, submit, close, draftKey }: { project: Project; node: ProjectNode; service: WorkbenchService; submit: (operation: () => Promise<unknown>) => void; close: () => void; draftKey: string }) {
  const [title, setTitle] = useDraftField(service, draftKey, "title", node.title), [typeId, setTypeId] = useDraftField(service, draftKey, "typeId", node.typeId), [emoji, setEmoji] = useDraftField(service, draftKey, "emoji", node.iconEmoji ?? ''), [assessment, setAssessment] = useDraftField(service, draftKey, "assessment", node.assessment), [confidence, setConfidence] = useDraftField(service, draftKey, "confidence", node.confidence), [attributes, setAttributes] = useDraftField(service, draftKey, "attributes", node.attributes), [evidence, setEvidence] = useDraftField(service, draftKey, "evidence", node.evidence), [path, setPath] = useDraftField(service, draftKey, "path", node.notePath), [groupMode, setGroupMode] = useDraftField<'group_only' | 'group_with_members'>(service, draftKey, "groupMode", 'group_only');
  const members = project.memberships.filter((item) => item.groupNodeId === node.id);
  const [memberIds, setMemberIds] = useDraftField(service, draftKey, "memberIds", members.map((item) => item.memberNodeId));
  const isGroup = project.nodeTypes.find((item) => item.id === node.typeId)?.code === 'group';
  return <form onSubmit={(event) => { event.preventDefault(); submit(async () => { const commands: Command[] = [{ kind: 'node.update', nodeId: node.id, changes: { title, typeId, iconEmoji: emoji || null, assessment, confidence, attributes, evidence } }]; if (isGroup) commands.push({ kind: 'group.members', groupId: node.id, nodeIds: memberIds }); await service.execute(commands); if (path !== node.notePath) { try { await service.relinkNote(node.id, path); } catch (error) { throw new Error(`Метаданные сохранены, но перепривязка заметки не выполнена: ${errorText(error)}`); } } }); }}>
    <Field label="Название"><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} /></Field><div className="tw-form-columns"><Field label="Тип"><select required value={typeId} onChange={(event) => setTypeId(event.target.value)}>{project.nodeTypes.filter((item) => !item.isHidden || item.id === node.typeId).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Эмодзи этой карточки"><input value={emoji} onChange={(event) => setEmoji(event.target.value)} aria-describedby="tw-emoji-help" /><small id="tw-emoji-help">Пусто — использовать значок типа.</small></Field></div><AssessmentFields assessment={assessment} confidence={confidence} onAssessment={setAssessment} onConfidence={setConfidence} />
    <h3>Привязка заметки</h3><VaultNotePicker notes={service.listNotes()} value={path} onChange={setPath} /><p className="tw-muted">Перепривязка сохраняет ID и все связи. Текст выбранного файла не перезаписывается.</p>
    <div className="tw-row"><button type="button" onClick={() => setTitle(node.notePath.split('/').at(-1)?.replace(/\.md$/i, '') ?? title)}>Взять название из имени файла</button></div>
    {isGroup && <Field label="Состав группы"><div className="tw-checkbox-list">{project.nodes.filter((item) => !item.deletedAt && item.id !== node.id && project.nodeTypes.find((type) => type.id === item.typeId)?.code !== 'group').map((item) => <label className="tw-check" key={item.id}><input type="checkbox" checked={memberIds.includes(item.id)} onChange={(event) => setMemberIds(event.target.checked ? [...memberIds, item.id] : memberIds.filter((id) => id !== item.id))} />{item.title}</label>)}</div></Field>}
    <AttributeEditor values={attributes} onChange={setAttributes} /><EvidenceEditor values={evidence} project={project} onChange={setEvidence} /><div className="tw-dialog-actions"><button type="button" onClick={close}>Отмена</button><button type="submit" className="mod-cta">Сохранить метаданные</button></div>
    <section className="tw-danger-zone"><h3>Удаление из исследования</h3>{isGroup && <><button type="button" onClick={() => submit(() => service.execute([{ kind: 'group.ungroup', groupId: node.id }]))}>Разгруппировать</button><Field label="Что отправить в корзину"><select value={groupMode} onChange={(event) => setGroupMode(event.target.value as typeof groupMode)}><option value="group_only">Только группу</option><option value="group_with_members">Группу и документы внутри</option></select></Field></>}<button type="button" className="tw-danger" onClick={() => submit(() => service.execute([{ kind: 'elements.trash', nodeIds: [node.id], relationIds: [], groupMode }]))}>Отправить в корзину</button><p className="tw-muted">Файлы заметок и оригиналы сохраняются. Отменить действие можно через историю или корзину.</p></section>
  </form>;
}

function RelationEditor({ project, relation, source, target, service, submit, close, draftKey }: { project: Project; relation?: Relation; source?: ID; target?: ID; service: WorkbenchService; submit: (operation: () => Promise<unknown>) => void; close: () => void; draftKey: string }) {
  const active = project.nodes.filter((node) => !node.deletedAt);
  const [from, setFrom] = useDraftField(service, draftKey, "from", relation?.sourceNodeId ?? source ?? active[0]?.id ?? ''), [to, setTo] = useDraftField(service, draftKey, "to", relation?.targetNodeId ?? target ?? active.find((node) => node.id !== source)?.id ?? ''), [label, setLabel] = useDraftField(service, draftKey, "label", relation?.label ?? ''), [direction, setDirection] = useDraftField(service, draftKey, "direction", relation?.bidirectional ? 'both' : relation?.directed === false ? 'none' : 'forward'), [assessment, setAssessment] = useDraftField<Assessment>(service, draftKey, "assessment", relation?.assessment ?? 'unreviewed'), [confidence, setConfidence] = useDraftField<Confidence>(service, draftKey, "confidence", relation?.confidence ?? null), [note, setNote] = useDraftField(service, draftKey, "note", relation?.noteMarkdown ?? ''), [evidence, setEvidence] = useDraftField<Evidence[]>(service, draftKey, "evidence", relation?.evidence ?? []);
  return <form onSubmit={(event) => { event.preventDefault(); if (from === to) return; const timestamp = now(); const value: Relation = { id: relation?.id ?? uid(), sourceNodeId: from, targetNodeId: to, relationType: relation?.relationType ?? 'related', label: label.trim() || null, directed: direction !== 'none', bidirectional: direction === 'both', assessment, confidence, noteMarkdown: note, evidence, deletedAt: null, deletionBatchId: null, createdAt: relation?.createdAt ?? timestamp, updatedAt: timestamp, origin: relation?.origin ?? {} }; const { id: _id, createdAt: _createdAt, deletedAt: _deletedAt, deletionBatchId: _batch, ...changes } = value; submit(() => service.execute([relation ? { kind: 'relation.update', relationId: relation.id, changes } : { kind: 'relation.create', relation: value }])); }}>
    <div className="tw-form-columns"><Field label="От документа"><select required value={from} onChange={(event) => setFrom(event.target.value)}>{active.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></Field><Field label="К документу"><select required value={to} onChange={(event) => setTo(event.target.value)}>{active.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></Field></div>{from === to && <p className="tw-error">Выберите два разных документа.</p>}
<Field label="Направление"><select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="forward">Направленная →</option><option value="both">Двусторонняя ↔</option><option value="none">Без направления —</option></select></Field><Field label="Подпись (необязательно)"><input value={label} onChange={(event) => setLabel(event.target.value)} /></Field><AssessmentFields assessment={assessment} confidence={confidence} onAssessment={setAssessment} onConfidence={setConfidence} /><Field label="Комментарий Markdown"><textarea rows={5} value={note} onChange={(event) => setNote(event.target.value)} /></Field><EvidenceEditor values={evidence} project={project} onChange={setEvidence} /><p className="tw-muted">Между одной парой документов можно создать несколько самостоятельных отношений.</p><div className="tw-dialog-actions"><button type="button" onClick={close}>Отмена</button><button type="submit" className="mod-cta" disabled={from === to || !from || !to}>Сохранить связь</button></div>
  </form>;
}

function AssetEditor({ asset, service, submit, close, draftKey }: { asset: Asset; service: WorkbenchService; submit: (operation: () => Promise<unknown>) => void; close: () => void; draftKey: string }) {
  const [title, setTitle] = useDraftField(service, draftKey, "title", asset.title), [url, setUrl] = useDraftField(service, draftKey, "url", asset.sourceUrl ?? ''), [author, setAuthor] = useDraftField(service, draftKey, "author", asset.sourceAuthor ?? ''), [createdAt, setCreatedAt] = useDraftField(service, draftKey, "createdAt", asset.sourceCreatedAt?.slice(0, 10) ?? ''), [note, setNote] = useDraftField(service, draftKey, "note", asset.noteMarkdown);
  return <form onSubmit={(event) => { event.preventDefault(); submit(() => service.execute([{ kind: 'asset.update', assetId: asset.id, changes: { title, sourceUrl: url || null, sourceAuthor: author || null, sourceCreatedAt: createdAt ? `${createdAt}T00:00:00.000Z` : null, noteMarkdown: note } }])); }}><Field label="Название"><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Field label="URL источника"><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} /></Field><Field label="Автор источника"><input value={author} onChange={(event) => setAuthor(event.target.value)} /></Field><Field label="Дата оригинала"><input type="date" value={createdAt} onChange={(event) => setCreatedAt(event.target.value)} /></Field><Field label="Комментарий Markdown"><textarea rows={5} value={note} onChange={(event) => setNote(event.target.value)} /></Field><div className="tw-dialog-actions"><button type="button" onClick={close}>Отмена</button><button type="submit" className="mod-cta">Сохранить</button></div></form>;
}

function ResourceDialog({ service, selectedNodeId, submit }: { service: WorkbenchService; selectedNodeId?: ID; submit: (operation: () => Promise<unknown>) => void }) {
  const [candidates, setCandidates] = useState<ResourceCandidate[] | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => { let current = true; service.discoverResources().then((value) => { if (current) setCandidates(value); }).catch((reason: unknown) => { if (current) setError(errorText(reason)); }); return () => { current = false; }; }, [service]);
  return <div><p>Каталог учитывает файлы любого расширения, в том числе невидимые в проводнике Obsidian.</p>{error && <p className="tw-error">{error}</p>}{candidates === null && !error ? <p>Сканирование папки ресурсов…</p> : candidates?.length ? <div className="tw-resource-candidates">{candidates.map((item) => <div className="tw-resource-candidate" key={item.path}><div><strong>{item.path}</strong><small>{bytes(item.byteSize)}</small></div>{item.registered ? <span className="tw-muted">В каталоге</span> : <button onClick={() => submit(() => service.registerResource(item.path, selectedNodeId))}>Зарегистрировать</button>}</div>)}</div> : !error && <p className="tw-muted">В настроенной папке ресурсов файлы не найдены.</p>}</div>;
}

function TypesEditor({ project, service, submit, draftKey }: { project: Project; service: WorkbenchService; submit: (operation: () => Promise<unknown>) => void; draftKey: string }) {
  const [editing, setEditing] = useDraftField<NodeType>(service, draftKey, "editing", { id: uid(), code: '', name: '', color: '#5e7cea', iconKey: 'file-text', isHidden: false, isSystem: false });
  const [pendingType, setPendingType] = useState<NodeType | null>(null);
  const existing = project.nodeTypes.find((type) => type.id === editing.id);
  const changed = existing ? Object.entries(editing).some(([key, value]) => existing[key as keyof NodeType] !== value) : editing.name !== '' || editing.code !== '' || editing.color !== '#5e7cea' || editing.isHidden || editing.iconKey !== 'file-text';
  const choose = (type: NodeType) => { if (changed) setPendingType(type); else setEditing(type); };
  return <div><div className="tw-type-list">{project.nodeTypes.map((type) => <button key={type.id} onClick={() => choose({ ...type })}><span style={{ background: type.color }} />{type.name}{type.isHidden ? ' (скрыт)' : ''}</button>)}</div><button onClick={() => choose({ id: uid(), code: '', name: '', color: '#5e7cea', iconKey: 'file-text', isHidden: false, isSystem: false })}>+ Новый тип</button>{pendingType && <section className="tw-callout" role="alert"><strong>Текущий тип изменён</strong><p>Отбросить его несохранённые изменения и перейти к другому типу?</p><div className="tw-row"><button onClick={() => setPendingType(null)}>Продолжить редактирование</button><button className="tw-danger" onClick={() => { setEditing(pendingType); setPendingType(null); }}>Отбросить и выбрать</button></div></section>}<form onSubmit={(event) => { event.preventDefault(); submit(() => service.execute([{ kind: 'type.upsert', type: editing }])); }}><Field label="Название"><input required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></Field><Field label="Код"><input required pattern="[a-z][a-z0-9_-]*" readOnly={!!existing} value={editing.code} onChange={(event) => setEditing({ ...editing, code: event.target.value })} /></Field><Field label="Значок типа"><select value={editing.iconKey} onChange={(event) => setEditing({ ...editing, iconKey: event.target.value })}>{NODE_ICON_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}</select></Field><Field label="Цвет"><input type="color" value={editing.color} onChange={(event) => setEditing({ ...editing, color: event.target.value })} /></Field><label className="tw-check"><input type="checkbox" checked={editing.isHidden} onChange={(event) => setEditing({ ...editing, isHidden: event.target.checked })} />Скрыть тип в списке создания</label><div className="tw-dialog-actions"><button type="submit" className="mod-cta">Сохранить тип</button></div></form></div>;
}

function Dialog({ state, project, service, close, selection, selectedId, ownerDocument }: { state: Exclude<DialogState, null>; project: Project | null; service: WorkbenchService; close: () => void; selection: ID[]; selectedId: ID | null; ownerDocument: Document }) {
  const draftKey = `${project?.id ?? 'vault'}/${state.kind}/${'id' in state ? state.id ?? 'new' : 'new'}/${'source' in state ? state.source ?? '' : ''}/${'target' in state ? state.target ?? '' : ''}`;
  const store = metadataDrafts(service);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirmClose, setConfirmClose] = useState(false);
  const [title, setTitle] = useDraftField(service, draftKey, 'title', ''), [path, setPath] = useDraftField(service, draftKey, 'path', ''), [typeId, setTypeId] = useDraftField(service, draftKey, 'typeId', project?.nodeTypes.find((type) => !type.isHidden && type.code !== 'group')?.id ?? ''), [members, setMembers] = useDraftField<ID[]>(service, draftKey, 'members', selection), [assetId, setAssetId] = useDraftField(service, draftKey, 'assetId', ''), [caption, setCaption] = useDraftField(service, draftKey, 'caption', '');
  const dirty = useSyncExternalStore(store.subscribe, () => store.hasPrefix(draftKey), () => false);
  const persistence = useSyncExternalStore(store.subscribe, () => store.status(project?.id ?? 'vault'), () => store.status(project?.id ?? 'vault'));
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const requestClose = useCallback(() => { if (dirtyRef.current) setConfirmClose(true); else close(); }, [close]);
  const discard = () => { store.clearPrefix(draftKey); close(); };
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = ownerDocument.activeElement as HTMLElement | null;
    const focusable = () => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') ?? [])];
    const initialControl = panel.current?.querySelector<HTMLElement>('.tw-dialog-body input:not(:disabled), .tw-dialog-body select:not(:disabled), .tw-dialog-body textarea:not(:disabled)');
    (initialControl ?? focusable()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); requestClose(); }
      if (event.key === 'Tab') { const list = focusable(); const first = list[0], last = list.at(-1); if (event.shiftKey && ownerDocument.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && ownerDocument.activeElement === last) { event.preventDefault(); first?.focus(); } }
    };
    const currentPanel = panel.current;
    currentPanel?.addEventListener('keydown', onKey);
    return () => { currentPanel?.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [ownerDocument, requestClose, busy]);
  useEffect(() => { if (confirmClose) panel.current?.querySelector<HTMLElement>('.tw-discard-confirm button')?.focus(); }, [confirmClose]);
  const submit = (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    operation().then(() => { store.clearPrefix(draftKey); close(); }).catch((reason: unknown) => setError(errorText(reason))).finally(() => setBusy(false));
  };
  const titles: Record<NonNullable<DialogState>['kind'], string> = { project: 'Новое исследование', note: 'Новый документ', adopt: 'Подключить заметку из vault', group: 'Создать группу', report: 'Снимок отчёта', settings: 'Исследование', node: 'Метаданные документа', relation: state.kind === 'relation' && state.id ? 'Изменить связь' : 'Новая связь', asset: 'Метаданные материала', types: 'Типы документов', resources: 'Каталог файлов', reports: 'Снимки отчётов', attach: 'Привязать материал' };
  const node = state.kind === 'node' ? project?.nodes.find((item) => item.id === state.id) : undefined;
  const asset = state.kind === 'asset' ? project?.assets.find((item) => item.id === state.id) : undefined;
  return <div className="tw-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) requestClose(); }}><div className="tw-modal" ref={panel} role="dialog" aria-modal="true" aria-label={titles[state.kind]}><div className="tw-modal-heading"><h2>{titles[state.kind]}</h2><button aria-label="Закрыть диалог" disabled={busy} onClick={requestClose}>×</button></div>{error && <p className="tw-error" role="alert">{error}</p>}{dirty && <p className="tw-draft-notice">{!project ? 'Черновик в памяти до создания исследования.' : persistence.error ? 'Черновик пока только в памяти: запись в .twdata не завершена.' : persistence.pending ? 'Сохранение черновика в .twdata…' : store.hasRestoredPrefix(draftKey) ? 'Восстановлен черновик метаданных. Проверьте значения и сохраните или отбросьте изменения.' : 'Черновик сохранён в .twdata. Основная модель изменится после сохранения формы.'}</p>}{project && !persistence.hydrated && <p className="tw-draft-notice">{persistence.error ? 'Загрузка черновиков не завершена. Используйте повторную попытку в сообщении об ошибке.' : 'Загрузка сохранённых черновиков…'}</p>}{project && persistence.error && <div className="tw-callout" role="alert"><p>{persistence.error}</p><button onClick={() => { setError(null); void (persistence.hydrated ? store.flush(project.id) : store.hydrate(service, project.id)).catch((reason: unknown) => setError(errorText(reason))); }}>{persistence.hydrated ? 'Повторить запись черновиков' : 'Повторить загрузку черновиков'}</button></div>}<fieldset disabled={busy || confirmClose || !!project && !persistence.hydrated} className="tw-dialog-body">
    {state.kind === 'node' && project && node && <NodeEditor key={node.id} project={project} node={node} service={service} submit={submit} close={requestClose} draftKey={draftKey} />}
    {state.kind === 'relation' && project && <RelationEditor project={project} relation={project.relations.find((item) => item.id === state.id)} source={state.source} target={state.target} service={service} submit={submit} close={requestClose} draftKey={draftKey} />}
    {state.kind === 'asset' && asset && <AssetEditor asset={asset} service={service} submit={submit} close={requestClose} draftKey={draftKey} />}
    {state.kind === 'types' && project && <TypesEditor project={project} service={service} submit={submit} draftKey={draftKey} />}
    {state.kind === 'resources' && <ResourceDialog service={service} selectedNodeId={selectedId && project?.nodes.some((item) => item.id === selectedId) ? selectedId : undefined} submit={submit} />}
    {state.kind === 'reports' && project && <div>{project.snapshots.length ? [...project.snapshots].reverse().map((snapshot) => <div className="tw-resource-candidate" key={snapshot.id}><div><strong>{snapshot.title}</strong><small>{date(snapshot.createdAt)} · ревизия {snapshot.sourceRevision}</small></div><button onClick={() => submit(() => service.openReport(snapshot.id))}>Открыть</button></div>) : <p className="tw-muted">Снимков пока нет. Создайте отчёт из текущего состояния исследования.</p>}</div>}
    {state.kind === 'settings' && project && <ProjectSettings project={project} service={service} submit={submit} close={requestClose} draftKey={draftKey} />}
    {['project', 'note', 'adopt', 'group', 'report', 'attach'].includes(state.kind) && <form onSubmit={(event) => { event.preventDefault(); submit(async () => {
      if (state.kind === 'project') await service.createProject(title);
      else if (state.kind === 'note') await service.createNote(title, typeId);
      else if (state.kind === 'adopt') await service.adoptNote(path);
      else if (state.kind === 'group') await service.createGroup(title, members);
      else if (state.kind === 'report') { const snapshot = await service.createReport(title, selection.length ? selection : undefined); await service.openReport(snapshot.id); }
      else if (state.kind === 'attach' && selectedId) await service.execute([{ kind: 'attachment.attach', attachment: { id: uid(), nodeId: selectedId, assetId, role: 'attachment', sortOrder: project?.attachments.filter((item) => item.nodeId === selectedId).length ?? 0, caption: caption || null } }]);
    }); }}>
      {!['adopt', 'attach'].includes(state.kind) && <Field label="Название"><input autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} /></Field>}
      {state.kind === 'note' && project && <Field label="Тип документа"><select value={typeId} onChange={(event) => setTypeId(event.target.value)}>{project.nodeTypes.filter((item) => !item.isHidden && item.code !== 'group').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
      {state.kind === 'adopt' && <><VaultNotePicker notes={service.listNotes().filter((item) => !project?.nodes.some((node) => node.notePath === item.path))} value={path} onChange={setPath} /><p className="tw-muted">Подключение не копирует заметку и не перемещает её. Редактируйте этот же файл в обычном редакторе Obsidian: изменения будут видны в TraceWeave. Properties и служебные файлы рядом с заметкой не создаются; привязка хранится в .twdata.</p></>}
      {state.kind === 'group' && project && <Field label="Документы группы"><div className="tw-checkbox-list">{project.nodes.filter((item) => !item.deletedAt && project.nodeTypes.find((type) => type.id === item.typeId)?.code !== 'group').map((item) => <label className="tw-check" key={item.id}><input type="checkbox" checked={members.includes(item.id)} onChange={(event) => setMembers(event.target.checked ? [...members, item.id] : members.filter((id) => id !== item.id))} />{item.title}</label>)}</div></Field>}
      {state.kind === 'report' && <p className="tw-muted">{selection.length ? `Включены выбранные документы: ${selection.length}.` : 'Включены все активные документы.'} Снимок сохранит текущие тексты и не изменится при последующем редактировании заметок.</p>}
      {state.kind === 'attach' && project && <><Field label="Материал"><select autoFocus required value={assetId} onChange={(event) => setAssetId(event.target.value)}><option value="">Выберите файл</option>{project.assets.filter((item) => !item.deletedAt && !project.attachments.some((attachment) => attachment.nodeId === selectedId && attachment.assetId === item.id)).map((item) => <option value={item.id} key={item.id}>{item.title} · {bytes(item.byteSize)}</option>)}</select></Field><Field label="Подпись привязки"><input value={caption} onChange={(event) => setCaption(event.target.value)} /></Field></>}
      <div className="tw-dialog-actions"><button type="button" onClick={requestClose}>Отмена</button><button className="mod-cta" type="submit" disabled={state.kind === 'adopt' && !path}>{state.kind === 'adopt' ? 'Подключить' : state.kind === 'attach' ? 'Привязать' : 'Создать'}</button></div>
    </form>}
  </fieldset>{busy && <p role="status" className="tw-muted">Сохранение…</p>}{confirmClose && <section className="tw-discard-confirm" role="alertdialog" aria-label="Несохранённые изменения"><h3>Есть несохранённые изменения</h3><p>Закрыть форму и отбросить введённые метаданные?</p><div className="tw-row"><button className="mod-cta" onClick={() => setConfirmClose(false)}>Продолжить редактирование</button><button className="tw-danger" onClick={discard}>Отбросить изменения</button></div></section>}</div></div>;
}

function ProjectSettings({ project, service, submit, close, draftKey }: { project: Project; service: WorkbenchService; submit: (operation: () => Promise<unknown>) => void; close: () => void; draftKey: string }) {
  const [title, setTitle] = useDraftField(service, draftKey, "title", project.title), [description, setDescription] = useDraftField(service, draftKey, "description", project.descriptionMarkdown);
  return <form onSubmit={(event) => { event.preventDefault(); submit(() => service.execute([{ kind: 'project.update', changes: { title, descriptionMarkdown: description } }])); }}><Field label="Название"><input required value={title} onChange={(event) => setTitle(event.target.value)} /></Field><Field label="Описание Markdown"><textarea rows={6} value={description} onChange={(event) => setDescription(event.target.value)} /></Field><p className="tw-muted">Ревизия: {project.revision}. Технические данные: .twdata/projects/{project.id}/</p><div className="tw-dialog-actions"><button type="button" onClick={close}>Отмена</button><button type="submit" className="mod-cta">Сохранить</button></div><section className="tw-danger-zone"><h3>{project.status === 'archived' ? 'Исследование в архиве' : 'Архивирование'}</h3><p>Файлы остаются в хранилище. Исследование можно вернуть из архива.</p><button type="button" onClick={() => submit(() => service.execute([{ kind: 'project.update', changes: { status: project.status === 'archived' ? 'active' : 'archived' } }]))}>{project.status === 'archived' ? 'Вернуть из архива' : 'Архивировать исследование'}</button></section></form>;
}

function Workbench({ container, service }: { container: HTMLElement; service: WorkbenchService }) {
  const subscribe = useCallback((listener: () => void) => service.subscribe(listener), [service]);
  const getSnapshot = useCallback(() => service.getSnapshot(), [service]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const project = snapshot.project;
  const drafts = metadataDrafts(service);
  const draftStatus = useSyncExternalStore(drafts.subscribe, () => drafts.status(project?.id ?? 'vault'), () => drafts.status(project?.id ?? 'vault'));
  const [view, setView] = useState<ViewState>(defaultView), [viewLoaded, setViewLoaded] = useState(false), [dialog, setDialog] = useState<DialogState>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState(''), [query, setQuery] = useState(''), [typeFilter, setTypeFilter] = useState(''), [assessmentFilter, setAssessmentFilter] = useState(''), [groupFilter, setGroupFilter] = useState(''), [searchIds, setSearchIds] = useState<Set<ID> | null>(null), [searching, setSearching] = useState(false), [selection, setSelection] = useState<ID[]>([]), [aggregate, setAggregate] = useState<ID[]>([]), [compact, setCompact] = useState(false), [narrow, setNarrow] = useState(false), [inspectorOpen, setInspectorOpen] = useState(true);
  const filesInput = useRef<HTMLInputElement>(null), archiveInput = useRef<HTMLInputElement>(null), importTarget = useRef<ID | undefined>(undefined);
  const run = useCallback<Run>(async (operation) => { setError(null); try { await operation(); } catch (reason) { setError(errorText(reason)); } }, []);
  useEffect(() => {
    if (project) void drafts.hydrate(service, project.id).catch(() => { /* The subscribed draft status displays the exact error and retry action. */ });
  }, [drafts, service, project?.id]);
  useEffect(() => {
    const Observer = container.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer((entries) => { const width = entries[0]?.contentRect.width ?? 1200; setCompact(width < 980); setNarrow(width < 560); });
    observer.observe(container); return () => observer.disconnect();
  }, [container]);
  useEffect(() => {
    let current = true; setDialog(null); setViewLoaded(false); setSelection([]); setAggregate([]); setQuery(''); setSearchIds(null); setTypeFilter(''); setAssessmentFilter(''); setGroupFilter('');
    service.loadView().then((value) => { if (current) { setView({ ...defaultView, ...value }); setViewLoaded(true); } }).catch((reason: unknown) => { if (current) { setError(errorText(reason)); setView(defaultView); setViewLoaded(true); } });
    return () => { current = false; };
  }, [service, project?.id]);
  useEffect(() => {
    if (!viewLoaded || !project) return;
    const window = container.ownerDocument.defaultView;
    const timer = window?.setTimeout(() => { service.saveView(view).catch((reason: unknown) => setError(errorText(reason))); }, 200);
    return () => { if (timer !== undefined) window?.clearTimeout(timer); };
  }, [view, viewLoaded, project?.id, service, container]);
  useEffect(() => {
    let current = true;
    if (!query.trim()) { setSearchIds(null); setSearching(false); return; }
    setSearching(true);
    const window = container.ownerDocument.defaultView;
    const timer = window?.setTimeout(() => { service.search(query).then((hits) => { if (current) { setSearchIds(new Set(hits.map((item) => item.nodeId))); setSearching(false); } }).catch((reason: unknown) => { if (current) { setError(errorText(reason)); setSearchIds(new Set()); setSearching(false); } }); }, 180);
    return () => { current = false; if (timer !== undefined) window?.clearTimeout(timer); };
  }, [query, project?.revision, service, container]);
  const visibleNodes = useMemo(() => project?.nodes.filter((node) => !node.deletedAt && (!typeFilter || node.typeId === typeFilter) && (!assessmentFilter || node.assessment === assessmentFilter) && (!groupFilter || node.id === groupFilter || project.memberships.some((member) => member.groupNodeId === groupFilter && member.memberNodeId === node.id)) && (!searchIds || searchIds.has(node.id))) ?? [], [project, typeFilter, assessmentFilter, groupFilter, searchIds]);
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const onSelect = useCallback((id: ID) => { setView((current) => ({ ...current, selectedId: id })); setInspectorOpen(true); }, []);
  const openFiles = useCallback((nodeId?: ID) => { importTarget.current = nodeId; filesInput.current?.click(); }, []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const selectedNode = project?.nodes.find((node) => node.id === view.selectedId && !node.deletedAt);
  const selectedIds = selection.length ? selection : selectedNode ? [selectedNode.id] : [];
  return <div className={`tw-obsidian${compact ? ' is-compact' : ''}${narrow ? ' is-narrow' : ''}`} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void run(() => service.importFiles(Array.from(event.dataTransfer.files), selectedNode?.id)); } }}>
    <header className="tw-header"><div className="tw-brand"><span className="tw-brand-symbol">◈</span><div><strong>TraceWeave</strong><small>Исследования в вашем хранилище</small></div></div><div className="tw-project-picker"><select aria-label="Текущее исследование" value={project?.id ?? ''} disabled={snapshot.busy} onChange={(event) => void run(() => service.openProject(event.target.value))}><option disabled value="">Выберите исследование</option>{snapshot.projects.map((item) => <option key={item.id} value={item.id}>{item.title}{item.status === 'archived' ? ' · архив' : ''}</option>)}</select><button aria-label="Создать исследование" onClick={() => setDialog({ kind: 'project' })}>+</button>{project && <button title="Настройки исследования" onClick={() => setDialog({ kind: 'settings' })}>⋯</button>}</div><div className="tw-history"><button disabled={!snapshot.canUndo || snapshot.busy} onClick={() => void run(() => service.undo())} title="Отменить последнюю операцию с метаданными">↶</button><button disabled={!snapshot.canRedo || snapshot.busy} onClick={() => void run(() => service.redo())} title="Повторить операцию с метаданными">↷</button></div></header>
    {(error || snapshot.error) && <div className="tw-banner tw-error" role="alert"><span>{error || snapshot.error}</span><button disabled={snapshot.busy} onClick={() => void run(() => service.recover())}>Проверить восстановление</button>{error && <button aria-label="Скрыть ошибку" onClick={() => setError(null)}>×</button>}</div>}
    {project && draftStatus.error && <div className="tw-banner tw-error" role="alert"><span>Не удалось сохранить или восстановить черновики: {draftStatus.error}. Введённые значения остаются в памяти.</span><button onClick={() => void run(() => draftStatus.hydrated ? drafts.flush(project.id) : drafts.hydrate(service, project.id))}>{draftStatus.hydrated ? 'Повторить запись черновиков' : 'Повторить загрузку черновиков'}</button></div>}
    {notice && <div className="tw-banner" role="status"><span>{notice}</span><button aria-label="Скрыть сообщение" onClick={() => setNotice('')}>×</button></div>}
    {snapshot.progress && <div className="tw-progress" role="status"><span>{snapshot.progress.name}: {snapshot.progress.completed} / {snapshot.progress.total}</span><progress value={snapshot.progress.completed} max={snapshot.progress.total || 1} /><button onClick={() => service.cancelImport()}>Отменить импорт</button></div>}
    {project ? <><nav className="tw-navigation" aria-label="Представление исследования">{([['graph', 'Граф'], ['dossier', 'Досье'], ['materials', 'Материалы'], ['trash', 'Корзина']] as const).map(([mode, label]) => <button key={mode} aria-pressed={view.mode === mode} onClick={() => setView((current) => ({ ...current, mode }))}>{label}{mode === 'materials' && <span>{project.assets.filter((item) => !item.deletedAt).length}</span>}{mode === 'trash' && activeTrashBatches(project).length > 0 && <span>{activeTrashBatches(project).length}</span>}</button>)}<div className="tw-nav-actions"><button onClick={() => setDialog({ kind: 'reports' })}>Снимки</button><button onClick={() => setDialog({ kind: 'report' })}>Отчёт</button><button onClick={() => void run(async () => { const path = await service.exportProject(); setNotice(`Архив сохранён: ${path}`); })}>Копия vault ZIP</button><button onClick={() => void run(async () => { const path = await service.exportTraceWeave(); setNotice(`Архив TraceWeave 2.0 сохранён: ${path}`); })}>Архив для TraceWeave</button><button onClick={() => archiveInput.current?.click()}>Импорт ZIP</button></div></nav>
      {project.status === 'archived' && <div className="tw-banner">Исследование в архиве. Вернуть его можно в настройках исследования.</div>}
      {(view.mode === 'graph' || view.mode === 'dossier') && <div className="tw-toolbar"><div className="tw-search"><span>⌕</span><input type="search" aria-label="Поиск по исследованию" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по текстам и метаданным" />{searching && <small>Поиск…</small>}</div><select aria-label="Фильтр по типу" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">Все типы</option>{project.nodeTypes.map((type) => <option value={type.id} key={type.id}>{type.name}</option>)}</select><select aria-label="Фильтр по оценке" value={assessmentFilter} onChange={(event) => setAssessmentFilter(event.target.value)}><option value="">Все оценки</option>{Object.entries(assessmentNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select><select aria-label="Фильтр по группе" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}><option value="">Все группы</option>{project.nodes.filter((node) => !node.deletedAt && project.nodeTypes.find((type) => type.id === node.typeId)?.code === 'group').map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select><button className="mod-cta" onClick={() => setDialog({ kind: 'note' })}>+ Документ</button><button onClick={() => setDialog({ kind: 'adopt' })}>Подключить заметку из vault</button><button onClick={() => setDialog({ kind: 'group' })}>Группа</button><button onClick={() => setDialog({ kind: 'types' })}>Типы</button><button aria-pressed={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}>Просмотр</button></div>}
      {selection.length > 1 && view.mode === 'graph' && <div className="tw-selection-bar"><span>Выбрано: {selection.length}</span><button onClick={() => setDialog({ kind: 'group' })}>Сгруппировать</button><button className="tw-danger" onClick={() => void run(() => service.execute([{ kind: 'elements.trash', nodeIds: selection, relationIds: [], groupMode: 'group_only' }]))}>В корзину</button></div>}
      <main className={`tw-workspace${(view.mode === 'graph' || view.mode === 'dossier') && inspectorOpen ? ' with-inspector' : ''}`}>
        {view.mode === 'graph' && viewLoaded && <Graph project={project} service={service} view={view} setView={setView} visibleIds={visibleIds} run={run} setDialog={setDialog} selection={selection} setSelection={setSelection} setAggregate={setAggregate} />}
        {view.mode === 'dossier' && <Dossier project={project} nodes={visibleNodes} selectedId={view.selectedId} onSelect={onSelect} />}
        {view.mode === 'materials' && <Materials project={project} service={service} run={run} setDialog={setDialog} importInput={() => openFiles()} />}
        {view.mode === 'trash' && <Trash project={project} service={service} run={run} />}
        {(view.mode === 'graph' || view.mode === 'dossier') && inspectorOpen && <Inspector project={project} service={service} selectedId={view.selectedId} aggregate={aggregate} onSelect={onSelect} run={run} setDialog={setDialog} importInput={() => openFiles(selectedNode?.id)} onClose={() => setInspectorOpen(false)} />}
      </main><footer className="tw-footer"><span>{draftStatus.pending ? 'Черновик сохраняется…' : snapshot.busy ? 'Обработка…' : snapshot.message || 'Метаданные сохранены'} · ревизия {project.revision}</span><span>{visibleNodes.length} документов · {project.relations.filter((item) => !item.deletedAt).length} связей</span></footer>
    </> : <main className="tw-welcome"><span className="tw-welcome-glyph">◈</span><h1>Связи между вашими заметками</h1><p>Создайте исследование или импортируйте архив TraceWeave. Новые заметки и вложения сохраняются в видимых папках Исследования/Заметки и Исследования/Вложения. Подключённые заметки остаются на месте. Служебные данные скрыты в .twdata.</p><div className="tw-row"><button className="mod-cta" onClick={() => setDialog({ kind: 'project' })}>Создать исследование</button><button onClick={() => archiveInput.current?.click()}>Импортировать ZIP</button></div></main>}
    <input hidden ref={filesInput} type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void run(() => service.importFiles(files, importTarget.current)); }} /><input hidden ref={archiveInput} type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void run(() => service.importArchive(file)); }} />
    {dialog && <Dialog key={`${project?.id ?? 'vault'}/${dialog.kind}/${'id' in dialog ? dialog.id ?? '' : ''}/${'source' in dialog ? dialog.source ?? '' : ''}/${'target' in dialog ? dialog.target ?? '' : ''}`} state={dialog} project={project} service={service} close={closeDialog} selection={selectedIds} selectedId={selectedNode?.id ?? null} ownerDocument={container.ownerDocument} />}
  </div>;
}

export function mountWorkbench(container: HTMLElement, service: WorkbenchService): () => void {
  const root = createRoot(container);
  root.render(<ReactFlowProvider><Workbench container={container} service={service} /></ReactFlowProvider>);
  return () => root.unmount();
}

/** The plugin lifecycle awaits this before releasing its single-writer lease. */
export function flushWorkbenchDrafts(service: WorkbenchService): Promise<void> {
  return metadataDrafts(service).flush();
}
