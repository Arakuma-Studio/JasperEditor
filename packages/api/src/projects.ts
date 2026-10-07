// Engine-backed project store (ARCHITECTURE §9.2, D-08, S01:PER-001/002/040).
import { z } from 'zod';

export const ProjectSummarySchema = z.object({
	projectId: z.string(),
	name: z.string(),
	modifiedAt: z.string(),
	thumbnail: z.string().nullable(),
	schemaVersion: z.number().int(),
	sizeBytes: z.number().int().min(0),
	revision: z.number().int().min(0),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectListResponseSchema = z.object({ projects: z.array(ProjectSummarySchema) });
export const ProjectCreateRequestSchema = z.object({ name: z.string().min(1), preset: z.string().min(1) });
export type ProjectCreateRequest = z.infer<typeof ProjectCreateRequestSchema>;
export const ProjectCreateResponseSchema = z.object({ projectId: z.string() });

/** The S01:PER-002 envelope; the document itself is validated by @jasper/project's loader. */
export const EnvelopeSchema = z.looseObject({
	format: z.literal('jasper-project'),
	schemaVersion: z.number().int(),
	savedAt: z.string(),
	savedBy: z.object({ app: z.string(), version: z.string(), platform: z.string() }),
	revision: z.number().int().min(0),
	document: z.record(z.string(), z.unknown()),
});
export type EnvelopeJson = z.infer<typeof EnvelopeSchema>;

/** Per-project view state (S01:SES-004): opaque to the engine, versioned by the client. */
export const ProjectViewSchema = z.looseObject({ version: z.number().int() });
export type ProjectViewJson = z.infer<typeof ProjectViewSchema>;

export const ProjectGetResponseSchema = z.object({
	envelope: EnvelopeSchema,
	view: ProjectViewSchema.nullable(),
	revision: z.number().int().min(0),
});
export type ProjectGetResponse = z.infer<typeof ProjectGetResponseSchema>;

/** `PUT /api/projects/:pid` with `If-Match: <baseRevision>`. */
export const ProjectPutResponseSchema = z.object({ revision: z.number().int().min(0) });
export const RevisionConflictDetailSchema = z.object({ revision: z.number().int().min(0) });

/**
 * Why a saved version exists (process workstream, D-39): `auto` every 5 minutes of saving (S01:PER-020),
 * `before-restore` the state replaced by a restore, `schema-backup` the file as it was before the first save
 * over a project migrated from an older schema (`project (schema vN backup).jasper`, S01:MIG-004).
 */
export const VersionKindSchema = z.enum(['auto', 'before-restore', 'schema-backup']);
export type VersionKind = z.infer<typeof VersionKindSchema>;

export const VersionInfoSchema = z.object({
	versionId: z.string(),
	savedAt: z.string(),
	revision: z.number().int(),
	sizeBytes: z.number().int(),
	/** Additive (process): absent from older engines, which only kept `auto` versions. */
	kind: VersionKindSchema.optional(),
	/** Schema version of the stored document (additive). */
	schemaVersion: z.number().int().optional(),
});
export type VersionInfo = z.infer<typeof VersionInfoSchema>;
export const VersionListResponseSchema = z.object({ versions: z.array(VersionInfoSchema) });

/** `GET /api/projects/:pid/versions/:versionId`: one saved version, to read or preview. */
export const VersionGetResponseSchema = z.object({ version: VersionInfoSchema, envelope: EnvelopeSchema });
export type VersionGetResponse = z.infer<typeof VersionGetResponseSchema>;

/**
 * `POST /api/projects/:pid/versions/:versionId/restore`. `replace` writes the version over the project (the current
 * state is kept as a `before-restore` version first); it is refused while another session holds the lease, so an
 * open editor passes its own `leaseId` and reopens afterwards. `copy` makes a new project (S01:PER-001
 * `restoreVersion`), named `name` or "<name> (restored <date>)".
 */
export const VersionRestoreRequestSchema = z.object({
	mode: z.enum(['replace', 'copy']),
	name: z.string().min(1).max(200).optional(),
	leaseId: z.string().optional(),
});
export type VersionRestoreRequest = z.infer<typeof VersionRestoreRequestSchema>;
export const VersionRestoreResponseSchema = z.object({
	projectId: z.string(),
	revision: z.number().int().min(0),
	/** `replace`: the version id that keeps the replaced state. */
	keptAs: z.string().nullable(),
});
export type VersionRestoreResponse = z.infer<typeof VersionRestoreResponseSchema>;

/** A session's crash-recovery journal (S01:PER-021, AC-18, D-39). */
export const RecoveryInfoSchema = z.object({
	sessionId: z.string(),
	projectId: z.string(),
	projectName: z.string(),
	baseRevision: z.number().int(),
	revision: z.number().int(),
	startedAt: z.string(),
	savedAt: z.string(),
	changes: z.array(z.string()),
	changeCount: z.number().int().min(0),
	sizeBytes: z.number().int().min(0),
	/** Current revision of the saved project (above `baseRevision` when it was saved again after the crash). */
	projectRevision: z.number().int(),
});
export type RecoveryInfo = z.infer<typeof RecoveryInfoSchema>;
export const RecoveryListResponseSchema = z.object({ candidates: z.array(RecoveryInfoSchema) });
export const RecoveryGetResponseSchema = z.object({
	candidate: RecoveryInfoSchema,
	envelope: EnvelopeSchema,
});
export type RecoveryGetResponse = z.infer<typeof RecoveryGetResponseSchema>;
/** `PUT /api/projects/:pid/recovery/:sessionId`: the session (holding the lease) journals its unsaved document. */
export const RecoveryPutRequestSchema = z.object({
	leaseId: z.string().min(1),
	baseRevision: z.number().int().min(0),
	revision: z.number().int().min(0),
	changes: z.array(z.string()).max(1000),
	changeCount: z.number().int().min(0).optional(),
	envelope: EnvelopeSchema,
});
export type RecoveryPutRequest = z.infer<typeof RecoveryPutRequestSchema>;
export const RecoveryPutResponseSchema = z.object({ ok: z.literal(true), savedAt: z.string() });

export const LeaseRequestSchema = z.object({
	sessionId: z.string().min(1),
	/**
	 * "Take over editing" (S01:PER-040): the engine revokes the current holder's lease and grants a new one
	 * to `sessionId`; the previous holder's next heartbeat fails and its editor turns read-only. Additive (WP-2E).
	 */
	takeOver: z.boolean().optional(),
});
export const LeaseSchema = z.object({
	leaseId: z.string(),
	projectId: z.string(),
	sessionId: z.string(),
	acquiredAt: z.string(),
	expiresAt: z.string(),
	heartbeatMs: z.number().int().positive(),
});
export type Lease = z.infer<typeof LeaseSchema>;
/** 409 detail when another session holds the lease (S01:PER-040). */
export const LeaseHeldDetailSchema = z.object({ holderSessionId: z.string(), expiresAt: z.string() });

export const OkSchema = z.object({ ok: z.literal(true) });
