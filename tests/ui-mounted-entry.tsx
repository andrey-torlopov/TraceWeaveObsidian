import { applyCommands, createProject } from '../src/domain';
import { mountWorkbench, flushWorkbenchDrafts } from '../src/ui';
import type { Command, Project, Relation, ViewState, WorkbenchService, WorkbenchSnapshot } from '../src/types';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const timestamp = '2026-10-16T10:00:00.000Z';
const relation = (value: number, changes: Partial<Relation> = {}): Relation => ({ id: id(value), sourceNodeId: id(10), targetNodeId: id(11), relationType: 'legacy-hidden-kind', label: null, directed: true, bidirectional: false, assessment: 'confirmed_by_user', confidence: null, noteMarkdown: '', evidence: [], deletedAt: null, deletionBatchId: null, createdAt: timestamp, updatedAt: timestamp, origin: {}, ...changes });
const project = applyCommands(createProject('UI smoke', id(1), timestamp), [
  { kind: 'node.create', id: id(10), title: 'Первый', notePath: 'Notes/1.md', x: 20, y: 20 },
  { kind: 'node.create', id: id(11), title: 'Второй', notePath: 'Notes/2.md', x: 350, y: 50 },
  { kind: 'relation.create', relation: relation(30) },
  { kind: 'relation.create', relation: relation(31, { label: 'Проверяемая связь', assessment: 'hypothesis', bidirectional: true }) },
], timestamp);
const listeners = new Set<() => void>();
let state: WorkbenchSnapshot = { projects: [{ id: project.id, title: project.title, status: project.status, revision: project.revision }], project, busy: false, message: '', error: null, canUndo: false, canRedo: false, progress: null };
let failMoves = false;
const drafts: Record<string, unknown> = {};
let view: Partial<ViewState> = {};
const commands: Command[] = [], adopted: string[] = [];
const publish = (changes: Partial<WorkbenchSnapshot>) => { state = { ...state, ...changes }; for (const listener of listeners) listener(); };
const unused = async (): Promise<never> => { throw new Error('Операция вне сценария mounted UI smoke'); };
const service: WorkbenchService = {
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => state,
  execute: async (batch: Command[]) => {
    commands.push(...batch);
    if (failMoves && batch.some((command) => command.kind === 'nodes.move')) throw new Error('Синтетический отказ перемещения');
    publish({ project: applyCommands(state.project as Project, batch, timestamp) });
  },
  createProject: unused, openProject: unused, createNote: unused,
  createGroup: async (title, nodeIds) => { const groupId = id(90); const command: Command = { kind: 'group.create', id: groupId, title, notePath: 'Исследования/Заметки/group.md', nodeIds }; commands.push(command); publish({ project: applyCommands(state.project as Project, [command], timestamp) }); return groupId; },
  adoptNote: async (path) => { adopted.push(path); const command: Command = { kind: 'node.create', id: id(13), title: 'Подключённая карта', notePath: path, x: 680, y: 100 }; commands.push(command); publish({ project: applyCommands(state.project as Project, [command], timestamp) }); },
  openNote: async () => {}, readNote: async () => '# Текст заметки\n\nТолько синтетические данные.', relinkNote: unused,
  listNotes: () => [{ path: 'Notes/1.md', title: 'Первый' }, { path: 'Notes/2.md', title: 'Второй' }, { path: 'Research/People/Alice.md', title: 'Alice' }, { path: 'Another folder/Places/Map.md', title: 'Map' }, { path: 'Исследования/Заметки/managed.md', title: 'Управляемая заметка' }],
  resolveVaultLink: async () => null, openVaultLink: unused,
  importFiles: unused, cancelImport: () => {}, discoverResources: async () => [], registerResource: unused,
  resourceUrl: () => { throw new Error('В этом тесте нет ресурсов'); }, showAsset: unused, verifyAssets: async () => [], search: async () => [],
  createReport: unused, openReport: unused, exportProject: unused, exportTraceWeave: unused, importArchive: unused,
  undo: unused, redo: unused, recover: async () => {},
  loadDrafts: async () => ({ ...drafts }), saveDraft: async (key, value) => { if (value === null) delete drafts[key]; else drafts[key] = value; },
  loadView: async () => view, saveView: async (state) => { view = state; },
};
const container = document.getElementById('workbench')!;
let unmount = mountWorkbench(container, service);
let currentService = service;
declare global { interface Window { twHarness: { state: () => WorkbenchSnapshot; pulse: () => void; failMoves: () => void; drafts: Record<string, unknown>; commands: Command[]; adopted: string[]; view: () => Partial<ViewState>; remount: () => void; restart: () => void; stop: () => void; flush: () => Promise<void> } } }
window.twHarness = { state: () => state, pulse: () => publish({ message: 'Обновление статуса' }), failMoves: () => { failMoves = true; }, drafts, commands, adopted, view: () => view, remount: () => { unmount(); unmount = mountWorkbench(container, currentService); }, restart: () => { unmount(); currentService = { ...service }; unmount = mountWorkbench(container, currentService); }, stop: () => unmount(), flush: () => flushWorkbenchDrafts(currentService) };
