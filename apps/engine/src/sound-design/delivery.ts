// Delivery presets (spec 12 §2.4 "Delivery presets", §2.8, P4-R4; wp-note "Phase 4 → WP4.2a"): `POST
// /api/sound-design/delivery`, a `sound-design` job that MEASURES and then applies (or proposes) a preset through
// ordinary commands:
//   1. every enabled dialogue / music / ambience clip's own integrated loudness (BS.1770 on the export mixer, its effects
//      without gain, Volume, fades or pan — Essential Sound Auto-Match's measure);
//   2. with that Auto-Match applied (simulated on a copy), the activity of each music / ambience clip's "Duck against"
//      clips (dialogue by default) → ducking regions, exactly like Essential Sound ▸ Ducking ▸ Generate;
//   3. `soundDesign.applyDelivery` (settings, Mix loudness normalisation, Auto-Match by type, ducking, default SFX
//      levels) simulated, then the sound effects measured against the NEW bed and solved again (`applyGains`);
//   4. the resulting mix measured: its loudness before normalisation (stored as the Mix's loudness analysis so the
//      preview normalises too), the peak the export's limiter will keep under the ceiling, and how far under the voice
//      the music and ambience sit during speech (spec 12: music ≥ 8 LU, ambience ≥ 10 LU).
// Apply = ONE transaction "Apply Delivery Preset"; propose = a proposal (`delivery` item, then one `gain:` item per
// changed sound effect, each requiring it). The plan job uses `planDelivery` for its `style.delivery` setup item.
import { tmpdir } from 'node:os';
import {
	type SoundDeliveryClip,
	type SoundDeliveryMeasure,
	type SoundDeliveryReport,
	type SoundDeliveryRequest,
	SoundDeliveryRequestSchema,
	type SoundDeliveryResult,
} from '@jasper/api';
import {
	activeRegions,
	DUCK_BRIDGE_S,
	DUCK_HOP_S,
	DUCK_MIN_ON_S,
	LoudnessMeter,
	sensitivityThresholdDb,
} from '@jasper/audio-dsp';
import {
	type AudioClip,
	applyTransaction,
	createRandomIdSource,
	DELIVERY_RELATIVE_LU,
	deliveryMatchTargets,
	deliveryPreset,
	duckTriggerClips,
	FLICKS_PER_SECOND,
	frameToSample,
	mixFingerprint,
	type ProjectDocument,
	type ProposalDraft,
	type Rational,
	type Registries,
	readEssentialSound,
	type Sequence,
	SOUND_DESIGN_FEATURE,
	type SoundDelivery,
	sequenceDuration,
} from '@jasper/project';
import type { AgentService } from '../agent/service.ts';
import { renderMixdown } from '../audio/mixdown.ts';
import { ActivityEnvelope } from '../audio/service.ts';
import type { JobContext } from '../jobs/types.ts';
import { JobError } from '../jobs/types.ts';
import type { MediaRegistry } from '../media/registry.ts';
import type { ProposalService, Requester } from '../proposals/service.ts';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { HttpError } from '../tools/reply.ts';
import { type AudioWorld, audioWorld, type MeasureCache, measureSfxEvents } from './bed.ts';
import { fmtDb, gainReport, solveAt, solvedLevel, solverEventOf } from './levels.ts';
import { liveDocument, PlanInputError, planSequence } from './plan.ts';
import { rebalanceTargets } from './rebalance.ts';

export const DELIVERY_LABEL = 'Apply Delivery Preset';
/** Speech: dialogue momentary loudness over this (LUFS) and within `SPEECH_RANGE_LU` of its loudest moment. */
export const SPEECH_FLOOR_LUFS = -60;
export const SPEECH_RANGE_LU = 20;
/** Momentary loudness hop (s). */
const HOP_SEC = 0.1;
/** "Under the voice" is capped at this (LU) when the bed is silent during speech. */
const MAX_UNDER_LU = 99;
const SAME_DB = 0.005;

type Cmd = Record<string, unknown>;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export type DeliveryMeasureDeps = {
	ff: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	registries: Registries;
	cache?: MeasureCache;
	signal?: AbortSignal;
	onSpawn?(child: import('node:child_process').ChildProcess): void;
	onProgress?(fraction: number, stage: string): void;
};

export type DeliveryOptions = {
	delivery: SoundDelivery;
	loudness?: boolean;
	autoMatch?: boolean;
	ducking?: boolean;
	rebalance?: boolean;
};

export type DeliveryPlan = {
	/** `soundDesign.applyDelivery` (with the measured analysis when loudness is on). */
	command: Cmd;
	/** `soundDesign.applyGains` per changed sound effect (clip id → command), in timeline order. */
	gains: { clipId: string; title: string; fromDb: number; gainDb: number; reason: string; command: Cmd }[];
	report: SoundDeliveryReport;
	/** The document after both (simulated). */
	doc: ProjectDocument;
};

/** Applies commands to a copy of the document (a simulation: fresh random ids); throws a typed job error if refused. */
export function simulate(
	doc: ProjectDocument,
	sequenceId: string,
	commands: Cmd[],
	registries: Registries,
): ProjectDocument {
	if (commands.length === 0) return doc;
	const { document, result } = applyTransaction(
		doc,
		{ label: 'simulate', origin: 'user', sequenceId, commands },
		{
			ids: createRandomIdSource(),
			now: () => new Date().toISOString(),
			revision: 0,
			registries,
			invariants: 'incremental',
		},
	);
	if (!result.ok) {
		const e = result.errors[0];
		throw new JobError(
			'TRANSACTION_REJECTED',
			`The delivery does not apply to this sequence: ${e?.message ?? 'refused'}`,
			false,
			{ errors: result.errors.slice(0, 5) },
		);
	}
	return document;
}

const trackLabel = (seq: Sequence, trackId: string) => {
	const i = seq.audioTracks.findIndex((t) => t.id === trackId);
	return i >= 0 ? `A${i + 1}` : trackId;
};

const base = (world: AudioWorld, deps: DeliveryMeasureDeps) => ({
	ff: deps.ff,
	snapshot: world.snapshot,
	media: world.media,
	scratchDir: tmpdir(),
	measureOnly: true,
	withoutLoudness: true,
	...(deps.signal ? { signal: deps.signal } : {}),
	...(deps.onSpawn ? { onSpawn: deps.onSpawn } : {}),
});

/** Integrated loudness of a clip's own signal (Auto-Match's measure), null when silent or < 400 ms. */
async function clipLoudness(
	world: AudioWorld,
	clipId: string,
	deps: DeliveryMeasureDeps,
): Promise<number | null> {
	const rc = world.snapshot.audioClips.find((c) => c.clipId === clipId);
	if (!rc) return null;
	const r = await renderMixdown({
		...base(world, deps),
		range: { start: rc.start, end: rc.start + rc.duration },
		onlyClips: new Set([clipId]),
		clipLevels: 'source',
		tap: 'track-inputs',
	});
	const v = r.loudness.integrated;
	return fin(v) ? r3(v) : null;
}

/** Activity regions (sequence flicks) of `triggers` played together over `range` (frames), like the analysis job. */
async function activity(
	world: AudioWorld,
	triggers: string[],
	range: { start: number; end: number },
	sensitivity: number,
	deps: DeliveryMeasureDeps,
): Promise<[number, number][]> {
	const sr = world.snapshot.audioMix?.sampleRate ?? world.snapshot.settings.sampleRate;
	const env = new ActivityEnvelope(sr);
	await renderMixdown({
		...base(world, deps),
		range,
		onlyClips: new Set(triggers),
		clipLevels: 'mix',
		tap: 'track-inputs',
		onBlock: (p, n) => env.push(p, n),
	});
	const rel = activeRegions(
		env.envelope(),
		DUCK_HOP_S,
		sensitivityThresholdDb(sensitivity),
		DUCK_BRIDGE_S,
		DUCK_MIN_ON_S,
	);
	const t0 =
		(frameToSample(range.start, world.snapshot.settings.fps as Rational, sr) / sr) * FLICKS_PER_SECOND;
	return rel.map(([a, b]) => [
		Math.round(t0 + a * FLICKS_PER_SECOND),
		Math.round(t0 + b * FLICKS_PER_SECOND),
	]);
}

/**
 * The mix (master, before normalisation) of `clipIds` (null = everything) over `range`: its loudness summary and its
 * momentary loudness every 100 ms.
 */
async function mixLoudness(
	world: AudioWorld,
	range: { start: number; end: number },
	clipIds: ReadonlySet<string> | null,
	deps: DeliveryMeasureDeps,
) {
	const sr = world.snapshot.audioMix?.sampleRate ?? world.snapshot.settings.sampleRate;
	const hop = Math.max(1, Math.round(sr * HOP_SEC));
	let meter: LoudnessMeter | null = null;
	let pos = 0;
	const mom: number[] = [];
	const r = await renderMixdown({
		...base(world, deps),
		range,
		...(clipIds ? { onlyClips: clipIds } : {}),
		onBlock: (planar, n) => {
			meter ??= new LoudnessMeter(sr, planar.length);
			let i = 0;
			while (i < n) {
				const k = Math.min(n - i, hop - (pos % hop));
				meter.process(planar, i, k);
				i += k;
				pos += k;
				if (pos % hop === 0) mom.push(meter.momentary());
			}
		},
	});
	return { summary: r.loudness, momentary: mom };
}

/** Energy mean of momentary values (LUFS) over the frames `use` marks; −∞ when silent there. */
function meanLufs(m: readonly number[], use: readonly boolean[]): number {
	let e = 0;
	let n = 0;
	for (let i = 0; i < use.length; i++) {
		if (!use[i]) continue;
		n++;
		const v = m[i];
		if (fin(v)) e += 10 ** (v / 10);
	}
	return n > 0 && e > 0 ? 10 * Math.log10(e / n) : Number.NEGATIVE_INFINITY;
}

/** Clips of a sequence by Essential Sound type (enabled audio clips that play in the snapshot). */
function clipsByType(seq: Sequence, world: AudioWorld): Map<string, string[]> {
	const audible = new Set(world.snapshot.audioClips.map((c) => c.clipId));
	const out = new Map<string, string[]>();
	for (const c of Object.values(seq.clips).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))) {
		if (c.kind !== 'audio' || c.enabled === false || !audible.has(c.id)) continue;
		const t = readEssentialSound((c as AudioClip).essential)?.type;
		if (!t) continue;
		const list = out.get(t) ?? [];
		list.push(c.id);
		out.set(t, list);
	}
	return out;
}

/** Measures the resulting mix of `doc` (see the module docs). */
async function measureResult(
	doc: ProjectDocument,
	seqId: string,
	delivery: SoundDelivery,
	loudnessOn: boolean,
	deps: DeliveryMeasureDeps,
): Promise<{ measure: SoundDeliveryMeasure; analysis: Cmd | null }> {
	const world = await audioWorld(doc, seqId, deps.registry);
	const seq = doc.sequences[seqId] as Sequence;
	const range = { start: 0, end: Math.max(1, Math.ceil(sequenceDuration(seq))) };
	const preset = deliveryPreset(delivery);
	const all = await mixLoudness(world, range, null, deps);
	const types = clipsByType(seq, world);
	const integ = all.summary.integrated;
	const tp = all.summary.truePeakDb;
	const voice = types.get('dialogue') ?? [];
	let speechSeconds = 0;
	let musicUnder: number | null = null;
	let ambienceUnder: number | null = null;
	if (voice.length) {
		const v = await mixLoudness(world, range, new Set(voice), deps);
		const max = Math.max(...v.momentary.filter(fin));
		const use = v.momentary.map((x) => fin(x) && x >= Math.max(SPEECH_FLOOR_LUFS, max - SPEECH_RANGE_LU));
		speechSeconds = r3(use.filter(Boolean).length * HOP_SEC);
		const lv = meanLufs(v.momentary, use);
		const under = async (ids: string[] | undefined) => {
			if (!ids?.length || speechSeconds === 0 || !fin(lv)) return null;
			const b = await mixLoudness(world, range, new Set(ids), deps);
			const lb = meanLufs(b.momentary, use);
			return r2(fin(lb) ? Math.min(MAX_UNDER_LU, lv - lb) : MAX_UNDER_LU);
		};
		musicUnder = await under(types.get('music'));
		ambienceUnder = await under(types.get('ambience'));
	}
	const gain = fin(integ) ? preset.integratedLufs - integ : 0;
	const measure: SoundDeliveryMeasure = {
		mixLufs: fin(integ) ? r2(integ) : null,
		mixTruePeakDb: fin(tp) ? r2(tp) : null,
		expectedLufs: loudnessOn && fin(integ) ? preset.integratedLufs : fin(integ) ? r2(integ) : null,
		expectedTruePeakDb: fin(tp) ? r2(loudnessOn ? Math.min(preset.truePeakDb, tp + gain) : tp) : null,
		speechSeconds,
		musicUnderVoiceLu: musicUnder,
		ambienceUnderVoiceLu: ambienceUnder,
	};
	const s = all.summary;
	const analysis = fin(integ)
		? {
				integratedLufs: r3(integ),
				truePeakDbtp: fin(s.truePeakDb) ? r3(s.truePeakDb) : null,
				lra: fin(s.lra) ? r3(s.lra) : null,
				maxMomentaryLufs: fin(s.maxMomentary) ? r3(s.maxMomentary) : null,
				maxShortTermLufs: fin(s.maxShortTerm) ? r3(s.maxShortTerm) : null,
				mixHash: mixFingerprint(doc, seqId),
				analyzedAt: new Date().toISOString(),
			}
		: null;
	return { measure, analysis };
}

/**
 * Measures `doc`'s sequence for a delivery and builds its commands (see the module docs). Throws `JobError` when the
 * sequence cannot take it; aborts with the signal.
 */
export async function planDelivery(
	doc: ProjectDocument,
	seq: Sequence,
	opts: DeliveryOptions,
	deps: DeliveryMeasureDeps,
): Promise<DeliveryPlan> {
	const t0 = Date.now();
	const preset = deliveryPreset(opts.delivery);
	const warnings: { code: string; message: string }[] = [];
	const aborted = () => {
		if (deps.signal?.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	};
	const progress = (f: number, s: string) => deps.onProgress?.(f, s);
	// 1. Auto-Match measurements.
	progress(0.02, 'Measuring dialogue, music and ambience');
	const world0 = await audioWorld(doc, seq.id, deps.registry);
	const types0 = clipsByType(seq, world0);
	const hasDialogue = (types0.get('dialogue') ?? []).length > 0;
	const targets = deliveryMatchTargets(opts.delivery, hasDialogue);
	const clips: SoundDeliveryClip[] = [];
	const measured: Record<string, number | null> = {};
	if (opts.autoMatch !== false) {
		const ids = ['dialogue', 'music', 'ambience'].flatMap((t) =>
			(types0.get(t) ?? []).map((id) => ({ id, t })),
		);
		for (const [i, { id, t }] of ids.entries()) {
			aborted();
			progress(0.02 + (0.25 * i) / Math.max(1, ids.length), `Measuring clip ${i + 1} of ${ids.length}`);
			const lufs = await clipLoudness(world0, id, deps);
			measured[id] = lufs;
			const target = targets[t as 'dialogue' | 'music' | 'ambience'];
			clips.push({
				clipId: id,
				track: trackLabel(seq, seq.clips[id]!.trackId),
				type: t,
				measuredLufs: lufs,
				targetLufs: target,
				gainDb: null,
				...(lufs === null ? { skipped: 'silent, or shorter than 400 ms' } : {}),
			});
		}
	}
	const matchCmd: Cmd = {
		type: 'soundDesign.applyDelivery',
		sequenceId: seq.id,
		delivery: opts.delivery,
		loudness: false,
		...(Object.keys(measured).length ? { measuredLufs: measured } : {}),
	};
	const doc1 = simulate(doc, seq.id, [matchCmd], deps.registries);
	const seq1 = doc1.sequences[seq.id] as Sequence;
	// The gains Auto-Match gave (for the report).
	for (const c of clips) {
		const es = readEssentialSound((seq1.clips[c.clipId] as AudioClip | undefined)?.essential);
		if (c.measuredLufs !== null && es?.loudness.enabled) c.gainDb = r2(es.loudness.gainDb);
	}
	// 2. Ducking regions on the matched mix.
	const ducking: { clipIds: string[]; regions: [number, number][] }[] = [];
	const duckReport: SoundDeliveryReport['ducking'] = [];
	if (opts.ducking !== false) {
		const world1 = await audioWorld(doc1, seq.id, deps.registry);
		const audible = new Set(world1.snapshot.audioClips.map((c) => c.clipId));
		const types1 = clipsByType(seq1, world1);
		const groups = new Map<string, { clipIds: string[]; triggers: string[]; sensitivity: number }>();
		for (const id of [...(types1.get('music') ?? []), ...(types1.get('ambience') ?? [])]) {
			const es = readEssentialSound((seq1.clips[id] as AudioClip).essential)!;
			const triggers = duckTriggerClips(seq1, [id], es)
				.filter((t) => audible.has(t))
				.sort();
			if (triggers.length === 0) continue;
			const key = `${triggers.join(',')}|${es.ducking.sensitivity}`;
			const g = groups.get(key) ?? { clipIds: [], triggers, sensitivity: es.ducking.sensitivity };
			g.clipIds.push(id);
			groups.set(key, g);
		}
		let gi = 0;
		for (const g of groups.values()) {
			aborted();
			progress(0.3 + (0.15 * gi++) / Math.max(1, groups.size), 'Finding speech to duck under');
			const spans = g.clipIds.map((id) => seq1.clips[id]!);
			const range = {
				start: Math.min(...spans.map((c) => c.start)),
				end: Math.max(...spans.map((c) => c.start + c.duration)),
			};
			const regions = await activity(world1, g.triggers, range, g.sensitivity, deps);
			ducking.push({ clipIds: g.clipIds, regions });
			duckReport.push({ clipIds: g.clipIds, triggers: g.triggers, regions: regions.length });
		}
		if (
			hasDialogue &&
			groups.size === 0 &&
			((types1.get('music') ?? []).length || (types1.get('ambience') ?? []).length)
		)
			warnings.push({
				code: 'W_NO_DUCK_TRIGGERS',
				message:
					'No music or ambience clip has audible clips of its "Duck against" types: nothing was ducked',
			});
	}
	const command: Cmd = {
		type: 'soundDesign.applyDelivery',
		sequenceId: seq.id,
		delivery: opts.delivery,
		...(opts.loudness === false ? { loudness: false } : {}),
		...(Object.keys(measured).length ? { measuredLufs: measured } : {}),
		...(ducking.length ? { ducking } : {}),
	};
	aborted();
	const doc2 = simulate(doc, seq.id, [command], deps.registries);
	const seq2 = doc2.sequences[seq.id] as Sequence;
	// 3. Sound effects against the new bed.
	const gains: DeliveryPlan['gains'] = [];
	let sfx: SoundDeliveryReport['sfx'] = null;
	let doc3 = doc2;
	if (opts.rebalance !== false) {
		const picked = rebalanceTargets(doc2, seq2, { delivery: opts.delivery });
		if (picked.targets.length) {
			progress(0.5, `Balancing ${picked.targets.length} sound effects against the new bed`);
			const m = await measureSfxEvents(
				{
					bedDoc: doc2,
					sequenceId: seq.id,
					targets: picked.targets.map((t) => ({ doc: doc2, clipId: t.clipId, weight: t.weight })),
				},
				{
					ff: deps.ff,
					registry: deps.registry,
					...(deps.cache ? { cache: deps.cache } : {}),
					...(deps.signal ? { signal: deps.signal } : {}),
					...(deps.onSpawn ? { onSpawn: deps.onSpawn } : {}),
				},
			);
			const solvable = picked.targets.filter((t) => m.sounds.has(t.clipId));
			const solved = solveAt(
				solvable.map((t) => solverEventOf(t, m.sounds.get(t.clipId)!)),
				opts.delivery,
			);
			const ceiling = preset.truePeakDb;
			let limited = 0;
			solved.events.forEach((r, i) => {
				const info = solvable[i]!;
				const level = solvedLevel(r, m.sounds.get(info.clipId)!, ceiling);
				if (level.limitedBy.length) limited++;
				if (Math.abs(level.gainDb - info.gainDb) < SAME_DB && info.owner === 'solver') return;
				gains.push({
					clipId: info.clipId,
					title: info.title,
					fromDb: info.gainDb,
					gainDb: level.gainDb,
					reason: level.reason,
					command: {
						type: 'soundDesign.applyGains',
						sequenceId: seq.id,
						gains: { [info.clipId]: level.gainDb },
						report: { [info.clipId]: gainReport(level) },
					},
				});
			});
			sfx = {
				solved: solved.events.length,
				changed: gains.length,
				limited,
				skipped: picked.skipped.length + m.missing.length,
			};
			doc3 = simulate(
				doc2,
				seq.id,
				gains.map((g) => g.command),
				deps.registries,
			);
		}
	}
	// 4. The result.
	aborted();
	progress(0.75, 'Measuring the delivered mix');
	const res = await measureResult(doc3, seq.id, opts.delivery, opts.loudness !== false, deps);
	if (opts.loudness !== false && res.analysis) command.analysis = res.analysis;
	if (res.measure.musicUnderVoiceLu !== null && res.measure.musicUnderVoiceLu < DELIVERY_RELATIVE_LU.music)
		warnings.push({
			code: 'W_MUSIC_OVER_VOICE',
			message: `The music is ${fmtDb(res.measure.musicUnderVoiceLu)} LU under the voice during speech (target ≥ ${DELIVERY_RELATIVE_LU.music} LU): turn Ducking on for it or lower it`,
		});
	if (
		res.measure.ambienceUnderVoiceLu !== null &&
		res.measure.ambienceUnderVoiceLu < DELIVERY_RELATIVE_LU.ambience
	)
		warnings.push({
			code: 'W_AMBIENCE_OVER_VOICE',
			message: `The ambience is ${fmtDb(res.measure.ambienceUnderVoiceLu)} LU under the voice during speech (target ≥ ${DELIVERY_RELATIVE_LU.ambience} LU)`,
		});
	if (res.measure.mixLufs === null)
		warnings.push({ code: 'W_SILENT_MIX', message: 'The sequence is silent: there is nothing to normalise' });
	const report: SoundDeliveryReport = {
		version: 1,
		sequenceId: seq.id,
		delivery: opts.delivery,
		preset: {
			label: preset.label,
			integratedLufs: preset.integratedLufs,
			truePeakDb: preset.truePeakDb,
			source: preset.source,
		},
		hasDialogue,
		clips,
		ducking: duckReport,
		sfx,
		measure: res.measure,
		warnings,
		ms: Date.now() - t0,
	};
	progress(0.95, 'Measured');
	return { command, gains, report, doc: doc3 };
}

export type DeliveryDeps = {
	agent: () => AgentService | undefined;
	proposals: () => ProposalService | undefined;
	ffmpeg: Ffmpeg;
	registry: Pick<MediaRegistry, 'get' | 'resolvePath'>;
	registries: Registries;
	cache?: MeasureCache;
};

export type DeliveryJobInput = { delivery: SoundDeliveryRequest; who: Requester };

function parseInput(raw: unknown): DeliveryJobInput {
	const r = raw as { delivery?: unknown; who?: { editor?: unknown; agent?: unknown } } | null;
	const parsed = SoundDeliveryRequestSchema.safeParse(r?.delivery);
	if (!parsed.success) throw new JobError('VALIDATION_FAILED', 'The delivery request is invalid', false);
	return {
		delivery: parsed.data,
		who: {
			editor: r?.who?.editor === true,
			agent: typeof r?.who?.agent === 'string' ? r.who.agent.slice(0, 64) : 'An agent',
		},
	};
}

/** The `sound-design` job runner for delivery requests. */
export async function runDelivery(ctx: JobContext, deps: DeliveryDeps): Promise<SoundDeliveryResult> {
	try {
		return await delivery(ctx, deps);
	} catch (e) {
		if (e instanceof HttpError)
			throw new JobError(e.code, e.message, e.status === 503 || e.code === 'PROPOSAL_LIMIT', e.detail);
		if (e instanceof PlanInputError) throw new JobError(e.code, e.message, false);
		throw e;
	}
}

async function delivery(ctx: JobContext, deps: DeliveryDeps): Promise<SoundDeliveryResult> {
	const { delivery: req, who } = parseInput(ctx.input);
	const agent = deps.agent();
	if (!agent) throw new JobError('NOT_AVAILABLE', 'The agent service is not running', true);
	const mode = req.mode ?? 'propose';
	ctx.progress(0.01, { stage: 'Reading the edit' });
	const live = await liveDocument(agent, req.projectId);
	const seq = planSequence(live.doc, req.sequenceId);
	const plan = await planDelivery(
		live.doc,
		seq,
		{
			delivery: req.delivery,
			...(req.loudness !== undefined ? { loudness: req.loudness } : {}),
			...(req.autoMatch !== undefined ? { autoMatch: req.autoMatch } : {}),
			...(req.ducking !== undefined ? { ducking: req.ducking } : {}),
			...(req.rebalance !== undefined ? { rebalance: req.rebalance } : {}),
		},
		{
			ff: deps.ffmpeg,
			registry: deps.registry,
			registries: deps.registries,
			...(deps.cache ? { cache: deps.cache } : {}),
			signal: ctx.signal,
			onSpawn: ctx.trackChild,
			onProgress: (f, stage) => ctx.progress(0.02 + 0.85 * f, { stage }),
		},
	);
	if (ctx.signal.aborted) throw new JobError('CANCELLED', 'Cancelled', false);
	const result = { projectId: req.projectId, sequenceId: seq.id, mode } as const;
	const preset = deliveryPreset(req.delivery);
	if (mode === 'apply') {
		ctx.progress(0.9, { stage: 'Applying' });
		const out = await agent.transact(
			req.projectId,
			{
				label: `${DELIVERY_LABEL}: ${preset.label}`.slice(0, 200),
				origin: { agent: who.agent },
				sequenceId: seq.id,
				...(live.revision !== null ? { expectedRevision: live.revision } : {}),
				commands: [plan.command, ...plan.gains.map((g) => g.command)],
			},
			{ fallbackAgent: who.agent, ...(who.editor ? { preApproved: true, asUser: true } : {}) },
		);
		const r = out.result as { ok: boolean; revision?: number; errors?: { code: string; message: string }[] };
		if (!r.ok) {
			const e = r.errors?.[0];
			throw new JobError(
				e?.code === 'E_CONFLICT' ? 'CONFLICT' : (e?.code ?? 'TRANSACTION_REJECTED'),
				`The delivery was not applied: ${e?.message ?? 'the transaction was refused'}`,
				e?.code === 'E_CONFLICT',
				{ errors: r.errors?.slice(0, 5) ?? [] },
			);
		}
		ctx.progress(1, { stage: 'Applied' });
		return { ...result, applied: true, revision: r.revision ?? null, proposalId: null, report: plan.report };
	}
	const proposals = deps.proposals();
	if (!proposals) throw new JobError('NOT_AVAILABLE', 'The proposal service is not running', true);
	const name = Object.values(live.doc.items ?? {}).find(
		(it) => it?.kind === 'sequence' && (it as { sequenceId?: unknown }).sequenceId === seq.id,
	)?.name;
	const m = plan.report.measure;
	const width = Math.max(3, String(plan.gains.length).length);
	const draft: ProposalDraft = {
		sequenceId: seq.id,
		feature: SOUND_DESIGN_FEATURE,
		title: (req.label ?? `${preset.label}: ${typeof name === 'string' && name ? name : seq.id}`).slice(
			0,
			200,
		),
		summary: [
			`${preset.integratedLufs} LUFS / ${preset.truePeakDb} dBTP`,
			`${plan.report.clips.filter((c) => c.gainDb !== null).length} clips matched`,
			`${plan.report.ducking.reduce((n, g) => n + g.clipIds.length, 0)} ducked`,
			...(plan.gains.length ? [`${plan.gains.length} sound effects rebalanced`] : []),
			...(m?.musicUnderVoiceLu !== null && m?.musicUnderVoiceLu !== undefined
				? [`music ${fmtDb(m.musicUnderVoiceLu)} LU under the voice`]
				: []),
		]
			.join(' · ')
			.slice(0, 500),
		items: [
			{
				id: 'delivery',
				label: `${preset.label}: loudness, Auto-Match, ducking`.slice(0, 200),
				group: 'mix',
				commands: [plan.command],
				meta: {
					feature: SOUND_DESIGN_FEATURE,
					kind: 'delivery',
					delivery: req.delivery,
					why: `${preset.source}; dialogue at ${preset.integratedLufs} LUFS, music ≥ ${DELIVERY_RELATIVE_LU.music} LU and ambience ≥ ${DELIVERY_RELATIVE_LU.ambience} LU under it`.slice(
						0,
						1000,
					),
				},
			},
			...plan.gains.map((g, i) => ({
				id: `gain:${String(i + 1).padStart(width, '0')}`,
				label: `${g.title} ${fmtDb(g.fromDb)} → ${fmtDb(g.gainDb)} dB`.slice(0, 200),
				group: 'gain',
				requires: ['delivery'],
				commands: [g.command],
				meta: {
					feature: SOUND_DESIGN_FEATURE,
					kind: 'gain',
					clipId: g.clipId,
					fromDb: g.fromDb,
					gainDb: g.gainDb,
					why: `${g.title}: ${g.reason} (against the ${preset.label} mix)`.slice(0, 1000),
				},
			})),
		],
		report: plan.report,
	};
	ctx.progress(0.9, { stage: 'Checking the proposal' });
	const created = await proposals.create(req.projectId, draft as unknown as Record<string, unknown>, who);
	if (ctx.signal.aborted) {
		await proposals.delete(req.projectId, created.proposal.id).catch(() => undefined);
		throw new JobError('CANCELLED', 'Cancelled', false);
	}
	ctx.progress(1, { stage: 'Proposal ready for review' });
	return {
		...result,
		applied: false,
		revision: created.revision,
		proposalId: created.proposal.id,
		report: plan.report,
	};
}
