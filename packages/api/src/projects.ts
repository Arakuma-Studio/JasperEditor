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

export const VersionInfoSchema = z.object({
	versionId: z.string(),
	savedAt: z.string(),
	revision: z.number().int(),
	sizeBytes: z.number().int(),
});
export type VersionInfo = z.infer<typeof VersionInfoSchema>;
export const VersionListResponseSchema = z.object({ versions: z.array(VersionInfoSchema) });

export const LeaseRequestSchema = z.object({ sessionId: z.string().min(1) });
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
