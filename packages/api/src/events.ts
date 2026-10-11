import { TransactionSchema } from '@jasper/project';
import { z } from 'zod';
import { ApprovalSchema } from './agent.ts';
import { CacheGcReportSchema } from './cache.ts';
import { MediaVariantReadyEventSchema } from './imports.ts';
import { EngineJobSchema } from './jobs.ts';
import { DerivativeKindSchema, DerivativeStatusSchema } from './media.ts';
import { MgBundleRebuiltEventSchema } from './mg-bundles.ts';

export const HEARTBEAT_INTERVAL_MS = 15_000;

export const EventEnvelopeSchema = z.object({
	/** Monotonic per engine process; resume with `?since=<id>`. */
	id: z.number().int().min(0),
	type: z.string(),
	createdAt: z.string(),
	projectId: z.string().optional(),
	payload: z.unknown(),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export const EVENT_PAYLOADS = {
	'engine.heartbeat': z.object({}),
	'capabilities.changed': z.object({}),
	'job.created': EngineJobSchema,
	'job.updated': EngineJobSchema,
	'job.finished': EngineJobSchema,
	'media.updated': z.object({
		mediaKey: z.string(),
		status: z.enum(['online', 'missing', 'processing', 'error']),
		derivatives: z.record(DerivativeKindSchema, DerivativeStatusSchema).optional(),
	}),
	'derivative.ready': z.object({ mediaKey: z.string(), kind: DerivativeKindSchema, url: z.string() }),
	/** An interpreted picture (display / proxy / master of a pixel variant) is ready. */
	'media.variant.ready': MediaVariantReadyEventSchema,
	'export.finished': z.object({
		jobId: z.string(),
		downloadUrl: z.string().optional(),
		outputPath: z.string().optional(),
		byteSize: z.number(),
		durationSec: z.number(),
	}),
	'doc.changed': z.object({
		projectId: z.string(),
		revision: z.number().int(),
		label: z.string(),
		origin: TransactionSchema.shape.origin,
		created: z.array(z.string()),
		changed: z.array(z.string()),
		deleted: z.array(z.string()),
		isUndo: z.boolean(),
		isRedo: z.boolean().optional(),
	}),
	'agent.approval.requested': ApprovalSchema,
	'agent.approval.resolved': z.object({
		approvalId: z.string(),
		decision: z.enum(['approved', 'denied', 'timeout']),
	}),
	/** An agent (jasper-mcp `open_project_in_editor`) asks editor windows to open this project. */
	'editor.openProject': z.object({ projectId: z.string(), agent: z.string().optional() }),
	/** A Remotion bundle was rebuilt; editors relink the asset keyed `oldKey`. */
	'mgBundle.rebuilt': MgBundleRebuiltEventSchema,
	/** A cleaning pass removed cache entries (Preferences ▸ Media Cache refreshes). */
	'cache.cleaned': CacheGcReportSchema,
	/** The user effect preset library changed (Effects ▸ Presets refreshes). */
	'effectPresets.changed': z.object({ revision: z.number().int() }),
	/**
	 * preview files appeared (a segment finished rendering) or were deleted; the render bar asks again. A
	 * deletion carries `deleted` (count), a render the segment.
	 */
	'previews.changed': z.object({
		formatKey: z.string().optional(),
		hash: z.string().optional(),
		kind: z.enum(['video', 'audio']).optional(),
		sequenceId: z.string().optional(),
		deleted: z.number().int().optional(),
	}),
} as const;
export type EngineEventType = keyof typeof EVENT_PAYLOADS;
export const ENGINE_EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EngineEventType[];
export type EventPayload<T extends EngineEventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>;

export type TypedEvent = {
	[T in EngineEventType]: Omit<EventEnvelope, 'type' | 'payload'> & { type: T; payload: EventPayload<T> };
}[EngineEventType];

/** Validates an envelope's payload for known types; unknown types (newer engines) pass through as null. */
export function parseEvent(raw: unknown): TypedEvent | null {
	const env = EventEnvelopeSchema.safeParse(raw);
	if (!env.success) return null;
	if (!Object.hasOwn(EVENT_PAYLOADS, env.data.type)) return null;
	const schema = EVENT_PAYLOADS[env.data.type as EngineEventType];
	const payload = schema.safeParse(env.data.payload);
	if (!payload.success) return null;
	return { ...env.data, payload: payload.data } as TypedEvent;
}
