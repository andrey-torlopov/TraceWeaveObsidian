export type ID = string;
export type Assessment = 'unreviewed' | 'confirmed_by_user' | 'hypothesis' | 'refuted_by_user';
export type Confidence = 'low' | 'medium' | 'high' | null;
export type AttributeKind = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'url' | 'geo';
export interface Attribute { id: ID; key: string; valueType: AttributeKind; value: string | number | boolean | null | { value: string; precision: 'year' | 'month' | 'day' } | { latitude: number; longitude: number; accuracyMeters: number | null }; sortOrder: number }
export interface Evidence { id: ID; sourceKind: 'node' | 'asset' | 'url'; sourceNodeId: ID | null; assetId: ID | null; url: string | null; label: string; quote: string | null; locator: string | null; note: string | null; accessedAt: string | null }
export interface NodeType { id: ID; code: string; name: string; color: string; iconKey: string; isHidden: boolean; isSystem: boolean }
export interface ProjectNode { id: ID; title: string; notePath: string; noteHash: string | null; typeId: ID; iconEmoji: string | null; assessment: Assessment; confidence: Confidence; attributes: Attribute[]; evidence: Evidence[]; x: number; y: number; zIndex: number; createdAt: string; updatedAt: string; deletedAt: string | null; deletionBatchId: ID | null; missing: boolean; subtitle: string | null; tags: string[]; origin: Record<string, unknown>; extensions: Record<string, unknown> }
export interface Relation { id: ID; sourceNodeId: ID; targetNodeId: ID; relationType: string; label: string | null; directed: boolean; bidirectional: boolean; assessment: Assessment; confidence: Confidence; noteMarkdown: string; evidence: Evidence[]; deletedAt: string | null; deletionBatchId: ID | null; createdAt: string; updatedAt: string; origin: Record<string, unknown> }
export interface Membership { groupNodeId: ID; memberNodeId: ID; sortOrder: number }
export type MediaKind = 'image' | 'audio' | 'video' | 'file' | 'text';
export interface BlobRecord { id: ID; path: string; sha256: string; byteSize: number; mimeType: string; mediaKind: MediaKind }
export interface Asset { id: ID; blobId: ID; originalName: string; title: string; mimeType: string; mediaKind: MediaKind; byteSize: number; sha256: string; createdAt: string; deletedAt: string | null; deletionBatchId: ID | null; sourceUrl: string | null; sourceAuthor: string | null; sourceCreatedAt: string | null; noteMarkdown: string; origin: Record<string, unknown> }
export interface Attachment { id: ID; nodeId: ID; assetId: ID; role: 'primary' | 'attachment'; sortOrder: number; caption: string | null }
export interface DeletionBatch { id: ID; nodeIds: ID[]; relationIds: ID[]; memberships: Membership[]; createdAt: string }
export interface SnapshotRecord { id: ID; title: string; path: string; sourceRevision: number; createdAt: string; assetIds: ID[] }
export interface ReadableReportResult { directory: string; summaryPath: string; canvasPath: string }
export interface Receipt { hash: string; revision: number; timestamp: string }
export interface Project { format: 'traceweave.obsidian-project'; formatVersion: '1.0'; requiredFeatures: string[]; id: ID; title: string; descriptionMarkdown: string; status: 'active' | 'archived'; revision: number; createdAt: string; updatedAt: string; nodes: ProjectNode[]; nodeTypes: NodeType[]; relations: Relation[]; relationTypes: { code: string; name: string; defaultDirected: boolean }[]; memberships: Membership[]; blobs: BlobRecord[]; assets: Asset[]; attachments: Attachment[]; deletionBatches: DeletionBatch[]; snapshots: SnapshotRecord[]; receipts: Record<ID, Receipt>; importedData: Record<string, unknown> }
export type NodeChanges = Partial<Pick<ProjectNode, 'title' | 'typeId' | 'iconEmoji' | 'assessment' | 'confidence' | 'attributes' | 'evidence' | 'notePath' | 'noteHash' | 'missing' | 'subtitle' | 'tags' | 'extensions'>>;
export type Command =
 | { kind: 'node.create'; id: ID; title: string; notePath: string; typeId?: ID; noteHash?: string; x?: number; y?: number }
 | { kind: 'node.update'; nodeId: ID; changes: NodeChanges }
 | { kind: 'nodes.move'; positions: { nodeId: ID; x: number; y: number }[] }
 | { kind: 'elements.trash'; nodeIds: ID[]; relationIds: ID[]; groupMode: 'group_only' | 'group_with_members' }
 | { kind: 'trash.restore'; batchId: ID }
 | { kind: 'relation.create'; relation: Relation }
 | { kind: 'relation.update'; relationId: ID; changes: Partial<Omit<Relation, 'id' | 'createdAt'>> }
 | { kind: 'type.upsert'; type: NodeType }
 | { kind: 'group.create'; id: ID; title: string; notePath: string; nodeIds: ID[]; noteHash?: string }
 | { kind: 'group.members'; groupId: ID; nodeIds: ID[] }
 | { kind: 'group.ungroup'; groupId: ID }
 | { kind: 'asset.register'; asset: Asset; blob: BlobRecord }
 | { kind: 'asset.update'; assetId: ID; changes: Partial<Pick<Asset, 'title' | 'sourceUrl' | 'sourceAuthor' | 'sourceCreatedAt' | 'noteMarkdown'>> }
 | { kind: 'attachment.attach'; attachment: Attachment }
 | { kind: 'attachment.detach'; attachmentId: ID }
 | { kind: 'attachment.primary'; attachmentId: ID }
 | { kind: 'project.update'; changes: Partial<Pick<Project, 'title' | 'descriptionMarkdown' | 'status'>> }
 | { kind: 'snapshot.register'; snapshot: SnapshotRecord };
export interface ProjectSummary { id: ID; title: string; status: Project['status']; revision: number }
export interface ResourceCandidate { path: string; byteSize: number; registered: boolean }
export interface ProjectDiagnostics {
 projectId: ID; checkedAt: string;
 notes: { nodeId: ID; path: string; status: 'ok' | 'missing' | 'invalid' }[];
 assets: { assetId: ID; path: string; status: 'ok' | 'missing' | 'changed' | 'invalid' }[];
 affectedNodeIds: ID[];
}
export interface SearchHit { nodeId: ID; field: string; snippet: string }
export interface VaultLink { path: string; title: string; resourceUrl: string; mimeType: string; mediaKind: MediaKind; byteSize: number; isNote: boolean; openMode?: 'native' | 'reveal' }
export interface WorkbenchSnapshot { projects: readonly ProjectSummary[]; project: Project | null; busy: boolean; message: string; error: string | null; canUndo: boolean; canRedo: boolean; progress: { name: string; completed: number; total: number } | null; diagnostics?: ProjectDiagnostics | null }
export interface ViewState { mode: 'graph' | 'dossier' | 'materials' | 'trash'; selectedId: ID | null; collapsedGroupIds: ID[]; expandedNodeIds: ID[]; viewport?: { x: number; y: number; zoom: number } }
export interface WorkbenchService {
 subscribe(listener: () => void): () => void; getSnapshot(): WorkbenchSnapshot;
 createProject(title: string): Promise<void>; openProject(id: ID): Promise<void>; createGroup(title: string, nodeIds: ID[]): Promise<ID>;
 execute(commands: Command[]): Promise<void>; createNote(title: string, typeId?: ID): Promise<ID>;
 adoptNote(path: string, title?: string, typeId?: ID): Promise<void>; openNote(nodeId: ID): Promise<'opened' | 'missing'>; readNote(nodeId: ID): Promise<string>;
 recreateNote(nodeId: ID): Promise<void>; diagnoseProject(): Promise<ProjectDiagnostics>;
 relinkNote(nodeId: ID, path: string): Promise<void>; listNotes(): readonly { path: string; title: string }[];
 resolveVaultLink(sourcePath: string, link: string): Promise<VaultLink | null>; openVaultLink(sourcePath: string, link: string): Promise<void>;
 importFiles(files: File[], nodeId?: ID): Promise<void>; cancelImport(): void;
 discoverResources(): Promise<ResourceCandidate[]>; registerResource(path: string, nodeId?: ID): Promise<void>;
 resourceUrl(assetId: ID): string; showAsset(assetId: ID): Promise<void>; verifyAssets(): Promise<{ assetId: ID; status: 'ok' | 'missing' | 'changed' }[]>;
 search(query: string, caseSensitive?: boolean): Promise<SearchHit[]>;
 createReport(title: string, nodeIds?: ID[]): Promise<SnapshotRecord>;
 exportReadableReport(): Promise<ReadableReportResult>;
 openReport(id: ID): Promise<void>; exportProject(): Promise<string>; exportTraceWeave(): Promise<string>; importArchive(file: File): Promise<void>;
 undo(): Promise<void>; redo(): Promise<void>; recover(): Promise<void>;
 loadDrafts(projectId?: ID): Promise<Record<string, unknown>>; saveDraft(key: string, value: unknown): Promise<void>;
 loadView(): Promise<Partial<ViewState>>; saveView(state: ViewState): Promise<void>;
}
