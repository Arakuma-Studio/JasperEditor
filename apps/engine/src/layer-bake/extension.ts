import type { RenderSnapshot, RenderTransition, RenderVisualClip } from '@jasper/project';
import type { LayerOverride, NativeExtension, NativePrepareContext } from '../export/native-ext.ts';
import type { PlannedExport } from '../export/planner.ts';
import { renderParallelism } from '../gaps/render-budget.ts';
import { JobError } from '../jobs/types.ts';
import { type PageGrant, pageShares, runPagePool } from '../remotion/page-pool.ts';
import {
	effectRunsOrderWarning,
	hasColorEffects,
	isColorEffect,
	isDomLayer,
	needsBake,
	type Rect,
} from './layer.ts';
import { runEligible, shakeRuns } from './runs.ts';
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

/**
 * Bakes rendering at once at most (wp-note export-performance "Layer bake"): one render captures ≈ 5 frames/s on one
 * page, ≈ 10 on two and ≈ 11–12 on four (measured on 17 animated titles, 1280×720), so a large budget renders more
 * bakes at once, two pages each, rather than more pages per bake (12 × 2 pages: ≈ 105 frames/s; 6 × 2: ≈ 60).
 */
const MAX_BAKES_IN_FLIGHT = 12;
/** Fixed cost of a render (browser page, bundle, stitch, checks) in frames, for the aggregated progress. */
const RENDER_FIXED_COST_FRAMES = 30;
/** spec 13 AS-071: stills per sheet render at most (bounds a sheet's frame size spread and a failed sheet's retry). */
const SHEET_MAX = 128;
/** Remotion pages all sheets of an export use together, and sheets rendered side by side (Chrome memory bound). */
const SHEET_PAGES = 4;
/** Pages of the sheets of a large bake (more than two sheets: memory over speed, spec 13 AS-076's 6 GB). */
const SHEET_PAGES_LARGE = 2;
/** Stills of the first sheet of a pipelined export (ready soon: the composite starts with them). */
const FIRST_SHEET = 16;
const SHEET_IN_FLIGHT = 1;
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
				lowered: bake.picture ?? plan.picture,
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
			// output-size.ts: masters of an export composited at its output size render at it
			const scale = planned.composite?.size === 'output' ? planned.composite.scale : 1;
			const env = { ...(await svc.environment()), ...(scale !== 1 ? { scale } : {}) };
			const single = planned.range.end - planned.range.start === 1 ? planned.range.start : null;
			// The export's Remotion page budget (S11:LBK-022): its Remotion concurrency, shared by the bakes in flight.
			const par = svc.parallelism;
			const budget = Math.max(1, par.pages ?? ctx.bakePages ?? ctx.concurrency ?? renderParallelism());
			const maxInFlight = Math.max(1, par.maxInFlight ?? Math.min(budget, MAX_BAKES_IN_FLIGHT));
			// Plans first (keys, documents, grades: cheap, in clip order), then the renders side by side.
			const items: {
				clip: RenderVisualClip | null;
				plan: BakePlan;
				grade: GradePlan | null;
				/** spec 13 AS-073: the layers a run master (`planRun`) draws. */
				run?: RenderVisualClip[];
			}[] = [];
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
			// spec 13 AS-073: shaken layers the kernel cannot draw (S_Shake with motion blur, RGB split or wrap) are
			// masters; those of a track that follow each other render as ONE master per run (one render's fixed cost and
			// one composite input instead of one each).
			if (!remotion && single === null) {
				const byTrack = new Map<string, typeof items>();
				for (const it of items) {
					const c = it.clip;
					if (!c || it.grade || it.plan.span || it.plan.variant.recipe !== 'master' || !runEligible(c))
						continue;
					const list = byTrack.get(c.trackId) ?? [];
					list.push(it);
					byTrack.set(c.trackId, list);
				}
				const inRun = new Set<(typeof items)[number]>();
				const runs: (typeof items)[number][] = [];
				for (const [trackId, list] of byTrack) {
					for (const group of shakeRuns(list, (it) => it.clip!)) {
						for (const it of group) inRun.add(it);
						const clipsOfRun = group.map((it) => it.clip!);
						const plan = await svc.planRun(planned, trackId, clipsOfRun, { env });
						runs.push({ clip: null, plan, grade: null, run: clipsOfRun });
					}
				}
				if (runs.length) {
					const kept = items.filter((it) => !inRun.has(it));
					items.length = 0;
					items.push(...kept, ...runs);
				}
			}
			const isMaster = (g: typeof items) => g[0]!.plan.variant.recipe === 'master';
			// spec 13 AS-071: still bakes (static layers, lowered layers' layer stills) render together, many per sheet
			// render; the rest (masters, single frames, spans, graded entries) one render each, as before.
			const isSheet = (g: typeof items) => {
				const { plan, grade } = g[0]!;
				return (
					!grade && !plan.span && (plan.variant.recipe === 'still' || plan.variant.recipe === 'layer-still')
				);
			};
			const area = (g: typeof items) => {
				const r = g[0]!.plan.rect;
				return r ? r.w * r.h : g[0]!.plan.material.width * g[0]!.plan.material.height;
			};
			const release = par.sharedBrowser && maxInFlight > 1 ? svc.browserSession(ctx.jobId) : null;
			const metaOf = (g: PageGrant) => ({
				parentId: ctx.jobId,
				...(ctx.projectId ? { projectId: ctx.projectId } : {}),
				signal: g.signal,
				concurrency: g.pages,
				...(release ? { browserGroup: ctx.jobId } : {}),
				onProgress: g.progress,
				onRendered: g.release,
				log: ctx.log,
			});
			/** spec 13 AS-070: layer stills that drew past their border (baked again: grown, then as masters). */
			const clipped: typeof items = [];
			/** The entries of a group from its bake. */
			const finish = (
				group: typeof items,
				bake: BakeResult,
				graded: { key: string; path: string; rect: Rect | null } | null,
			) => {
				for (const it of group) {
					if (bake.clipped && it.clip) {
						clipped.push(it);
						continue;
					}
					if (it.run) {
						// One input for the run: every clip points at it; the builder draws it once.
						const run = { id: it.plan.key, f0: it.plan.startFrame, f1: it.plan.startFrame + it.plan.frames };
						for (const c of it.run)
							out.set(c.clipId, {
								override: {
									path: bake.path,
									space: 'sequence',
									startFrame: it.plan.startFrame,
									includesFades: true,
									run,
								},
							});
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
			let renderCount = 0;
			/** The background still bakes of a pipelined export (see below). */
			const background = (pending: Map<string, typeof items>) => {
				// Its own hold on the shared render browser (the masters of `prepare` may still be using it).
				const releaseBackground = release ? svc.browserSession(ctx.jobId) : null;
				type Ready = { ok: true; picture?: Rect } | { ok: false; reason: string };
				const deferred = new Map<string, { resolve(r: Ready): void; reject(e: unknown): void }>();
				for (const [key, group] of pending) {
					const ready = new Promise<Ready>((resolve, reject) => deferred.set(key, { resolve, reject }));
					ready.catch(() => undefined);
					const plan = group[0]!.plan;
					const file = svc.stillFile(key);
					for (const it of group) {
						const entry = entryOf(
							it.plan,
							{
								key,
								path: file,
								still: true,
								rect: plan.rect,
								frames: 1,
								width: plan.rect?.w ?? plan.material.width,
								height: plan.rect?.h ?? plan.material.height,
							},
							null,
							null,
						);
						out.set(it.clip!.clipId, { override: { ...entry.override!, ready } });
					}
				}
				// Time order: the stream needs the earliest subtitles first.
				const groups = [...pending.values()].sort(
					(a, b) => Math.min(...a.map((x) => x.clip!.start)) - Math.min(...b.map((x) => x.clip!.start)),
				);
				const sheets: (typeof items)[][] = [];
				for (let i = 0; i < groups.length; ) {
					// Doubling sizes (16, 32, 64, 128…): each sheet's stills arrive before the composite reaches them,
					// at one sheet's fixed cost more per doubling.
					const n = Math.min(SHEET_MAX, FIRST_SHEET * 2 ** sheets.length);
					sheets.push(groups.slice(i, i + n));
					i += n;
				}
				// Pages by still count (more than two full sheets), not by the count of the doubling sheets.
				const sheetBudget = Math.min(budget, groups.length > 2 * SHEET_MAX ? SHEET_PAGES_LARGE : SHEET_PAGES);
				const pool = runPagePool(
					sheets.map((sheet, i) => ({
						want: sheetBudget,
						// The pool starts heavier tasks first: decreasing weights keep the time order.
						weight: sheets.length - i,
						run: async (g: PageGrant) => {
							const bakes = await svc.ensureSheet(
								sheet.map((group) => group[0]!.plan),
								metaOf(g),
							);
							for (const group of sheet) {
								const { plan } = group[0]!;
								const bake = bakes.get(plan.key);
								const same =
									!!bake &&
									!bake.clipped &&
									(plan.variant.recipe === 'layer-still' ||
										JSON.stringify(bake.rect) === JSON.stringify(plan.rect));
								deferred
									.get(plan.key)!
									.resolve(
										same
											? { ok: true, ...(bake!.picture ? { picture: bake!.picture } : {}) }
											: { ok: false, reason: `the still of "${plan.clipName}" changed while baking` },
									);
							}
						},
					})),
					{ budget: sheetBudget, maxInFlight: 1, signal: ctx.backgroundSignal ?? ctx.signal },
				);
				// The export hears of a failure before the streams waiting for these stills do (reactions run in
				// registration order), so it fails as a preparation does.
				ctx.background!(pool.then(() => undefined));
				pool.then(
					() => undefined,
					(e) => {
						for (const d of deferred.values()) d.reject(e);
					},
				);
				pool.finally(() => releaseBackground?.()).catch(() => undefined);
			};
			/** One round: one render per entry (identical layers share a bake key; graded entries have their own). */
			const round = async (list: typeof items) => {
				const groups = new Map<string, typeof items>();
				for (const it of list) {
					const k = it.grade?.key ?? it.plan.key;
					const group = groups.get(k);
					if (group) group.push(it);
					else groups.set(k, [it]);
				}
				renderCount += groups.size;
				const renders = [...groups.values()];
				const sheetGroups = renders.filter(isSheet).sort((a, b) => area(a) - area(b));
				const singles = renders.filter((g) => !isSheet(g));
				// Similar sizes share a sheet (its frames are as large as its largest still).
				const sheets: (typeof items)[][] = [];
				for (let i = 0; i < sheetGroups.length; i += SHEET_MAX)
					sheets.push(sheetGroups.slice(i, i + SHEET_MAX));
				// Side by side, the masters split the budget by length; one after the other, each takes all of it.
				const masters = singles.filter(isMaster);
				const masterShares = pageShares(
					masters.map((m) => m[0]!.plan.frames),
					budget,
					maxInFlight,
				);
				const shares = new Map(masters.map((g, i) => [g, masterShares[i]!]));
				// Sheets run first, at most SHEET_IN_FLIGHT side by side on at most SHEET_PAGES pages (their fixed costs
				// overlap; Chrome's memory stays bounded however many stills: spec 13 AS-076's 6 GB), then the rest.
				const sheetBudget = Math.min(budget, sheets.length > 2 ? SHEET_PAGES_LARGE : SHEET_PAGES);
				const perSheet = Math.max(
					1,
					Math.floor(sheetBudget / Math.min(SHEET_IN_FLIGHT, Math.max(1, sheets.length))),
				);
				const progress = (p: { done: number; total: number; fraction: number }) =>
					ctx.stage(
						`Baking graphics ${p.done}/${p.total}${p.done < p.total ? ` · ${Math.floor(p.fraction * 100)} %` : ''}`,
					);
				await runPagePool(
					sheets.map((sheet) => ({
						// A sheet spreads its frames over every page it is granted.
						want: maxInFlight === 1 ? sheetBudget : perSheet,
						weight: sheet.length * SHEET_FRAME_COST + RENDER_FIXED_COST_FRAMES,
						run: async (g: PageGrant) => {
							const bakes = await svc.ensureSheet(
								sheet.map((group) => group[0]!.plan),
								metaOf(g),
							);
							for (const group of sheet) {
								const bake = bakes.get(group[0]!.plan.key);
								if (!bake)
									throw new JobError(
										'LAYER_BAKE_FAILED',
										`The bake of "${group[0]!.plan.clipName}" is missing`,
										true,
									);
								finish(group, bake, null);
							}
						},
					})),
					{
						budget: sheetBudget,
						maxInFlight: Math.min(maxInFlight, SHEET_IN_FLIGHT),
						signal: ctx.signal,
						onProgress: progress,
					},
				);
				await runPagePool(
					[
						...singles.map((group) => {
							const { plan, grade } = group[0]!;
							return {
								want: !isMaster(group) ? 1 : maxInFlight === 1 ? budget : shares.get(group)!,
								weight: plan.frames + RENDER_FIXED_COST_FRAMES,
								run: async (g: PageGrant) => {
									const meta = metaOf(g);
									const bake = await svc.ensureBake(plan, meta);
									const graded = grade ? await svc.ensureGraded(plan, grade, meta) : null;
									finish(group, bake, graded);
								},
							};
						}),
					],
					{ budget, maxInFlight, signal: ctx.signal, onProgress: progress },
				);
			};
			// spec 13 AS-076 — pipelined stills: a native export does not wait for the still bakes its kernel streams draw
			// (they are decoded only when the stream reaches them): those missing from the cache get provisional entries
			// (the planned file and region) with a `ready` promise, and are rendered in the background in time order
			// (a small first sheet, so the first subtitles are ready early) while the composite runs. A still that comes
			// out different (clipped, re-cropped) makes the export restart without the pipeline (`ready` → not ok).
			const pipelined = !remotion && single === null && ctx.pipeline !== false && !!ctx.background;
			let now = items;
			if (pipelined) {
				now = [];
				const pending = new Map<string, typeof items>();
				for (const it of items) {
					const { plan, grade } = it;
					const sheetable =
						!!it.clip &&
						!grade &&
						!plan.span &&
						(plan.variant.recipe === 'still' || plan.variant.recipe === 'layer-still');
					if (!sheetable || pending.has(plan.key) || (await svc.lookup(plan.key))) {
						if (sheetable && pending.has(plan.key)) pending.get(plan.key)!.push(it);
						else now.push(it);
						continue;
					}
					pending.set(plan.key, [it]);
				}
				if (pending.size > 0) background(pending);
			}
			try {
				await round(now);
				// spec 13 AS-070: a layer still that touched its border is baked with a grown region (sheets again),
				// then, still clipped, as a master.
				for (const master of [false, true]) {
					if (clipped.length === 0) break;
					const again: typeof items = [];
					for (const it of clipped.splice(0)) {
						if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
						const plan = await svc.planBake(planned, it.clip!, {
							env,
							frame: single,
							...(master ? { master: true } : { grow: true }),
						});
						again.push({ clip: it.clip, plan, grade: null });
					}
					await round(again);
				}
				if (clipped.length)
					throw new JobError(
						'LAYER_BAKE_FAILED',
						`The master of "${clipped[0]!.plan.clipName}" is clipped`,
						true,
					);
			} finally {
				await release?.();
			}
			// Clip order of the snapshot (the composite does not depend on it; logs and tests read it).
			const ordered: Prepared = new Map();
			for (const clip of clips) ordered.set(clip.clipId, out.get(clip.clipId)!);
			if (out[SPANS]) ordered[SPANS] = out[SPANS];
			ctx.log(
				`layer-bake: ${ordered.size} layer(s) and ${out[SPANS]?.size ?? 0} transition span(s) ready (${renderCount} render(s), budget ${budget} pages, ≤ ${maxInFlight} at once${release ? ', shared browser' : ''}; engine totals ${svc.stats.rendered} rendered, ${svc.stats.reused} reused, ${svc.stats.joined} joined)`,
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
