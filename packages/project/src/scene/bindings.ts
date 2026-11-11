// Which clips a scene file created (docs/wp-notes/scene-file.md § Ownership): `extensions["jasper.scene"]` = `{v: 1,
// sequences: {<sequenceId>: {layers: {<layer id>: <clip id>}}}}`. Written only by `scene.bind` (one undo step with
// the rest of an apply); `jasper apply` removes the clip of a bound layer that left the file, and nothing else.
// Extensions are kept verbatim by every build (S01 §7.1), so this needs no schema bump. Read leniently: an unreadable
// value never fails a load or an apply (INV-SCENE reports it, `repairDocument` keeps the readable entries).
import { z } from 'zod';
import type { ProjectDocument } from '../schema/document.ts';

export const SCENE_EXTENSION_KEY = 'jasper.scene';
/** Most bound layers per sequence (a scene holds at most MAX_SCENE_LAYERS; old ones are dropped as they go). */
export const MAX_SCENE_BINDINGS = 5000;

const LayerIdSchema = z.string().min(1).max(200);
const ClipIdSchema = z.string().regex(/^clp_[0-9A-HJKMNP-TV-Z]{16}$/);

export const SceneBindingsSchema = z.strictObject({
	v: z.literal(1),
	sequences: z.record(
		z.string().regex(/^seq_[0-9A-HJKMNP-TV-Z]{16}$/),
		z.strictObject({
			layers: z
				.record(LayerIdSchema, ClipIdSchema)
				.refine((r) => Object.keys(r).length <= MAX_SCENE_BINDINGS, {
					message: `at most ${MAX_SCENE_BINDINGS} layers`,
				}),
		}),
	),
});
export type SceneBindings = z.infer<typeof SceneBindingsSchema>;

/** The stored value, or null when there is none. */
function storedOf(doc: Pick<ProjectDocument, 'extensions'>): unknown {
	const ext = doc.extensions;
	return ext && typeof ext === 'object' && Object.hasOwn(ext, SCENE_EXTENSION_KEY)
		? ext[SCENE_EXTENSION_KEY]
		: undefined;
}

/** Layer id → clip id for `sequenceId` (empty when there is none or the value is unreadable). */
export function sceneBindingsOf(
	doc: Pick<ProjectDocument, 'extensions'>,
	sequenceId: string,
): Record<string, string> {
	const r = SceneBindingsSchema.safeParse(storedOf(doc));
	if (!r.success) return {};
	const s = r.data.sequences[sequenceId];
	return s ? { ...s.layers } : {};
}

/** What is wrong with the stored bindings, or null (also null when absent). */
export function sceneBindingsIssue(doc: Pick<ProjectDocument, 'extensions'>): string | null {
	const v = storedOf(doc);
	if (v === undefined) return null;
	const r = SceneBindingsSchema.safeParse(v);
	return r.success ? null : r.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`)[0]!;
}

/**
 * The readable part of stored bindings (entries with a valid layer id and clip id under a valid sequence id), or
 * null when nothing is readable.
 */
export function repairSceneBindings(v: unknown): SceneBindings | null {
	if (!v || typeof v !== 'object') return null;
	const seqs = (v as { sequences?: unknown }).sequences;
	if (!seqs || typeof seqs !== 'object') return null;
	const out: SceneBindings = { v: 1, sequences: {} };
	for (const [sid, entry] of Object.entries(seqs as Record<string, unknown>)) {
		if (!/^seq_[0-9A-HJKMNP-TV-Z]{16}$/.test(sid) || !entry || typeof entry !== 'object') continue;
		const layers = (entry as { layers?: unknown }).layers;
		if (!layers || typeof layers !== 'object') continue;
		const kept: Record<string, string> = {};
		for (const [lid, cid] of Object.entries(layers as Record<string, unknown>).slice(0, MAX_SCENE_BINDINGS))
			if (LayerIdSchema.safeParse(lid).success && ClipIdSchema.safeParse(cid).success)
				kept[lid] = cid as string;
		if (Object.keys(kept).length) out.sequences[sid] = { layers: kept };
	}
	return Object.keys(out.sequences).length ? out : null;
}

/**
 * The bindings after `patch` (layer id → clip id, null = forget) on `sequenceId`; the sequence entry goes when it is
 * empty, the whole value (null) when no sequence is left.
 */
export function patchSceneBindings(
	doc: Pick<ProjectDocument, 'extensions'>,
	sequenceId: string,
	patch: Readonly<Record<string, string | null>>,
): SceneBindings | null {
	const parsed = SceneBindingsSchema.safeParse(storedOf(doc));
	const base: SceneBindings = parsed.success
		? parsed.data
		: (repairSceneBindings(storedOf(doc)) ?? { v: 1, sequences: {} });
	const layers = { ...(base.sequences[sequenceId]?.layers ?? {}) };
	for (const [lid, cid] of Object.entries(patch)) {
		if (cid === null) delete layers[lid];
		else layers[lid] = cid;
	}
	const sequences = { ...base.sequences };
	if (Object.keys(layers).length) sequences[sequenceId] = { layers };
	else delete sequences[sequenceId];
	return Object.keys(sequences).length ? { v: 1, sequences } : null;
}
