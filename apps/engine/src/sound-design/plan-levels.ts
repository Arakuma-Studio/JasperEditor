// Solved gains in the sound-design plan (spec 12 §2.4, P4-R2; wp-note "Phase 4 → WP4.1b"). After the placements are
// drafted, the plan's PREVIEW documents (the document with every item applied, `previewProposal`, once with the chosen
// sounds and once per alternative slot k with alternative k selected where an item has one) give where each sound
// would play; the bed (every sound effect silent) is rendered over the cue clusters of all of them, each sound alone,
// and the masking solver sets the gains:
//   - the chosen sounds (every layer) are solved together;
//   - alternative k of item i is solved with the chosen sounds of the other items (it replaces item i's layer 0).
// Each place item (and each alternative command set) then ends with `soundDesign.applyGains` naming its clips by the
// `$sfx_<n>_<layer>` refs its placement binds, so accepting it places the sound AT the solved gain with `sfx.level`
// {by: 'solver'} and the why-line (meta.why, the report) says "−3 dB, limited by dialogue A1". The solve is
// deterministic: the previews create their entities with ids seeded by item and alternative (so the same plan gives
// the same preview documents), the measurement caches are keyed by content, not ids (`bed.ts`), and the report names
// the plan's sounds by their item, layer ref (`$sfx_<n>_<layer>`) and alternative, never by preview clip ids.
import type {
	SfxLevelConflict,
	SfxSolvedLevel,
	SoundDesignPlanEvent,
	SoundDesignPlanReport,
} from '@jasper/api';
import type { SolverEvent } from '@jasper/audio-fx';
import {
	createSeededIdSource,
	type MgTemplateRegistry,
	type ProjectDocument,
	type Proposal,
	type ProposalDraft,
	previewProposal,
	type Registries,
	readClipSfx,
	type Sequence,
	type SoundDelivery,
	soundDesignSettingsOf,
} from '@jasper/project';
import type { MediaRegistry } from '../media/registry.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { type MeasureCache, measureSfxEvents, type SoundTarget } from './bed.ts';
import {
	conflictsOf,
	gainReport,
	levelOptions,
	type SfxInfo,
	sfxInfoOf,
	solveAt,
	solvedLevel,
	solverEventOf,
} from './levels.ts';

export type PlanLevelDeps = {
	ffmpeg?: Ffmpeg;
	registry?: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	registries: Registries;
	cache?: MeasureCache;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	onProgress?(fraction: number, stage: string): void;
	/** Wall time per stage (ms) is added here (diagnostics). */
	timing?: Record<string, number>;
};

type Item = ProposalDraft['items'][number];
type Cmd = Record<string, unknown> & { type?: unknown; layers?: unknown };

const isPlace = (c: Cmd) => c.type === 'soundDesign.place' && Array.isArray(c.layers);
/** The ref a place item's layer binds: `$sfx_<item number>_<layer>`. */
export const layerRef = (itemId: string, layer: number) =>
	`$sfx_${itemId.replace(/[^\w]/g, '_').replace(/^sfx_/, '')}_${layer}`;

/** The command set with its place layers binding their refs (the same refs in every alternative set). */
function withRefs(commands: Cmd[], itemId: string): Cmd[] {
	return commands.map((c) =>
		isPlace(c)
			? {
					...c,
					layers: (c.layers as Record<string, unknown>[]).map((l, k) => ({ ...l, ref: layerRef(itemId, k) })),
				}
			: c,
	);
}

const placeLayers = (commands: readonly Cmd[]): number =>
	(commands.find(isPlace)?.layers as unknown[] | undefined)?.length ?? 0;
const placeLayersOf = (items: readonly Item[], itemId: string): number => {
	const it = items.find((x) => x.id === itemId);
	return it ? placeLayers(it.commands as Cmd[]) : 0;
};

/** The preview of the draft with alternative `slot` selected where an item has one (0 = the chosen sounds). */
function preview(
	doc: ProjectDocument,
	draft: ProposalDraft,
	items: Item[],
	slot: number,
	ctx: { registries: Registries },
) {
	const p: Proposal = {
		version: 1,
		id: 'prp_0000000000000000',
		projectId: doc.projectId,
		sequenceId: draft.sequenceId ?? null,
		feature: draft.feature,
		title: draft.title,
		summary: draft.summary ?? '',
		author: 'user',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		baseRevision: 0,
		docHash: '',
		items: items.map((it) => ({
			...it,
			group: it.group ?? '',
			requires: it.requires ?? [],
			state: 'pending' as const,
			...(slot > 0 && (it.alternatives?.length ?? 0) >= slot ? { selectedAlternative: slot } : {}),
		})),
	};
	return previewProposal(
		doc,
		p,
		'undecided',
		{
			registries: ctx.registries,
			now: () => '2026-01-01T00:00:00.000Z',
			invariants: 'incremental',
		},
		{
			// the same item with the same sound selected gets the same ids in every slot and every run
			idsFor: (it) =>
				createSeededIdSource(
					`sound-design-plan:${p.sequenceId ?? ''}:${it.id}:${it.selectedAlternative ?? 0}`,
				),
		},
	);
}

/**
 * The document accepting every item of `draft` (its chosen sounds) would give, or null when no item applies. The
 * same seeded preview the solve measured (`preview`).
 */
export function planPreviewDocument(
	doc: ProjectDocument,
	draft: ProposalDraft,
	registries: Registries,
): ProjectDocument | null {
	const pv = preview(doc, draft, draft.items, 0, { registries });
	return pv.applied.length ? pv.document : null;
}

/** Per place item: its clip ids by layer, in the preview document. */
function clipsByItem(
	pv: ReturnType<typeof preview>,
	seqId: string,
	placeIds: readonly string[],
): Map<string, string[]> {
	const seq = pv.document.sequences[seqId];
	const out = new Map<string, string[]>();
	if (!seq) return out;
	for (const id of placeIds) {
		const g = pv.items[id];
		if (!g) continue;
		const layers: string[] = [];
		for (const cid of g.created) {
			const c = seq.clips[cid] as { kind?: string; sfx?: unknown } | undefined;
			if (c?.kind !== 'audio' || c.sfx === undefined) continue;
			const sfx = readClipSfx(c.sfx);
			if (sfx) layers[sfx.layer] = cid;
		}
		if (layers.length && layers.every(Boolean)) out.set(id, layers);
	}
	return out;
}

export type PlanLevelsResult =
	| { ok: true; items: Item[]; report: SoundDesignPlanReport }
	| { ok: false; warning: { code: string; message: string } };

/**
 * Solves the gains of a drafted plan. Returns new items (with refs and `soundDesign.applyGains`, meta and why-lines)
 * and the report with levels, or a warning when the levels cannot be measured (the draft is then kept: placement's
 * default levels apply). Throws only on abort.
 */
export async function solvePlanGains(
	doc: ProjectDocument,
	seq: Sequence,
	draft: ProposalDraft,
	report: SoundDesignPlanReport,
	deps: PlanLevelDeps,
	opts: { delivery?: SoundDelivery; mgTemplates?: MgTemplateRegistry } = {},
): Promise<PlanLevelsResult> {
	const t0 = Date.now();
	if (!deps.ffmpeg || !deps.registry)
		return {
			ok: false,
			warning: {
				code: 'W_LEVELS_UNMEASURED',
				message: 'The engine cannot render audio here: placement’s default levels apply',
			},
		};
	const delivery = opts.delivery ?? soundDesignSettingsOf(seq).delivery;
	const lo = levelOptions(delivery);
	const items: Item[] = draft.items.map((it) =>
		isPlaceItem(it)
			? {
					...it,
					commands: withRefs(it.commands as Cmd[], it.id),
					...(it.alternatives
						? {
								alternatives: it.alternatives.map((a) => ({
									...a,
									commands: withRefs(a.commands as Cmd[], it.id),
								})),
							}
						: {}),
				}
			: it,
	);
	const placeIds = items.filter(isPlaceItem).map((it) => it.id);
	if (placeIds.length === 0) return { ok: true, items, report };
	const slots = Math.max(0, ...items.map((it) => (isPlaceItem(it) ? (it.alternatives?.length ?? 0) : 0)));
	deps.onProgress?.(0, 'Previewing the placements');
	const previews: { doc: ProjectDocument; clips: Map<string, string[]> }[] = [];
	for (let k = 0; k <= slots; k++) {
		if (deps.signal?.aborted) throw new Error('aborted');
		const pv = preview(doc, draft, items, k, deps);
		previews.push({ doc: pv.document, clips: clipsByItem(pv, seq.id, placeIds) });
	}
	if (deps.timing) deps.timing.previews = (deps.timing.previews ?? 0) + (Date.now() - t0);
	const main = previews[0]!;
	const mainSeq = main.doc.sequences[seq.id] as Sequence;
	// What to measure: every layer of the chosen sounds; layer 0 of each alternative.
	const targets: (SoundTarget & { info: SfxInfo; slot: number; itemId: string; layer: number })[] = [];
	for (const id of placeIds) {
		const layers = main.clips.get(id) ?? [];
		layers.forEach((clipId, layer) => {
			const info = sfxInfoOf(main.doc, mainSeq, clipId, delivery);
			if (info)
				targets.push({ doc: main.doc, clipId, weight: info.weight, info, slot: 0, itemId: id, layer });
		});
		const it = items.find((x) => x.id === id)!;
		for (let k = 1; k <= (it.alternatives?.length ?? 0); k++) {
			const pk = previews[k]!;
			const clipId = pk.clips.get(id)?.[0];
			if (!clipId) continue;
			const info = sfxInfoOf(pk.doc, pk.doc.sequences[seq.id] as Sequence, clipId, delivery);
			if (info)
				targets.push({ doc: pk.doc, clipId, weight: info.weight, info, slot: k, itemId: id, layer: 0 });
		}
	}
	let measured: Awaited<ReturnType<typeof measureSfxEvents>>;
	try {
		measured = await measureSfxEvents(
			{ bedDoc: main.doc, sequenceId: seq.id, targets },
			{
				ff: deps.ffmpeg,
				registry: deps.registry,
				...(deps.cache ? { cache: deps.cache } : {}),
				...(deps.signal ? { signal: deps.signal } : {}),
				...(deps.onSpawn ? { onSpawn: deps.onSpawn } : {}),
				...(deps.onProgress ? { onProgress: (f, s) => deps.onProgress!(0.1 + 0.85 * f, s) } : {}),
			},
		);
	} catch (e) {
		if (deps.signal?.aborted) throw e;
		return {
			ok: false,
			warning: {
				code: 'W_LEVELS_UNMEASURED',
				message: `The levels could not be measured (${e instanceof Error ? e.message : String(e)}): placement’s default levels apply`,
			},
		};
	}
	if (deps.timing) {
		deps.timing.solo = (deps.timing.solo ?? 0) + measured.ms.sound;
		deps.timing.bed = (deps.timing.bed ?? 0) + measured.ms.bed;
		deps.timing.voice = (deps.timing.voice ?? 0) + measured.ms.voice;
	}
	// The chosen sounds, solved together.
	const mainTargets = targets.filter((t) => t.slot === 0 && measured.sounds.has(t.clipId));
	const mainEvents: SolverEvent[] = mainTargets.map((t) =>
		solverEventOf(t.info, measured.sounds.get(t.clipId)!),
	);
	const solved = solveAt(mainEvents, delivery);
	// The preview's clips do not exist in the project: the report names them by item, layer ref and alternative.
	const nameOf = new Map<string, { ref: string; itemId: string; label: string }>();
	for (const t of targets)
		nameOf.set(t.clipId, {
			ref: layerRef(t.itemId, t.layer),
			itemId: t.itemId,
			label:
				t.slot > 0
					? `${t.itemId} (alternative ${t.slot})`
					: `${t.itemId}${placeLayersOf(items, t.itemId) > 1 ? ` layer ${t.layer + 1}` : ''}`,
		});
	const named = (text: string) => {
		let out = text;
		for (const [id, n] of nameOf) if (out.includes(id)) out = out.split(id).join(n.label);
		return out;
	};
	const levelOf = new Map<string, SfxSolvedLevel>();
	const conflicts: SfxLevelConflict[] = [];
	solved.events.forEach((r, i) => {
		const t = mainTargets[i]!;
		levelOf.set(t.clipId, solvedLevel(r, measured.sounds.get(t.clipId)!, lo.truePeakCeilingDb));
		for (const c of conflictsOf(r, t.itemId))
			conflicts.push({ ...c, clipId: layerRef(t.itemId, t.layer), message: named(c.message) });
	});
	const solverWarnings = new Map<string, { code: string; message: string }>();
	const keepWarning = (w: { code: string; message: string }) => {
		if (w.code === 'W_CONFLICT') return; // reported as `conflicts`
		const m = { code: w.code, message: named(w.message).slice(0, 1000) };
		solverWarnings.set(`${m.code}\u0000${m.message}`, m);
	};
	for (const w of solved.warnings) keepWarning(w);
	// Each alternative in place of its item's chosen sound (layer 0), with the other chosen sounds.
	const altLevel = new Map<string, SfxSolvedLevel>();
	for (const t of targets) {
		if (t.slot === 0 || !measured.sounds.has(t.clipId)) continue;
		const own = mainTargets.findIndex((m) => m.itemId === t.itemId && m.layer === 0);
		const ev = solverEventOf(t.info, measured.sounds.get(t.clipId)!);
		const events = own >= 0 ? mainEvents.map((e, i) => (i === own ? ev : e)) : [...mainEvents, ev];
		const res = solveAt(events, delivery);
		const r = res.events[own >= 0 ? own : events.length - 1]!;
		altLevel.set(
			`${t.itemId}#${t.slot}`,
			solvedLevel(r, measured.sounds.get(t.clipId)!, lo.truePeakCeilingDb),
		);
		// what this solve says about the alternative itself (the chosen sounds' own warnings come from the main solve)
		for (const w of res.warnings) if (w.clipId === t.clipId) keepWarning(w);
	}
	const gainsCommand = (itemId: string, levels: (SfxSolvedLevel | undefined)[]) => {
		const gains: Record<string, number> = {};
		const rep: Record<string, ReturnType<typeof gainReport>> = {};
		levels.forEach((l, layer) => {
			if (!l) return;
			gains[layerRef(itemId, layer)] = l.gainDb;
			rep[layerRef(itemId, layer)] = gainReport(l);
		});
		return Object.keys(gains).length
			? { type: 'soundDesign.applyGains', sequenceId: seq.id, gains, report: rep }
			: null;
	};
	const reportEvents = new Map(report.events.map((e) => [e.itemId, e]));
	const out: Item[] = items.map((it) => {
		if (!isPlaceItem(it)) return it;
		const layers = main.clips.get(it.id) ?? [];
		const levels = Array.from({ length: placeLayers(it.commands as Cmd[]) }, (_, k) =>
			layers[k] ? levelOf.get(layers[k]!) : undefined,
		);
		const cmd = gainsCommand(it.id, levels);
		const l0 = levels[0];
		const meta = { ...(it.meta ?? {}) } as Record<string, unknown>;
		if (l0) {
			meta.why = `${String(meta.why ?? '')} · ${l0.reason}`.slice(0, 1000);
			meta.gainDb = l0.gainDb;
			meta.level = levelMeta(l0);
		}
		// the further layers of a marker naming several types ("sfx: boom+whoosh"), in layer order
		if (levels.length > 1) meta.layerLevels = levels.slice(1).map((l) => (l ? levelMeta(l) : null));
		const ev = reportEvents.get(it.id) as (SoundDesignPlanEvent & Record<string, unknown>) | undefined;
		if (ev && l0) {
			ev.why = `${ev.why} · ${l0.reason}`.slice(0, 1000);
			ev.level = l0;
			if (levels.length > 1) ev.layerLevels = levels.slice(1).filter((l): l is SfxSolvedLevel => !!l);
		}
		const alternatives = it.alternatives?.map((a, k) => {
			const al = altLevel.get(`${it.id}#${k + 1}`);
			const altCmd = gainsCommand(it.id, [al, ...levels.slice(1)]);
			const am = { ...(a.meta ?? {}) } as Record<string, unknown>;
			if (al) {
				am.why = `${String(am.why ?? '')} · ${al.reason}`.slice(0, 1000);
				am.gainDb = al.gainDb;
				am.level = levelMeta(al);
			}
			return {
				...a,
				commands: altCmd ? [...a.commands, altCmd] : a.commands,
				...(Object.keys(am).length ? { meta: am } : {}),
			};
		});
		if (ev && it.alternatives?.length)
			ev.alternativeLevels = it.alternatives.map((_, k) => altLevel.get(`${it.id}#${k + 1}`) ?? null);
		return {
			...it,
			commands: cmd ? [...it.commands, cmd] : it.commands,
			meta,
			...(alternatives ? { alternatives } : {}),
		};
	});
	const warnings = [
		...report.warnings,
		...measured.missing.map((m) => ({
			code: 'W_LEVEL_UNMEASURED',
			message: `${nameOf.get(m.clipId)?.label ?? m.clipId}: ${m.reason}; placement’s default level applies`,
		})),
		...solverWarnings.values(),
	];
	return {
		ok: true,
		items: out,
		report: {
			...report,
			warnings,
			conflicts,
			levels: {
				delivery,
				programLufs: lo.programLufs,
				truePeakCeilingDb: lo.truePeakCeilingDb,
				clusters: measured.clusters.length,
				clusterSeconds:
					Math.round(measured.clusters.reduce((n, c) => n + (c.end - c.start), 0) * 1000) / 1000,
				renders: measured.renders,
				ms: Date.now() - t0,
			},
		},
	};
}

function isPlaceItem(it: Item): boolean {
	return (it.commands as Cmd[]).some(isPlace) && !(it.meta as { setup?: unknown } | undefined)?.setup;
}

const levelMeta = (l: SfxSolvedLevel) => ({
	gainDb: l.gainDb,
	targetLiftDb: l.targetLiftDb,
	achievedLiftDb: l.achievedLiftDb,
	limitedBy: l.limitedBy,
	reason: l.reason,
});
