import type { RenderSnapshot, RenderTransition, RenderVisualClip } from '@jasper/project';
import {
	describeLayers,
	type FailedLayer,
	failureText,
	LayerBakeError,
	type LayerOverride,
	LayerPendingError,
	layerSpan,
	type NativeExtension,
	type NativePrepareContext,
} from '../export/native-ext.ts';
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
	type EnsureMeta,
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
	/** docs/wp-notes/export-performance.md §13: baking beside the composite (the clip's name); no entry yet. */
	pending?: string;
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
/**
 * Renders of one bake at most: a retryable failure (e.g. a browser that broke mid-render: the shared-browser
 * frame-extraction cross-talk of docs/wp-notes/wp-m2-layer-bake.md "Failed bakes") is baked again, in a browser of its
 * own; still failing, the export renders the layer's frames on the Remotion path (`LayerBakeError`).
 */
const BAKE_ATTEMPTS = 3;

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
				/** The layers this render draws and their frames (what a failure names). */
				layers: FailedLayer[];
			}[] = [];
			const layerOf = (c: RenderVisualClip): FailedLayer => {
				const [start, end] = layerSpan(c, planned.range);
				return { clipId: c.clipId, name: c.name, start, end };
			};
			for (const { trackId, t } of spans) {
				if (ctx.signal.aborted) throw new JobError('JOB_CANCELLED', 'Cancelled');
				let plan = await svc.planSpan(planned, trackId, t, { env });
				// A still inside the span: its cached master, else one frame.
				if (single !== null && !(await svc.lookup(plan.key)))
					plan = await svc.planSpan(planned, trackId, t, { env, frame: single });
				items.push({
					clip: null,
					plan,
					grade: null,
					layers: [
						{
							clipId: t.id,
							name: plan.clipName,
							start: Math.max(t.start, planned.range.start),
							end: Math.min(t.start + t.duration, planned.range.end),
						},
					],
				});
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
				items.push({ clip, plan, grade, layers: [layerOf(clip)] });
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
						runs.push({ clip: null, plan, grade: null, run: clipsOfRun, layers: clipsOfRun.map(layerOf) });
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
			/**
			 * One bake (`render`) of `groups`, rendered again after a retryable failure (BAKE_ATTEMPTS) in a browser of its
			 * own: a bake that succeeded on a retry is a warning of the export, one that still fails a `LayerBakeError`
			 * naming its layers and frames.
			 */
			const withRetries = async <R>(
				groups: readonly (typeof items)[],
				g: PageGrant,
				render: (meta: EnsureMeta) => Promise<R>,
			): Promise<R> => {
				const layers = groups.flatMap((group) => group.flatMap((it) => it.layers));
				let first: unknown = null;
				for (let attempt = 1; ; attempt++) {
					let meta: EnsureMeta = metaOf(g);
					if (attempt > 1) {
						// (the first attempt gave its pages back once it had captured its frames: no second release)
						const { browserGroup: _shared, onRendered: _released, ...own } = meta;
						meta = own;
					}
					try {
						const r = await render(meta);
						if (attempt > 1) {
							const message = `Baking ${describeLayers(layers)} failed (${failureText(first)}); it was baked again on attempt ${attempt}`;
							ctx.log(`warning LAYER_BAKE_RETRIED: ${message}`);
							ctx.warn?.({ code: 'LAYER_BAKE_RETRIED', message });
						}
						return r;
					} catch (e) {
						if (ctx.signal.aborted || g.signal.aborted || (e as JobError)?.code === 'JOB_CANCELLED') throw e;
						first ??= e;
						const again = attempt < BAKE_ATTEMPTS && (e as JobError)?.retryable !== false;
						ctx.log(
							`layer-bake: ${describeLayers(layers)} failed on attempt ${attempt} (${failureText(e)})${again ? '; baking again in a browser of its own' : ''}`,
						);
						if (!again) throw new LayerBakeError(layers, e, attempt);
					}
				}
			};
			/** spec 13 AS-070: layer stills that drew past their border (baked again: grown, then as masters). */
			const clipped: typeof items = [];
			/** The entries of a group from its bake. */
			const finish = (
				group: typeof items,
				bake: BakeResult,
				graded: { key: string; path: string; rect: Rect | null } | null,
				into: Prepared = out,
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
							into.set(c.clipId, {
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
					if (it.clip) into.set(it.clip.clipId, entry);
					else if (entry.override) {
						into[SPANS] ??= new Map();
						into[SPANS].set(it.plan.clipId, entry.override);
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
				// Time order: the stream needs the earliest subtitles first (§13: segments wait for theirs, the earliest streams).
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
							const bakes = await withRetries(sheet, g, (meta) =>
								svc.ensureSheet(
									sheet.map((group) => group[0]!.plan),
									meta,
								),
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
			/**
			 * docs/wp-notes/export-performance.md §13: the masters rendered after `prepare` returned, earliest first (the
			 * segments at the start of the range wait for them), side by side as in `round`. Each group's entries go into
			 * `into` when its bake is done, then the export hears of it (`ctx.defer`); a failure rejects the groups not done.
			 */
			const deferMasters = (
				list: (typeof items)[],
				into: Prepared,
				releaseLater: (() => Promise<void>) | null,
			) => {
				const clipsOf = (group: typeof items) => group.flatMap((it) => it.run ?? [it.clip!]);
				const groups = list
					.map((group) => {
						const spans = clipsOf(group).map((c) => layerSpan(c, planned.range));
						return {
							group,
							start: Math.min(...spans.map((x) => x[0])),
							end: Math.max(...spans.map((x) => x[1])),
						};
					})
					.sort((a, b) => a.start - b.start || a.end - b.end);
				const shares = pageShares(
					groups.map((g) => g.group[0]!.plan.frames),
					budget,
					maxInFlight,
				);
				const settle = groups.map(() => {
					const s = {} as { ready: Promise<void>; resolve(): void; reject(e: unknown): void };
					s.ready = new Promise<void>((resolve, reject) => {
						s.resolve = resolve;
						s.reject = reject;
					});
					s.ready.catch(() => undefined);
					return s;
				});
				const pool = runPagePool(
					groups.map(({ group }, i) => ({
						want: maxInFlight === 1 ? budget : shares[i]!,
						weight: group[0]!.plan.frames + RENDER_FIXED_COST_FRAMES,
						run: async (g: PageGrant) => {
							const bake = await withRetries([group], g, (meta) => svc.ensureBake(group[0]!.plan, meta));
							if (bake.clipped)
								throw new LayerBakeError(
									group.flatMap((it) => it.layers),
									new JobError(
										'LAYER_BAKE_FAILED',
										`The master of "${group[0]!.plan.clipName}" is clipped`,
										true,
									),
									1,
								);
							finish(group, bake, null, into);
							settle[i]!.resolve();
						},
					})),
					{ budget, maxInFlight, inOrder: true, signal: ctx.backgroundSignal ?? ctx.signal },
				);
				// Registered first: the export hears of a failure before the segments waiting for these bakes do.
				ctx.background!(pool.then(() => undefined));
				pool.then(
					() => undefined,
					(e) => {
						for (const s of settle) s.reject(e);
					},
				);
				pool.finally(() => releaseLater?.()).catch(() => undefined);
				for (const [i, g] of groups.entries())
					ctx.defer!({
						clipIds: clipsOf(g.group).map((c) => c.clipId),
						start: g.start,
						end: g.end,
						ready: settle[i]!.ready,
					});
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
				// One count over both pools (the sheets, then the rest): renders done, their weighted progress (child bakes
				// report their frames) and the layers rendering now, as the export's progress.
				const sheetWeight = (sheet: (typeof items)[]) =>
					sheet.length * SHEET_FRAME_COST + RENDER_FIXED_COST_FRAMES;
				const singleWeight = (group: typeof items) => group[0]!.plan.frames + RENDER_FIXED_COST_FRAMES;
				const sheetsWeight = sheets.reduce((n, sheet) => n + sheetWeight(sheet), 0);
				const allWeight = sheetsWeight + singles.reduce((n, group) => n + singleWeight(group), 0) || 1;
				const total = sheets.length + singles.length;
				const rendering: string[] = [];
				const named =
					<T>(label: string, run: (g: PageGrant) => Promise<T>) =>
					async (g: PageGrant): Promise<T> => {
						rendering.push(label);
						try {
							return await run(g);
						} finally {
							rendering.splice(rendering.indexOf(label), 1);
						}
					};
				const progress = (pool: 'sheets' | 'singles') => (p: { done: number; fraction: number }) => {
					const done = pool === 'sheets' ? p.done : sheets.length + p.done;
					const fraction =
						pool === 'sheets'
							? (p.fraction * sheetsWeight) / allWeight
							: (sheetsWeight + p.fraction * (allWeight - sheetsWeight)) / allWeight;
					const now = rendering.length
						? ` (${rendering[0]}${rendering.length > 1 ? ` +${rendering.length - 1}` : ''})`
						: '';
					const text = `Baking graphics ${done}/${total}${now}${done < total ? ` · ${Math.floor(fraction * 100)} %` : ''}`;
					if (ctx.progress) ctx.progress(fraction, text);
					else ctx.stage(text);
				};
				await runPagePool(
					sheets.map((sheet) => ({
						// A sheet spreads its frames over every page it is granted.
						want: maxInFlight === 1 ? sheetBudget : perSheet,
						weight: sheetWeight(sheet),
						run: named(`${sheet.length} still${sheet.length === 1 ? '' : 's'}`, async (g: PageGrant) => {
							const bakes = await withRetries(sheet, g, (meta) =>
								svc.ensureSheet(
									sheet.map((group) => group[0]!.plan),
									meta,
								),
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
						}),
					})),
					{
						budget: sheetBudget,
						maxInFlight: Math.min(maxInFlight, SHEET_IN_FLIGHT),
						signal: ctx.signal,
						onProgress: progress('sheets'),
					},
				);
				await runPagePool(
					[
						...singles.map((group) => {
							const { plan, grade } = group[0]!;
							return {
								want: !isMaster(group) ? 1 : maxInFlight === 1 ? budget : shares.get(group)!,
								weight: singleWeight(group),
								run: named(plan.clipName, async (g: PageGrant) => {
									const [bake, graded] = await withRetries([group], g, async (meta) => {
										const bake = await svc.ensureBake(plan, meta);
										return [bake, grade ? await svc.ensureGraded(plan, grade, meta) : null] as const;
									});
									finish(group, bake, graded);
								}),
							};
						}),
					],
					{ budget, maxInFlight, signal: ctx.signal, onProgress: progress('singles') },
				);
			};
			// spec 13 AS-076 — pipelined stills: a native export does not wait for the still bakes its kernel streams draw
			// (they are decoded only when the stream reaches them): those missing from the cache get provisional entries
			// (the planned file and region) with a `ready` promise, and are rendered in the background in time order
			// (a small first sheet, so the first subtitles are ready early) while the composite runs. A still that comes
			// out different (clipped, re-cropped) makes the export restart without the pipeline (`ready` → not ok).
			const pipelined = !remotion && single === null && ctx.pipeline !== false && !!ctx.background;
			let now = items;
			const pending = new Map<string, typeof items>();
			if (pipelined) {
				now = [];
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
			}
			// docs/wp-notes/export-performance.md §13 — masters beside the composite: the uncached masters of DOM layers
			// (titles, shapes, captions: no other extension reads their entries) render after `prepare` returned, the
			// earliest first; the export starts each segment once the masters it draws are ready.
			const later: typeof items = [];
			if (pipelined && ctx.defer) {
				const kept: typeof items = [];
				for (const it of now) {
					const dom = it.run ? it.run.every((c) => isDomLayer(c)) : !!it.clip && isDomLayer(it.clip);
					const deferrable = dom && !it.grade && !it.plan.span && it.plan.variant.recipe === 'master';
					if (deferrable && !(await svc.lookup(it.plan.key))) later.push(it);
					else kept.push(it);
				}
				now = kept;
			}
			if (pending.size > 0) background(pending);
			// (their own hold on the shared render browser, taken before `prepare`'s ends)
			const releaseLater = later.length && release ? svc.browserSession(ctx.jobId) : null;
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
						again.push({ clip: it.clip, plan, grade: null, layers: it.layers });
					}
					await round(again);
				}
				if (clipped.length)
					throw new LayerBakeError(
						clipped.flatMap((it) => it.layers),
						new JobError(
							'LAYER_BAKE_FAILED',
							`The master of "${clipped[0]!.plan.clipName}" is clipped`,
							true,
						),
						1,
					);
			} catch (e) {
				await releaseLater?.();
				throw e;
			} finally {
				await release?.();
			}
			/** The deferred masters by key (identical layers share a render). */
			const deferred = new Map<string, typeof items>();
			for (const it of later) {
				const group = deferred.get(it.plan.key);
				if (group) group.push(it);
				else deferred.set(it.plan.key, [it]);
				for (const c of it.run ?? [it.clip!]) out.set(c.clipId, { pending: c.name });
			}
			// Clip order of the snapshot (the composite does not depend on it; logs and tests read it).
			const ordered: Prepared = new Map();
			for (const clip of clips) ordered.set(clip.clipId, out.get(clip.clipId)!);
			if (out[SPANS]) ordered[SPANS] = out[SPANS];
			if (deferred.size > 0) deferMasters([...deferred.values()], ordered, releaseLater);
			ctx.log(
				`layer-bake: ${ordered.size - later.reduce((n, it) => n + (it.run?.length ?? 1), 0)} layer(s) and ${out[SPANS]?.size ?? 0} transition span(s) ready (${renderCount} render(s), budget ${budget} pages, ≤ ${maxInFlight} at once${release ? ', shared browser' : ''}; engine totals ${svc.stats.rendered} rendered, ${svc.stats.reused} reused, ${svc.stats.joined} joined)${deferred.size ? `; ${deferred.size} master render(s) beside the composite` : ''}`,
			);
			return ordered;
		},
		override(clip: RenderVisualClip, prepared): LayerOverride | null {
			const entry = (prepared as LayerBakePrepared | undefined)?.get(clip.clipId);
			if (entry?.pending) throw new LayerPendingError(entry.pending);
			return entry?.override ?? null;
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
