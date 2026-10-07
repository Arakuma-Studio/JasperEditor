// The `layer-bake` native extension (M2, S11:LBK-001…025, ARCHITECTURE D-31, §19.6, §20.5): every DOM layer
// (all text clips — option A —, shapes, anime templates) stays on the native path. wave1c (D-35): so do media layers
// with browser-only effects (GPU shader effects, SVG/CSS effects: the whole layer is baked) and GPU transitions
// (the span — sides A + B and the stage — is baked; the builder draws the sides only outside it). `prepare` bakes each claimed
// layer through Remotion into a cached straight-alpha master (or one PNG for static layers) as child jobs of the
// export/still — side by side within the export's Remotion page budget (`remotion/page-pool.ts`, S11:LBK-022) —;
// `override` hands it to the builder as a `sequence` override (`still`, `rect`, `colorRuns`).
// Colour effects of DOM layers (FIX-002) are applied by ffmpeg to the bake (native), or baked into a graded master
// (PNG frame sequence) that the composition plays on the Remotion path (`prepareForRemotion` + `adaptRemotionDoc`).
import { availableParallelism } from 'node:os';
import type { RenderSnapshot, RenderTransition, RenderVisualClip } from '@jasper/project';
import type { LayerOverride, NativeExtension, NativePrepareContext } from '../export/native-ext.ts';
import type { PlannedExport } from '../export/planner.ts';
import { JobError } from '../jobs/types.ts';
import { MAX_RENDERS_IN_FLIGHT, type PageGrant, pageShares, runPagePool } from '../remotion/page-pool.ts';
import {
	effectRunsOrderWarning,
	hasColorEffects,
	isColorEffect,
	isDomLayer,
	needsBake,
	type Rect,
} from './layer.ts';
import {
	type BakePlan,
	type BakeResult,
	type GradePlan,
	type LayerBakeService,
	layerFileUrl,
} from './service.ts';

const LAYER_BAKE_EXTENSION_ID = 'layer-bake';

type PreparedLayer = {
	/** Native composite (absent when prepared for the Remotion path). */
	override?: LayerOverride;
	/** Graded master for the Remotion path (LBK-010). */
	graded?: {
		key: string;
		rect: { x: number; y: number; w: number; h: number } | null;
		startFrame: number;
		frames: number;
	};
};
type LayerBakePrepared = Map<string, PreparedLayer>;
/** Span bakes of GPU transitions (wave1c), by transition id: the `sequence` override of the span. */
const SPANS = Symbol('spans');
type Prepared = LayerBakePrepared & { [SPANS]?: Map<string, LayerOverride> };

/** Fixed cost of a render (browser page, bundle, stitch, checks) in frames, for the aggregated progress. */
const RENDER_FIXED_COST_FRAMES = 30;

/** What the native builder (override) or the Remotion path (graded master) gets for one clip. */
function entryOf(
	plan: BakePlan,
	bake: BakeResult,
	grade: GradePlan | null,
	graded: { key: string; rect: Rect | null } | null,
): PreparedLayer {
	if (grade && graded)
		return {
			graded: { key: graded.key, rect: graded.rect, startFrame: plan.startFrame, frames: grade.frames },
		};
	return {
		override: {
			path: bake.path,
			space: 'sequence',
			startFrame: plan.startFrame,
			// Masters and single frames carry the transition fades; a static still gets them here.
			includesFades: plan.variant.recipe !== 'still',
			...(bake.still ? { still: true } : {}),
			...(bake.rect ? { rect: bake.rect } : {}),
			...(plan.colorRuns ? { colorRuns: true } : {}),
		},
	};
}

export function layerBakeExtension(svc: LayerBakeService): NativeExtension {
	return {
		id: LAYER_BAKE_EXTENSION_ID,
		kinds: new Set(['text', 'shape', 'captions']),
		claimsLayer: (c) => needsBake(c),
		bakes: (c) => (needsBake(c) ? 'remotion' : null),
		bakesTransition: () => (svc.unavailableReason() ? null : 'remotion'),
		transitionOverride: (t: RenderTransition, prepared) =>
			(prepared as Prepared | undefined)?.[SPANS]?.get(t.id) ?? null,
		blockers(c) {
			if (!needsBake(c)) return [];
			const reason = svc.unavailableReason();
			return reason ? [`graphics layers need the Remotion renderer to bake (${reason})`] : [];
		},
		warnings(c) {
			if (!isDomLayer(c)) return [];
			const w = effectRunsOrderWarning(c);
			return w ? [{ code: 'DOM_GRADE_ORDER', message: w }] : [];
		},
		async prepare(planned: PlannedExport, ctx: NativePrepareContext): Promise<LayerBakePrepared> {
			const out: Prepared = new Map();
			const remotion = ctx.purpose === 'remotion';
			// On the Remotion path only DOM layers with colour effects need graded masters (LBK-010).
			const clips = planned.snapshot.videoTracks
				.flatMap((t) => t.clips)
				.filter((c) =>
					remotion
						? // three-d: a 3D layer runs its colour effects in its own capture chain (no graded master).
							isDomLayer(c) && hasColorEffects(c) && !c.threeD
						: needsBake(c),
				);
			// wave1c: GPU transition spans drawn in the export range (native composite only).
			const spans = remotion
				? []
				: planned.snapshot.videoTracks.flatMap((track) =>
						(track.transitions ?? [])
							.filter((t) => t.start < planned.range.end && t.start + t.duration > planned.range.start)
							.map((t) => ({ trackId: track.trackId, t })),
					);
			if (clips.length === 0 && spans.length === 0) return out;
			const reason = svc.unavailableReason();
			if (reason)
				throw new JobError(
					'LAYER_BAKE_UNAVAILABLE',
					`Graphics layers need the Remotion renderer to bake: ${reason}`,
					false,
				);
			const env = await svc.environment();
			const single = planned.range.end - planned.range.start === 1 ? planned.range.start : null;
			// The export's Remotion page budget (S11:LBK-022): its Remotion concurrency, shared by the bakes in flight.
			const budget = Math.max(1, ctx.concurrency ?? Math.max(1, Math.floor(availableParallelism() / 2)));
			const par = svc.parallelism;
			const maxInFlight = Math.max(1, par.maxInFlight ?? Math.min(budget, MAX_RENDERS_IN_FLIGHT));
			// Plans first (keys, documents, grades: cheap, in clip order), then the renders side by side.
			const items: { clip: RenderVisualClip | null; plan: BakePlan; grade: GradePlan | null }[] = [];
			for (const { trackId, t } of spans) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				let plan = await svc.planSpan(planned, trackId, t, { env });
				// A still inside the span: its cached master, else one frame.
				if (single !== null && !(await svc.lookup(plan.key)))
					plan = await svc.planSpan(planned, trackId, t, { env, frame: single });
				items.push({ clip: null, plan, grade: null });
			}
			for (const clip of clips) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				const plan = await svc.planBake(planned, clip, { env, frame: single });
				const grade = remotion
					? await svc.planGrade(planned, clip, plan, {
							// All registered extensions: the colour extension has no `prepareForRemotion`, so it is not in `ctx`.
							extensions: svc.extensions(),
							signal: ctx.signal,
							scratchDir: ctx.scratchDir,
							log: ctx.log,
							jobId: ctx.jobId,
						})
					: null;
				items.push({ clip, plan, grade });
			}
			// One render per entry (identical layers share a bake key; graded entries have their own keys).
			const groups = new Map<string, typeof items>();
			for (const it of items) {
				const k = it.grade?.key ?? it.plan.key;
				const group = groups.get(k);
				if (group) group.push(it);
				else groups.set(k, [it]);
			}
			const renders = [...groups.values()];
			const isMaster = (g: typeof items) => g[0]!.plan.variant.recipe === 'master';
			// Side by side, the masters split the budget by length; one after the other, each takes all of it (as before).
			const masters = renders.filter(isMaster);
			const masterShares = pageShares(
				masters.map((m) => m[0]!.plan.frames),
				budget,
			);
			const shares = new Map(masters.map((g, i) => [g, masterShares[i]!]));
			const release = par.sharedBrowser && maxInFlight > 1 ? svc.browserSession(ctx.jobId) : null;
			try {
				await runPagePool(
					renders.map((group) => {
						const { plan, grade } = group[0]!;
						return {
							want: !isMaster(group) ? 1 : maxInFlight === 1 ? budget : shares.get(group)!,
							weight: plan.frames + RENDER_FIXED_COST_FRAMES,
							run: async (g: PageGrant) => {
								const meta = {
									parentId: ctx.jobId,
									...(ctx.projectId ? { projectId: ctx.projectId } : {}),
									signal: g.signal,
									concurrency: g.pages,
									...(release ? { browserGroup: ctx.jobId } : {}),
									onProgress: g.progress,
								};
								const bake = await svc.ensureBake(plan, meta);
								const graded = grade ? await svc.ensureGraded(plan, grade, meta) : null;
								for (const it of group) {
									const entry = entryOf(it.plan, bake, it.grade, graded);
									if (it.clip) out.set(it.clip.clipId, entry);
									else if (entry.override) {
										out[SPANS] ??= new Map();
										out[SPANS].set(it.plan.clipId, entry.override);
									}
								}
							},
						};
					}),
					{
						budget,
						maxInFlight,
						signal: ctx.signal,
						onProgress: (p) =>
							ctx.stage(
								`Baking graphics ${p.done}/${p.total}${p.done < p.total ? ` · ${Math.floor(p.fraction * 100)} %` : ''}`,
							),
					},
				);
			} finally {
				await release?.();
			}
			// Clip order of the snapshot (the composite does not depend on it; logs and tests read it).
			const ordered: Prepared = new Map();
			for (const clip of clips) ordered.set(clip.clipId, out.get(clip.clipId)!);
			if (out[SPANS]) ordered[SPANS] = out[SPANS];
			ctx.log(
				`layer-bake: ${ordered.size} layer(s) and ${out[SPANS]?.size ?? 0} transition span(s) ready (${groups.size} render(s), budget ${budget} pages, ≤ ${maxInFlight} at once${release ? ', shared browser' : ''}; engine totals ${svc.stats.rendered} rendered, ${svc.stats.reused} reused, ${svc.stats.joined} joined)`,
			);
			return ordered;
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
