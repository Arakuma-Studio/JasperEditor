// The `layer-bake` native extension (M2, S11:LBK-001…025, ARCHITECTURE D-31, §19.6, §20.5): every DOM layer
// (all text clips — option A —, shapes, anime templates) stays on the native path. `prepare` bakes each claimed
// layer through Remotion into a cached straight-alpha master (or one PNG for static layers) as child jobs of the
// export/still; `override` hands it to the builder as a `sequence` override (`still`, `rect`, `colorRuns`).
// Colour effects of DOM layers (FIX-002) are applied by ffmpeg to the bake (native), or baked into a graded master
// (PNG frame sequence) that the composition plays on the Remotion path (`prepareForRemotion` + `adaptRemotionDoc`).
import { availableParallelism } from 'node:os';
import type { RenderSnapshot, RenderVisualClip } from '@jasper/project';
import type { LayerOverride, NativeExtension, NativePrepareContext } from '../export/native-ext.ts';
import type { PlannedExport } from '../export/planner.ts';
import { JobError } from '../jobs/types.ts';
import { effectRunsOrderWarning, hasColorEffects, isColorEffect, isDomLayer } from './layer.ts';
import { type BakeResult, type LayerBakeService, layerFileUrl } from './service.ts';

export const LAYER_BAKE_EXTENSION_ID = 'layer-bake';

export type PreparedLayer = {
	/** Native composite (absent when prepared for the Remotion path). */
	override?: LayerOverride;
	bake?: BakeResult;
	/** Graded master for the Remotion path (LBK-010). */
	graded?: {
		key: string;
		rect: { x: number; y: number; w: number; h: number } | null;
		startFrame: number;
		frames: number;
	};
};
export type LayerBakePrepared = Map<string, PreparedLayer>;

export function layerBakeExtension(svc: LayerBakeService): NativeExtension {
	return {
		id: LAYER_BAKE_EXTENSION_ID,
		kinds: new Set(['text', 'shape']),
		claimsLayer: (c) => isDomLayer(c),
		bakes: (c) => (isDomLayer(c) ? 'remotion' : null),
		blockers(c) {
			if (!isDomLayer(c)) return [];
			const reason = svc.unavailableReason();
			return reason ? [`graphics layers need the Remotion renderer to bake (${reason})`] : [];
		},
		warnings(c) {
			if (!isDomLayer(c)) return [];
			const w = effectRunsOrderWarning(c);
			return w ? [{ code: 'DOM_GRADE_ORDER', message: w }] : [];
		},
		async prepare(planned: PlannedExport, ctx: NativePrepareContext): Promise<LayerBakePrepared> {
			const out: LayerBakePrepared = new Map();
			const remotion = ctx.purpose === 'remotion';
			const clips = planned.snapshot.videoTracks
				.flatMap((t) => t.clips)
				.filter((c) => isDomLayer(c) && (!remotion || hasColorEffects(c)));
			if (clips.length === 0) return out;
			const reason = svc.unavailableReason();
			if (reason)
				throw new JobError(
					'LAYER_BAKE_UNAVAILABLE',
					`Graphics layers need the Remotion renderer to bake: ${reason}`,
					false,
				);
			const env = await svc.environment();
			const single = planned.range.end - planned.range.start === 1 ? planned.range.start : null;
			const concurrency = ctx.concurrency ?? Math.max(1, Math.floor(availableParallelism() / 2));
			const meta = {
				parentId: ctx.jobId,
				...(ctx.projectId ? { projectId: ctx.projectId } : {}),
				signal: ctx.signal,
				concurrency,
			};
			let i = 0;
			for (const clip of clips) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				i++;
				ctx.stage(`Baking graphics ${i}/${clips.length}`);
				const plan = await svc.planBake(planned, clip, { env, frame: single });
				const bake = await svc.ensureBake(plan, meta);
				const entry: PreparedLayer = { bake };
				if (!remotion) {
					entry.override = {
						path: bake.path,
						space: 'sequence',
						startFrame: plan.startFrame,
						// Masters and single frames carry the transition fades; a static still gets them here.
						includesFades: plan.variant.recipe !== 'still',
						...(bake.still ? { still: true } : {}),
						...(bake.rect ? { rect: bake.rect } : {}),
						...(plan.colorRuns ? { colorRuns: true } : {}),
					};
				} else {
					const grade = await svc.planGrade(planned, clip, plan, {
						// All registered extensions: the colour extension has no `prepareForRemotion`, so it is not in `ctx`.
						extensions: svc.extensions(),
						signal: ctx.signal,
						scratchDir: ctx.scratchDir,
						log: ctx.log,
						jobId: ctx.jobId,
					});
					const g = await svc.ensureGraded(plan, grade, meta);
					entry.graded = { key: g.key, rect: g.rect, startFrame: plan.startFrame, frames: grade.frames };
				}
				out.set(clip.clipId, entry);
			}
			ctx.log(
				`layer-bake: ${out.size} layer(s) ready (${svc.stats.rendered} rendered, ${svc.stats.reused} reused)`,
			);
			return out;
		},
		override(clip: RenderVisualClip, prepared): LayerOverride | null {
			return (prepared as LayerBakePrepared | undefined)?.get(clip.clipId)?.override ?? null;
		},
		prepareForRemotion: true,
		adaptRemotionDoc(doc: RenderSnapshot, prepared, { signUrl }): RenderSnapshot {
			const map = prepared as LayerBakePrepared | undefined;
			let changed = false;
			const videoTracks = doc.videoTracks.map((t) => ({
				...t,
				clips: t.clips.map((c) => {
					if (!isDomLayer(c) || !hasColorEffects(c)) return c;
					changed = true;
					// The grade of a DOM layer is applied by ffmpeg (graded master); the composition never grades DOM
					// layers, so the colour effects are dropped from the document (no WebGL needed for them).
					const effects = c.effects.filter((fx) => !(fx.enabled && isColorEffect(fx)));
					const g = map?.get(c.clipId)?.graded;
					return {
						...c,
						effects,
						...(g
							? {
									baked: {
										url: signUrl(layerFileUrl(g.key, 'graded.png')),
										startFrame: g.startFrame,
										frames: g.frames,
										...(g.rect ? { rect: g.rect } : {}),
									},
								}
							: {}),
					};
				}),
			}));
			return changed ? { ...doc, videoTracks } : doc;
		},
	};
}
