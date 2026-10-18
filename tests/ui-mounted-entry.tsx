import { applyCommands, createProject } from '../src/domain';
import { mountWorkbench, flushWorkbenchDrafts } from '../src/ui';
import type { Command, Project, ID, ProjectDiagnostics, Relation, ViewState, WorkbenchService, WorkbenchSnapshot } from '../src/types';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const timestamp = '2026-10-16T10:00:00.000Z';
const relation = (value: number, changes: Partial<Relation> = {}): Relation => ({ id: id(value), sourceNodeId: id(10), targetNodeId: id(11), relationType: 'legacy-hidden-kind', label: null, directed: true, bidirectional: false, assessment: 'confirmed_by_user', confidence: null, noteMarkdown: '', evidence: [], deletedAt: null, deletionBatchId: null, createdAt: timestamp, updatedAt: timestamp, origin: {}, ...changes });
const project = applyCommands(createProject('UI smoke', id(1), timestamp), [
  { kind: 'node.create', id: id(10), title: 'Первый', notePath: 'Notes/1.md', x: 20, y: 20 },
  { kind: 'node.create', id: id(11), title: 'Второй', notePath: 'Notes/2.md', x: 350, y: 50 },
  { kind: 'asset.register', blob: { id: id(80), path: 'TWData/projects/UI smoke/images/source.png', sha256: 'a'.repeat(64), byteSize: 20, mimeType: 'image/png', mediaKind: 'image' }, asset: { id: id(81), blobId: id(80), originalName: 'source.png', title: 'Исходное изображение', mimeType: 'image/png', mediaKind: 'image', byteSize: 20, sha256: 'a'.repeat(64), createdAt: timestamp, deletedAt: null, deletionBatchId: null, sourceUrl: null, sourceAuthor: null, sourceCreatedAt: null, noteMarkdown: '', origin: {} } },
  { kind: 'attachment.attach', attachment: { id: id(82), nodeId: id(11), assetId: id(81), role: 'attachment', sortOrder: 0, caption: null } },
  { kind: 'relation.create', relation: relation(30) },
  { kind: 'relation.create', relation: relation(31, { label: 'Проверяемая связь', assessment: 'hypothesis', bidirectional: true }) },
], timestamp);
const listeners = new Set<() => void>();
let state: WorkbenchSnapshot = { projects: [{ id: project.id, title: project.title, status: project.status, revision: project.revision }], project, busy: false, message: '', error: null, canUndo: false, canRedo: false, progress: null };
let failMoves = false;
const drafts: Record<string, unknown> = {};
let view: Partial<ViewState> = {};
const commands: Command[] = [], adopted: string[] = [], readableReports: string[] = [], opened: ID[] = [], recreated: ID[] = [], relinked: { nodeId: ID; path: string }[] = [], created: string[] = [];
let fileProblem = false;
const publish = (changes: Partial<WorkbenchSnapshot>) => { state = { ...state, ...changes }; for (const listener of listeners) listener(); };
const unused = async (): Promise<never> => { throw new Error('Операция вне сценария mounted UI smoke'); };
const service: WorkbenchService = {
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => state,
  execute: async (batch: Command[]) => {
    commands.push(...batch);
    if (failMoves && batch.some((command) => command.kind === 'nodes.move')) throw new Error('Синтетический отказ перемещения');
    publish({ project: applyCommands(state.project as Project, batch, timestamp) });
  },
  createProject: unused, openProject: unused,
  createNote: async (title, typeId) => { created.push(title); const nodeId = id(100 + created.length); const command: Command = { kind: 'node.create', id: nodeId, title, typeId, notePath: `Inbox/${title}.md` }; commands.push(command); publish({ project: applyCommands(state.project as Project, [command], timestamp) }); return nodeId; },
  createGroup: async (title, nodeIds) => { const groupId = id(90); const command: Command = { kind: 'group.create', id: groupId, title, notePath: 'Исследования/Заметки/group.md', nodeIds }; commands.push(command); publish({ project: applyCommands(state.project as Project, [command], timestamp) }); return groupId; },
  adoptNote: async (path, title, typeId) => { adopted.push(path); const command: Command = { kind: 'node.create', id: id(13), title: title ?? 'Подключённая карта', typeId, notePath: path, x: 680, y: 100 }; commands.push(command); publish({ project: applyCommands(state.project as Project, [command], timestamp) }); },
  openNote: async (nodeId) => { opened.push(nodeId); return state.project!.nodes.find(node => node.id === nodeId)?.missing ? 'missing' : 'opened'; }, readNote: async () => '# Текст заметки\n\nТолько синтетические данные.',
  relinkNote: async (nodeId, path) => { relinked.push({ nodeId, path }); publish({ project: applyCommands(state.project!, [{ kind: 'node.update', nodeId, changes: { notePath: path, missing: false } }], timestamp), diagnostics: null }); },
  recreateNote: async (nodeId) => { recreated.push(nodeId); const node = state.project!.nodes.find(node => node.id === nodeId)!; publish({ project: applyCommands(state.project!, [{ kind: 'node.update', nodeId, changes: { notePath: `Inbox/${node.title}.md`, missing: false } }], timestamp), diagnostics: null }); },
  diagnoseProject: async () => {
    const diagnostics: ProjectDiagnostics = { projectId: state.project!.id, checkedAt: timestamp, notes: state.project!.nodes.filter(node => !node.deletedAt).map(node => ({ nodeId: node.id, path: node.notePath, status: node.missing ? 'missing' : 'ok' })), assets: fileProblem ? [{ assetId: id(81), path: 'TWData/projects/UI smoke/images/source.png', status: 'missing' }] : [], affectedNodeIds: [...new Set([...state.project!.nodes.filter(node => node.missing).map(node => node.id), ...(fileProblem ? [id(11)] : [])])] }; publish({ diagnostics }); return diagnostics;
  },
  listNotes: () => [{ path: 'Notes/1.md', title: 'Первый' }, { path: 'Notes/2.md', title: 'Второй' }, { path: 'Research/People/Alice.md', title: 'Alice' }, { path: 'Another folder/Places/Map.md', title: 'Map' }, { path: 'Исследования/Заметки/managed.md', title: 'Управляемая заметка' }],
  resolveVaultLink: async () => null, openVaultLink: unused,
  importFiles: unused, cancelImport: () => {}, discoverResources: async () => [], registerResource: unused,
  resourceUrl: () => { throw new Error('В этом тесте нет ресурсов'); }, showAsset: unused, verifyAssets: async () => [], search: async () => [],
  createReport: unused, openReport: unused, exportReadableReport: async () => { readableReports.push(state.project!.id); return { directory: 'UI smoke', summaryPath: 'UI smoke/summary.md', canvasPath: 'UI smoke/scheme.canvas' }; }, exportProject: unused, exportTraceWeave: unused, importArchive: unused,
  undo: unused, redo: unused, recover: async () => {},
  loadDrafts: async () => ({ ...drafts }), saveDraft: async (key, value) => { if (value === null) delete drafts[key]; else drafts[key] = value; },
  loadView: async () => view, saveView: async (state) => { view = state; },
};
const container = document.getElementById('workbench')!;
let unmount = mountWorkbench(container, service);
let currentService = service;
declare global { interface Window { twHarness: { state: () => WorkbenchSnapshot; pulse: () => void; failMoves: () => void; drafts: Record<string, unknown>; commands: Command[]; opened: ID[]; recreated: ID[]; relinked: { nodeId: ID; path: string }[]; created: string[]; missing: (nodeId: ID) => void; archive: () => void; fileProblem: (value: boolean) => void; adopted: string[]; readableReports: string[]; view: () => Partial<ViewState>; remount: () => void; restart: () => void; stop: () => void; flush: () => Promise<void> } } }
window.twHarness = { state: () => state, pulse: () => publish({ message: 'Обновление статуса' }), failMoves: () => { failMoves = true; }, drafts, commands, opened, recreated, relinked, created, missing: (nodeId) => publish({ project: applyCommands(state.project!, [{ kind: 'node.update', nodeId, changes: { missing: true } }], timestamp) }), archive: () => publish({ project: applyCommands(state.project!, [{ kind: 'project.update', changes: { status: 'archived' } }], timestamp) }), fileProblem: (value) => { fileProblem = value; }, adopted, readableReports, view: () => view, remount: () => { unmount(); unmount = mountWorkbench(container, currentService); }, restart: () => { unmount(); currentService = { ...service }; unmount = mountWorkbench(container, currentService); }, stop: () => unmount(), flush: () => flushWorkbenchDrafts(currentService) };
