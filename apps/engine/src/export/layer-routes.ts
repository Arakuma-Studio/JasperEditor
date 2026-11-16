// Layer routes (docs/wp-notes/export-span-routing.md "Layer routes"): a Remotion span whose only Remotion items are
// adjustment layers is split at them instead of going to Remotion whole. Native composite of the tracks below the
// first one → a plate; Remotion draws that adjustment track over the plate → the new base; the native composite of the
// tracks up to the next adjustment track over the base → its plate; … ; the last native pass composites the tracks
// above over the base into the export's piece. Every pass is an export of the span of a pass document: the sequence
// with the other video tracks' output off (Track Matte Key sources stay as matte-only tracks) and, from the second
// pass on, a placeholder solid on a new bottom track that shows the base — natively through this extension's
// `sequence` override (a lossless FFV1 file), in Remotion as a baked frame sequence (lossless PNG frames).
import {
	applyTransaction,
	createRandomIdSource,
	defaultRegistries,
	type ProjectDocument,
	type RenderSnapshot,
	TX_PROTOCOL,
} from '@jasper/project';
import type { LayerOverride, NativeExtension } from './native-ext.ts';
import type { RemotionSpan } from './routing.ts';

/** What a placeholder clip shows: natively a lossless video, in Remotion a served PNG frame sequence. */
type PlaceholderEntry = { startFrame: number; frames: number; native?: string; plateKey?: string };

/** The extension that draws the placeholders of the passes in flight, and their registry. */
export function createLayerRouteExtension(): {
	ext: NativeExtension;
	put(clipId: string, entry: PlaceholderEntry): void;
	drop(clipId: string): void;
} {
	const entries = new Map<string, PlaceholderEntry>();
	const ext: NativeExtension = {
		id: 'layer-routes',
		kinds: new Set(['solid']),
		claimsLayer: (c) => entries.has(c.clipId),
		async prepare(planned) {
			const out = new Map<string, PlaceholderEntry>();
			for (const t of planned.snapshot.videoTracks)
				for (const c of t.clips) {
					const e = entries.get(c.clipId);
					if (e) out.set(c.clipId, e);
				}
			return out;
		},
		override(clip, prepared): LayerOverride | null {
			const e = (prepared as Map<string, PlaceholderEntry> | undefined)?.get(clip.clipId);
			return e?.native
				? { path: e.native, space: 'sequence', startFrame: e.startFrame, includesFades: true }
				: null;
		},
		prepareForRemotion: true,
		// (frames served by the layer cache's route, `layerFileUrl(key, 'graded.png')` + `n`: registerPlateStore)
		adaptRemotionDoc(doc: RenderSnapshot, prepared, { signUrl }): RenderSnapshot {
			const map = prepared as Map<string, PlaceholderEntry> | undefined;
			if (!map?.size) return doc;
			return {
				...doc,
				videoTracks: doc.videoTracks.map((t) => ({
					...t,
					clips: t.clips.map((c) => {
						const e = map.get(c.clipId);
						return e?.plateKey
							? {
									...c,
									baked: {
										url: signUrl(`/mg/layers/${e.plateKey}/graded.png`),
										startFrame: e.startFrame,
										frames: e.frames,
									},
								}
							: c;
					}),
				})),
			};
		},
	};
	return { ext, put: (id, e) => entries.set(id, e), drop: (id) => entries.delete(id) };
}

/**
 * The document of one pass: only the video tracks in `visible` draw (the others' output off; Track Matte Key sources
 * stay as matte-only tracks) and, with `placeholder`, a solid on a new bottom track over those frames (the base).
 * Through the editor's commands (a refusal is an error naming its code).
 */
export function passDocument(
	doc: ProjectDocument,
	sequenceId: string,
	visible: ReadonlySet<string>,
	placeholder: { start: number; end: number } | null,
	revision: number,
): { document: ProjectDocument; placeholderId: string | null } {
	let document = doc;
	let placeholderId: string | null = null;
	if (placeholder) {
		const { document: next, result } = applyTransaction(
			doc,
			{
				protocol: TX_PROTOCOL,
				label: 'Layer route pass',
				origin: 'user',
				sequenceId,
				commands: [
					{ type: 'track.add', sequenceId, kind: 'video', index: 0, name: 'Base', ref: '$base' },
					{
						type: 'clip.addSolid',
						at: placeholder.start,
						duration: placeholder.end - placeholder.start,
						track: '$base',
						color: [0, 0, 0, 1],
						ref: '$plate',
					},
				] as never,
			},
			{
				ids: createRandomIdSource(),
				now: () => new Date().toISOString(),
				revision,
				registries: defaultRegistries(),
			},
		);
		if (!result.ok)
			throw new Error(`the pass document was refused: ${result.errors.map((e) => e.code).join(', ')}`);
		document = next;
		placeholderId = result.refs.$plate ?? null;
		if (!placeholderId) throw new Error('the pass document has no placeholder clip');
	}
	const seq = document.sequences[sequenceId]!;
	const base = placeholderId ? seq.clips[placeholderId]!.trackId : null;
	return {
		document: {
			...document,
			sequences: {
				...document.sequences,
				[sequenceId]: {
					...seq,
					videoTracks: seq.videoTracks.map((t) =>
						t.id === base || visible.has(t.id) ? { ...t, output: true } : { ...t, output: false },
					),
				},
			},
		},
		placeholderId,
	};
}

/**
 * The adjustment tracks a Remotion span is split at (bottom → top), or why the span renders on the Remotion path whole:
 * every Remotion item of the span must be a top-level adjustment clip (stage 1: clip-type and nested Remotion layers,
 * transitions and 3D layers render the span whole).
 */
export function layerRouteOf(
	snap: RenderSnapshot,
	span: { start: number; end: number },
	items: readonly RemotionSpan[],
): { tracks: string[] } | { reason: string } {
	const tracks = new Set<string>();
	for (const it of items) {
		let found: { trackId: string; kind: string; name: string } | null = null;
		for (const t of snap.videoTracks) {
			const c = t.clips.find((x) => x.clipId === it.itemId);
			if (c) found = { trackId: t.trackId, kind: c.kind, name: c.name };
		}
		if (!found)
			return { reason: 'a transition or a clip of a nested sequence needs the Remotion path there' };
		if (found.kind !== 'adjustment')
			return { reason: `${found.kind} clip "${found.name}" needs the Remotion path for its own pixels` };
		tracks.add(found.trackId);
	}
	for (const t of snap.videoTracks)
		for (const c of t.clips)
			if (c.threeD && c.start < span.end && c.start + c.duration > span.start)
				return {
					reason: `3D layer "${c.name}" is drawn there (3D layers are not split at adjustment layers)`,
				};
	if (tracks.size === 0) return { reason: 'no adjustment layer to split at' };
	const order = snap.videoTracks.map((t) => t.trackId);
	return { tracks: [...tracks].sort((a, b) => order.indexOf(a) - order.indexOf(b)) };
}
