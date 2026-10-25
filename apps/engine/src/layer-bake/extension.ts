import type { RenderSnapshot, RenderTransition, RenderVisualClip } from '@jasper/project';
import type { LayerOverride, NativeExtension, NativePrepareContext } from '../export/native-ext.ts';
import type { PlannedExport } from '../export/planner.ts';
import { renderParallelism } from '../gaps/render-budget.ts';
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

type PreparedLayer = {
	/** Native composite (absent when prepared for the Remotion path). */
	override?: LayerOverride;
	/** Graded master for the Remotion path (LBK-010). */
	graded?: {
		key: string;
		rect: Rect | null;
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
/** spec 13 AS-071: stills per sheet render at most (bounds a sheet's frame size spread and a failed sheet's retry). */
const SHEET_MAX = 64;
/** Progress weight of one sheet frame (a still costs ≈ 0.1 s in a sheet against ≈ 3.4 s alone, textperf). */
const SHEET_FRAME_COST = 1;

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
	// spec 13 AS-070: the still of the layer region, drawn through Motion and the lowered effects by the kernel.
	if (plan.variant.recipe === 'layer-still' && plan.picture)
		return {
			override: {
				path: bake.path,
				space: 'layer',
				startFrame: plan.startFrame,
				still: true,
				lowered: plan.picture,
			},
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
		id: 'layer-bake',
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
			const budget = Math.max(1, ctx.concurrency ?? renderParallelism());
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
			// spec 13 AS-071: still bakes (static layers, lowered layers' layer stills) render together, many per sheet
			// render; the rest (masters, single frames, spans, graded entries) one render each, as before.
			const isSheet = (g: typeof items) => {
				const { plan, grade } = g[0]!;
				return (
					!grade && !plan.span && (plan.variant.recipe === 'still' || plan.variant.recipe === 'layer-still')
				);
			};
			const sheetGroups = renders.filter(isSheet);
			const singles = renders.filter((g) => !isSheet(g));
			// Similar sizes share a sheet (its frames are as large as its largest still).
			const area = (g: typeof items) => {
				const r = g[0]!.plan.rect;
				return r ? r.w * r.h : g[0]!.plan.material.width * g[0]!.plan.material.height;
			};
			sheetGroups.sort((a, b) => area(a) - area(b));
			const sheets: (typeof items)[][] = [];
			for (let i = 0; i < sheetGroups.length; i += SHEET_MAX)
				sheets.push(sheetGroups.slice(i, i + SHEET_MAX));
			// Side by side, the masters split the budget by length; one after the other, each takes all of it (as before).
			const masters = singles.filter(isMaster);
			const masterShares = pageShares(
				masters.map((m) => m[0]!.plan.frames),
				budget,
			);
			const shares = new Map(masters.map((g, i) => [g, masterShares[i]!]));
			const release = par.sharedBrowser && maxInFlight > 1 ? svc.browserSession(ctx.jobId) : null;
			const metaOf = (g: PageGrant) => ({
				parentId: ctx.jobId,
				...(ctx.projectId ? { projectId: ctx.projectId } : {}),
				signal: g.signal,
				concurrency: g.pages,
				...(release ? { browserGroup: ctx.jobId } : {}),
				onProgress: g.progress,
			});
			/** The entries of a group from its bake (a clipped layer still → a master of each clip, AS-070). */
			const finish = async (
				group: typeof items,
				bake: BakeResult,
				graded: { key: string; path: string; rect: Rect | null } | null,
				meta: ReturnType<typeof metaOf>,
			) => {
				for (const it of group) {
					if (bake.clipped && it.clip) {
						const master = await svc.planBake(planned, it.clip, { env, frame: single, master: true });
						const mb = await svc.ensureBake(master, meta);
						out.set(it.clip.clipId, entryOf(master, mb, null, null));
						continue;
					}
					const entry = entryOf(it.plan, bake, it.grade, graded);
					if (it.clip) out.set(it.clip.clipId, entry);
					else if (entry.override) {
						out[SPANS] ??= new Map();
						out[SPANS].set(it.plan.clipId, entry.override);
					}
				}
			};
			try {
				await runPagePool(
					[
						...sheets.map((sheet) => ({
							// A sheet spreads its frames over every page it is granted.
							want: budget,
							weight: sheet.length * SHEET_FRAME_COST + RENDER_FIXED_COST_FRAMES,
							run: async (g: PageGrant) => {
								const meta = metaOf(g);
								const bakes = await svc.ensureSheet(
									sheet.map((group) => group[0]!.plan),
									meta,
								);
								for (const group of sheet) {
									const bake = bakes.get(group[0]!.plan.key);
									if (!bake)
										throw new JobError(
											'LAYER_BAKE_FAILED',
											`The bake of "${group[0]!.plan.clipName}" is missing`,
											true,
										);
									await finish(group, bake, null, meta);
								}
							},
						})),
						...singles.map((group) => {
							const { plan, grade } = group[0]!;
							return {
								want: !isMaster(group) ? 1 : maxInFlight === 1 ? budget : shares.get(group)!,
								weight: plan.frames + RENDER_FIXED_COST_FRAMES,
								run: async (g: PageGrant) => {
									const meta = metaOf(g);
									const bake = await svc.ensureBake(plan, meta);
									const graded = grade ? await svc.ensureGraded(plan, grade, meta) : null;
									await finish(group, bake, graded, meta);
								},
							};
						}),
					],
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
