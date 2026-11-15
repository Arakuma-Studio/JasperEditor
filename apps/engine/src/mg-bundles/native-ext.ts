// The `mg` native extension (M2, S08:MGC-032…034, ARCHITECTURE §19.6): composition clips stay on the native
// (ffmpeg) path through cached ProRes 4444 masters rendered by Remotion — `prepare` renders the missing masters
// as child jobs of the export ("Rendering compositions 2/5"), side by side within the export's Remotion page budget
// (`remotion/page-pool.ts`), `override` hands the master to the builder as the
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
import { JobError } from '../jobs/types.ts';
import type { MgBundleService } from './service.ts';

/** Plan refusals (every path): the clip's bundle is not on this engine / its composition is not in the bundle. */
export const MG_BUNDLE_MISSING = 'MG_BUNDLE_MISSING';
export const MG_COMPOSITION_MISSING = 'MG_COMPOSITION_MISSING';

const REIMPORT_HINT =
	'Import the bundle or HTML page on this engine again (File ▸ Import Remotion Project… / Import HTML Composition…), or delete the clip.';

type PreparedMasters = Map<string, { path: string; renderKey: string; layerStart: number }>;

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
	// AGENTS §4: without its bundle or composition no path can draw the clip (the compositions would draw the
	// preview's offline card instead): the planner refuses every export and still.
	const refusalsOf = (clip: RenderVisualClip): { code: string; reason: string; hint: string }[] => {
		if (clip.kind !== 'composition') return [];
		const src = compositionSource(clip);
		if (!src?.bundle)
			return [
				{
					code: MG_BUNDLE_MISSING,
					reason: `composition clip "${clip.name}" (${clip.clipId}) has no bundle in the project`,
					hint: REIMPORT_HINT,
				},
			];
		const what = src.bundle.html ? 'HTML composition page' : 'Remotion bundle';
		if (!src.bundle.key || !svc.record(src.bundle.key))
			return [
				{
					code: MG_BUNDLE_MISSING,
					reason: `composition clip "${clip.name}" (${clip.clipId}): its ${what} is not available on this engine`,
					hint: REIMPORT_HINT,
				},
			];
		if (src.info === null || src.info === undefined)
			return [
				{
					code: MG_COMPOSITION_MISSING,
					reason: `composition clip "${clip.name}" (${clip.clipId}): composition ${src.compositionId} is not in its ${what}`,
					hint: 'Rebuild the bundle so it has the composition again, or delete or replace the clip.',
				},
			];
		return [];
	};
	return {
		id: 'mg',
		kinds: new Set(['composition']),
		blockers(clip) {
			if (clip.kind !== 'composition') return [];
			const refused = refusalsOf(clip);
			if (refused.length) return refused.map((r) => r.reason);
			const cap = svc.capability();
			if (cap.status !== 'ready')
				return [
					`composition clips need the Remotion renderer to pre-render (${cap.reason ?? 'unavailable'})`,
				];
			return [];
		},
		refusals: refusalsOf,
		warnings(clip, ctx) {
			const src = compositionSource(clip);
			// An HTML page is seeked by time (frame / fps): any sequence rate renders it exactly.
			if (!src?.info || src.bundle?.html || !compositionFpsMismatch(src.info, ctx.fps)) return [];
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
			// M3 (wp-m3-cachegc): the masters are held for this export before they are looked up or rendered.
			if (ctx.pin)
				for (const w of wanted) {
					const key = svc.renderKeyOf(w.req);
					if (key) await ctx.pin(svc.renderDirOf(key));
				}
			const paths = await svc.ensureMasters(
				wanted.map((w) => w.req),
				{
					parentId: ctx.jobId,
					...(ctx.projectId ? { projectId: ctx.projectId } : {}),
					signal: ctx.signal,
					// The export's Remotion page budget, shared by the pre-renders in flight (S11:LBK-022 page pool).
					concurrency: ctx.concurrency ?? 4,
					stage: (t) => ctx.stage(t),
				},
			);
			// AGENTS §4: a clip without its master would be drawn as the preview's placeholder: the export fails instead.
			for (const w of wanted) {
				const key = svc.renderKeyOf(w.req);
				const path = key ? paths.get(key) : undefined;
				if (!key || !path)
					throw new JobError(
						'MG_RENDER_FAILED',
						`The master of composition clip "${w.clip.name}" (${w.req.compositionId}) was not rendered`,
						true,
					);
				out.set(w.clip.clipId, { path, renderKey: key, layerStart: w.layerStart });
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
