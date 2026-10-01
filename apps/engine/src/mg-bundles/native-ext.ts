// The `mg` native extension (M2, S08:MGC-032…034, ARCHITECTURE §19.6): composition clips stay on the native
// (ffmpeg) path through cached ProRes 4444 masters rendered by Remotion — `prepare` renders the missing masters
// as child jobs of the export ("Rendering compositions 2/5"), `override` hands the master to the builder as the
// layer's source (`space: 'layer'`: effects, Motion, opacity and fades are applied by the builder as for any
// layer). The Remotion path gets the same masters (signed URLs in the snapshot, OffthreadVideo transparent).
import type { MgPrerenderRequest } from '@jasper/api';
import {
	compositionClipRenderRange,
	compositionFpsMismatch,
	compositionSequenceFrames,
	type RenderCompositionSource,
	type RenderSnapshot,
	type RenderVisualClip,
} from '@jasper/project';
import type { LayerOverride, NativeExtension } from '../export/native-ext.ts';
import type { MgBundleService } from './service.ts';

export type PreparedMasters = Map<string, { path: string; renderKey: string; layerStart: number }>;

function compositionSource(clip: RenderVisualClip): RenderCompositionSource | null {
	return clip.kind === 'composition' && 'composition' in clip.source ? clip.source.composition : null;
}

/** Master requests of every composition clip of a snapshot (drawn span incl. handles, MGC-032). */
export function masterRequests(
	snapshot: RenderSnapshot,
	opts: { projectId?: string; singleFrame?: number | null } = {},
): { clip: RenderVisualClip; req: MgPrerenderRequest; layerStart: number }[] {
	const fps = snapshot.settings.fps;
	const out: { clip: RenderVisualClip; req: MgPrerenderRequest; layerStart: number }[] = [];
	for (const clip of snapshot.videoTracks.flatMap((t) => t.clips)) {
		const src = compositionSource(clip);
		if (!src?.info || !src.bundle?.key) continue;
		const total = compositionSequenceFrames(src.info, fps);
		let range = compositionClipRenderRange(clip, fps, total);
		if (opts.singleFrame !== undefined && opts.singleFrame !== null) {
			// Stills: only the frame shown (a fresh one-frame master unless the full span is cached).
			const f = range.startFrame + (opts.singleFrame - range.layerStart);
			if (f >= 0 && f < total) range = { startFrame: f, durationFrames: 1, layerStart: opts.singleFrame };
		}
		out.push({
			clip,
			layerStart: range.layerStart,
			req: {
				...(opts.projectId ? { projectId: opts.projectId } : {}),
				mediaKey: src.bundle.key,
				compositionId: src.compositionId,
				props: src.props,
				width: src.canvas.width,
				height: src.canvas.height,
				fps: { num: fps.num, den: fps.den },
				startFrame: range.startFrame,
				durationFrames: range.durationFrames,
				quality: 'master',
			},
		});
	}
	return out;
}

export function mgNativeExtension(svc: MgBundleService): NativeExtension {
	return {
		id: 'mg',
		kinds: new Set(['composition']),
		blockers(clip) {
			const src = compositionSource(clip);
			if (clip.kind !== 'composition') return [];
			if (!src) return [`composition clip "${clip.name}" has no Remotion bundle`];
			const cap = svc.capability();
			if (cap.status !== 'ready')
				return [
					`composition clips need the Remotion renderer to pre-render (${cap.reason ?? 'unavailable'})`,
				];
			if (!src.bundle?.key || !svc.record(src.bundle.key))
				return [`composition clip "${clip.name}": its Remotion bundle is not available on this engine`];
			if (src.info === null || src.info === undefined)
				return [`Composition ${src.compositionId} is not in bundle (clip "${clip.name}")`];
			return [];
		},
		warnings(clip, ctx) {
			const src = compositionSource(clip);
			if (!src?.info || !compositionFpsMismatch(src.info, ctx.fps)) return [];
			return [
				{
					code: 'MG_FPS_MISMATCH',
					message: `Composition ${src.compositionId} is ${src.info.fps} fps, the sequence ${+(ctx.fps.num / ctx.fps.den).toFixed(3)} fps: it renders at the sequence rate`,
				},
			];
		},
		async prepare(planned, ctx): Promise<PreparedMasters> {
			const still = planned.range.end - planned.range.start === 1 ? planned.range.start : null;
			const reqs = masterRequests(planned.snapshot, {
				...(ctx.projectId ? { projectId: ctx.projectId } : {}),
			});
			const out: PreparedMasters = new Map();
			if (reqs.length === 0) return out;
			// A still uses the cached full-span master when there is one, else renders only its frame.
			const wanted = reqs.map((r) => {
				if (still === null) return r;
				const key = svc.renderKeyOf(r.req);
				if (key && svc.masterPath(key)) return r;
				return masterRequests(
					{ ...planned.snapshot, videoTracks: [{ trackId: 't', clips: [r.clip] }] },
					{ ...(ctx.projectId ? { projectId: ctx.projectId } : {}), singleFrame: still },
				)[0]!;
			});
			const paths = await svc.ensureMasters(
				wanted.map((w) => w.req),
				{
					parentId: ctx.jobId,
					...(ctx.projectId ? { projectId: ctx.projectId } : {}),
					signal: ctx.signal,
					concurrency: 4,
					stage: (t) => ctx.stage(t),
				},
			);
			for (const w of wanted) {
				const key = svc.renderKeyOf(w.req)!;
				const path = paths.get(key);
				if (path) out.set(w.clip.clipId, { path, renderKey: key, layerStart: w.layerStart });
			}
			ctx.log(`mg: ${out.size} composition master(s) ready`);
			return out;
		},
		override(clip, prepared): LayerOverride | null {
			const p = (prepared as PreparedMasters | undefined)?.get(clip.clipId);
			return p ? { path: p.path, space: 'layer', startFrame: p.layerStart } : null;
		},
		prepareForRemotion: true,
		adaptRemotionDoc(doc, prepared, { signUrl }) {
			const map = prepared as PreparedMasters | undefined;
			if (!map || map.size === 0) return doc;
			return {
				...doc,
				videoTracks: doc.videoTracks.map((t) => ({
					...t,
					clips: t.clips.map((c) => {
						const p = map.get(c.clipId);
						const src = compositionSource(c);
						if (!p || !src) return c;
						return {
							...c,
							source: {
								composition: {
									...src,
									prerender: {
										masterUrl: signUrl(`/mg/${p.renderKey}/master.mov`),
										previewUrl: null,
										startFrame: p.layerStart,
									},
								},
							},
						};
					}),
				})),
			};
		},
	};
}
