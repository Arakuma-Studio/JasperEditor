// Style Check (spec 15 EA-013; docs/wp-notes/edit-automation.md "Style Check"): compares a sequence with a style
// recipe's targets — cuts per minute, kit coverage, punch-in rate and timing, Ken Burns share, dead air (spec 14's
// statistic, measured by the engine's cleanup analysis), subtitle cut alignment (spec 13's measure) and music level —
// and lists deviations with "look here" frames (the editor seeks the playhead to them). What is measured here is read
// from the document as it is (hand edits included), with the passes' own definitions:
//   - cuts: picture cuts and jump cuts of the cut map (spec 13 SH-001) on the picture tracks (the FX, ZOOM,
//     Reactions, Stingers and Subtitles tracks of the passes left out);
//   - a kit: an enabled adjustment clip on the frame before the cut or on the cut frame (a kit or its before / after pair);
//   - a punch-in: an A-roll clip whose Motion scale rises ≥ 15 % within 15 frames from a key after its first frame, or a
//     Transform adjustment clip on a ZOOM track; its start = that key;
//   - a Ken Burns move: scale keys on (about) the clip's first and last frame, changing by 5–60 %;
//   - music: the audio clips of tracks named "Music", their clip gain (median);
//   - subtitles: the text clips of the sequence's subtitle groups; a speech cut = a cut with a subtitle word starting
//     within 0.5 s after it; aligned = a subtitle starts on the cut frame; crossing = a subtitle running over a hard cut.
// Pure.

import { subtitleCutEvents } from '../captions/subtitles/cuts.ts';
import { type CutAwareOptions, DEFAULT_CUT_AWARE } from '../captions/subtitles/rules.ts';
import { clipsOnTrack, sequenceDuration } from '../derive/index.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { pictureCuts } from '../structure/cuts.ts';
import { flicksPerFrame } from '../time.ts';
import { aRollTrack, automationSequence, fpsValue, frameGeometry, timecodeOf } from './common.ts';
import type { RecipeTargets, StyleRecipe, StyleTargetId } from './recipes.ts';

/** Look-here frames listed per metric at most. */
export const STYLE_CHECK_LOOK_HERE = 50;

export type StyleCheckStatus = 'ok' | 'off' | 'unmeasured' | 'unchecked';

export type LookHere = { frame: number; timecode: string; note: string };

export type StyleCheckMetric = {
	id: StyleTargetId;
	/** English label (a model string). */
	label: string;
	unit: 'per-minute' | 'share' | 'fraction' | 'seconds-per-minute' | 'db';
	value: number | null;
	target: { value?: number; tolerance?: number; min?: number; max?: number } | null;
	status: StyleCheckStatus;
	/** What was measured / how it deviates (English; the editor builds its own sentence from the fields). */
	message: string;
	/** Counts behind the value (e.g. 180 of 214 cuts). */
	count?: number;
	of?: number;
	lookHere: LookHere[];
};

export type StyleCheckResult = {
	sequenceId: string;
	recipe: { id: string; name: string };
	durationSeconds: number;
	metrics: StyleCheckMetric[];
	counts: { ok: number; off: number; unmeasured: number; unchecked: number };
};

/** Dead air from the engine (spec 14 `CleanupStats.deadAirPerMinute` and its pause findings), or null: unmeasured. */
export type StyleCheckDeadAir = {
	perMinute: number | null;
	/** Pauses longer than the preset's gap, sequence frames (look here). */
	pauses: { start: number; end: number }[];
	/** Why it is unmeasured (no voice analysis…). */
	note?: string;
} | null;

export const STYLE_CHECK_LABELS: Record<StyleTargetId, string> = {
	cutsPerMinute: 'Cuts per minute',
	kitCoverage: 'Cuts with a kit',
	punchInsPerMinute: 'Punch-ins per minute',
	punchInStart: 'Punch-in start in the clip',
	kenBurnsShare: 'Clips with a Ken Burns move',
	deadAirPerMinute: 'Dead air',
	subtitleOnCut: 'Subtitles starting on the cut',
	musicGainDb: 'Music level',
};

/** Tracks other passes put their output on (never the picture whose cuts are counted). */
const PASS_TRACKS = /^(fx|zoom|reactions|stingers|subtitles)(?: \d+)?$/i;

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const median = (xs: number[]) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

type ScaleKey = { frame: number; value: number };

/** The clip's Motion scale keys in sequence frames (forward clips; reversed / remapped clips give none). */
function scaleKeys(seq: Sequence, c: Clip): ScaleKey[] {
	const tr = (c as { transform?: { scale?: { keyframes?: { time: number; value: unknown }[] } } }).transform;
	const keys = tr?.scale?.keyframes;
	if (!Array.isArray(keys) || keys.length < 2 || c.speed?.reverse) return [];
	const F = flicksPerFrame(seq.settings.frameRate) * (c.speed?.rate || 1);
	if (!(F > 0)) return [];
	return keys
		.filter((k) => typeof k.value === 'number' && Number.isFinite(k.value) && Number.isFinite(k.time))
		.map((k) => ({ frame: c.start + Math.round((k.time - c.sourceIn) / F), value: k.value as number }))
		.sort((a, b) => a.frame - b.frame);
}

export type MotionKind = { kind: 'punch-in'; start: number } | { kind: 'ken-burns' } | null;

/** Whether a clip's Motion is a punch-in or a Ken Burns move (see the file comment). */
export function motionKindOf(seq: Sequence, c: Clip): MotionKind {
	const keys = scaleKeys(seq, c);
	if (keys.length < 2) return null;
	const end = c.start + c.duration - 1;
	const first = keys[0]!;
	const last = keys[keys.length - 1]!;
	if (
		keys.length === 2 &&
		Math.abs(first.frame - c.start) <= 1 &&
		Math.abs(last.frame - end) <= 1 &&
		first.value > 0
	) {
		const r = last.value / first.value;
		if ((r >= 1.05 && r <= 1.6) || (r <= 1 / 1.05 && r >= 1 / 1.6)) return { kind: 'ken-burns' };
	}
	for (let i = 0; i + 1 < keys.length; i++) {
		const a = keys[i]!;
		const b = keys[i + 1]!;
		if (a.frame > c.start + 1 && a.value > 0 && b.value / a.value >= 1.15 && b.frame - a.frame <= 15)
			return { kind: 'punch-in', start: a.frame };
	}
	return null;
}

function look(seq: Sequence, frame: number, note: string): LookHere {
	return { frame, timecode: timecodeOf(seq, frame), note };
}

function targetMetric(
	id: StyleTargetId,
	unit: StyleCheckMetric['unit'],
	value: number | null,
	t: { value: number; tolerance: number } | undefined,
	extra: Partial<StyleCheckMetric> & { message: string },
): StyleCheckMetric {
	const status: StyleCheckStatus = !t
		? 'unchecked'
		: value === null
			? 'unmeasured'
			: Math.abs(value - t.value) <= t.tolerance + 1e-9
				? 'ok'
				: 'off';
	return {
		id,
		label: STYLE_CHECK_LABELS[id],
		unit,
		value: value === null ? null : round(value),
		target: t ? { value: t.value, tolerance: t.tolerance } : null,
		status,
		lookHere: [],
		...extra,
	};
}

/**
 * Style Check of a sequence against a recipe's targets (EA-013). `deadAir` comes from the engine's cleanup analysis
 * (null / absent: unmeasured). Throws `AutomationInputError` for an unknown sequence only.
 */
export function styleCheck(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	recipe: Pick<StyleRecipe, 'id' | 'name' | 'targets'>,
	opts: { deadAir?: StyleCheckDeadAir } = {},
): StyleCheckResult {
	const seq = automationSequence(doc, sequenceId);
	const geo = frameGeometry(seq);
	const fps = fpsValue(geo.fps);
	const total = sequenceDuration(seq);
	const minutes = total / fps / 60;
	const T: RecipeTargets = recipe.targets ?? {};
	const metrics: StyleCheckMetric[] = [];
	const perMin = (n: number) => (minutes > 0 ? n / minutes : null);

	// ---- cuts
	const pictureTracks = seq.videoTracks
		.filter((t) => !PASS_TRACKS.test((t.name ?? '').trim()))
		.map((t) => t.id);
	let cuts: number[] = [];
	try {
		cuts = pictureCuts(doc, seq.id, { includeOverlays: false, trackIds: pictureTracks })
			.filter((c) => c.kind === 'cut' || c.kind === 'jump')
			.map((c) => c.frame)
			.sort((a, b) => a - b);
	} catch {
		cuts = [];
	}
	{
		const v = pictureTracks.length ? perMin(cuts.length) : null;
		const m = targetMetric('cutsPerMinute', 'per-minute', v, T.cutsPerMinute, {
			message: `${cuts.length} cuts in ${round(minutes, 2)} min`,
			count: cuts.length,
		});
		if (m.status === 'off' && T.cutsPerMinute && v !== null) {
			const bounds = [0, ...cuts, total];
			const gaps = bounds.slice(1).map((b, i) => ({ start: bounds[i]!, len: b - bounds[i]! }));
			if (v < T.cutsPerMinute.value)
				m.lookHere = gaps
					.sort((a, b) => b.len - a.len)
					.slice(0, 5)
					.map((g) => look(seq, g.start, `${round(g.len / fps, 1)} s without a cut`));
			else
				m.lookHere = gaps
					.filter((g) => g.start > 0)
					.sort((a, b) => a.len - b.len)
					.slice(0, 5)
					.map((g) => look(seq, g.start, `a ${round(g.len / fps, 2)} s shot`));
		}
		metrics.push(m);
	}

	// ---- kit coverage
	{
		const adj = Object.values(seq.clips).filter((c) => c.kind === 'adjustment' && c.enabled !== false);
		// a kit covers the frame before the cut or the cut frame (one clip around it, or a before + after pair)
		const covered = (f: number) =>
			adj.some(
				(c) =>
					(c.start <= f - 1 && c.start + c.duration > f - 1) || (c.start <= f && c.start + c.duration > f),
			);
		const bare = cuts.filter((f) => !covered(f));
		const v = cuts.length ? (cuts.length - bare.length) / cuts.length : null;
		const m = targetMetric('kitCoverage', 'share', v, T.kitCoverage, {
			message: cuts.length ? `${cuts.length - bare.length} of ${cuts.length} cuts have a kit` : 'No cuts',
			count: cuts.length - bare.length,
			of: cuts.length,
		});
		if (m.status === 'off' && v !== null && T.kitCoverage && v < T.kitCoverage.value)
			m.lookHere = bare.slice(0, STYLE_CHECK_LOOK_HERE).map((f) => look(seq, f, 'a cut without a kit'));
		metrics.push(m);
	}

	// ---- punch-ins and Ken Burns on the A-roll
	const aroll = aRollTrack(seq);
	const arollClips = aroll
		? clipsOnTrack(seq, aroll.id).filter(
				(c) => (c.kind === 'video' || c.kind === 'nest-video' || c.kind === 'still') && c.enabled !== false,
			)
		: [];
	const punches: { clip: Clip; start: number }[] = [];
	const kb: Clip[] = [];
	for (const c of arollClips) {
		const k = motionKindOf(seq, c);
		if (k?.kind === 'punch-in') punches.push({ clip: c, start: k.start });
		else if (k?.kind === 'ken-burns') kb.push(c);
	}
	// Transform adjustment clips on a ZOOM track (punch-ins of method `adjustment`)
	for (const t of seq.videoTracks.filter((x) => /^zoom(?: \d+)?$/i.test((x.name ?? '').trim())))
		for (const a of clipsOnTrack(seq, t.id)) {
			if (a.kind !== 'adjustment' || a.enabled === false) continue;
			const under = arollClips.find((c) => c.start <= a.start && c.start + c.duration > a.start);
			if (under && !punches.some((p) => p.clip.id === under.id))
				punches.push({ clip: under, start: a.start });
		}
	punches.sort((a, b) => a.start - b.start);
	const undecorated = () =>
		arollClips
			.filter((c) => !punches.some((p) => p.clip.id === c.id) && !kb.some((k) => k.id === c.id))
			.filter((c) => c.duration >= 1.5 * fps)
			.sort((a, b) => b.duration - a.duration);
	{
		const v = aroll ? perMin(punches.length) : null;
		const m = targetMetric('punchInsPerMinute', 'per-minute', v, T.punchInsPerMinute, {
			message: `${punches.length} punch-ins on ${arollClips.length} A-roll clips`,
			count: punches.length,
			of: arollClips.length,
		});
		if (m.status === 'off' && v !== null && T.punchInsPerMinute)
			m.lookHere =
				v < T.punchInsPerMinute.value
					? undecorated()
							.slice(0, 10)
							.map((c) => look(seq, c.start, `a ${round(c.duration / fps, 1)} s clip without a zoom`))
					: punches.slice(0, STYLE_CHECK_LOOK_HERE).map((p) => look(seq, p.start, 'a punch-in'));
		metrics.push(m);
	}
	{
		const fr = punches.map((p) => (p.start - p.clip.start) / Math.max(1, p.clip.duration));
		const v = median(fr);
		const t = T.punchInStart;
		const m = targetMetric('punchInStart', 'fraction', v, t, {
			message: punches.length ? `median start at ${round((v ?? 0) * 100, 0)} % of the clip` : 'No punch-ins',
			count: punches.length,
		});
		if (t)
			m.lookHere = punches
				.filter((_p, i) => Math.abs(fr[i]! - t.value) > t.tolerance)
				.slice(0, STYLE_CHECK_LOOK_HERE)
				.map((p) =>
					look(
						seq,
						p.start,
						`starts at ${Math.round(((p.start - p.clip.start) / Math.max(1, p.clip.duration)) * 100)} % of its clip`,
					),
				);
		metrics.push(m);
	}
	{
		const v = arollClips.length ? kb.length / arollClips.length : null;
		const m = targetMetric('kenBurnsShare', 'share', v, T.kenBurnsShare, {
			message: `${kb.length} of ${arollClips.length} A-roll clips have a Ken Burns move`,
			count: kb.length,
			of: arollClips.length,
		});
		if (m.status === 'off' && v !== null && T.kenBurnsShare)
			m.lookHere =
				v < T.kenBurnsShare.value
					? undecorated()
							.slice(0, 10)
							.map((c) => look(seq, c.start, `a ${round(c.duration / fps, 1)} s clip without a move`))
					: kb.slice(0, STYLE_CHECK_LOOK_HERE).map((c) => look(seq, c.start, 'a Ken Burns move'));
		metrics.push(m);
	}

	// ---- dead air (engine)
	{
		const t = T.deadAirPerMinute;
		const d = opts.deadAir ?? null;
		const v = d?.perMinute ?? null;
		const status: StyleCheckStatus = !t
			? 'unchecked'
			: v === null
				? 'unmeasured'
				: v <= t.max + 1e-9
					? 'ok'
					: 'off';
		metrics.push({
			id: 'deadAirPerMinute',
			label: STYLE_CHECK_LABELS.deadAirPerMinute,
			unit: 'seconds-per-minute',
			value: v === null ? null : round(v),
			target: t ? { max: t.max } : null,
			status,
			message:
				v === null
					? (d?.note ??
						'Not measured: the voice analysis of the dialogue is needed (Sequence ▸ Clean Up Voice… analyses it)')
					: `${round(v, 2)} s of non-speech per minute`,
			...(d ? { count: d.pauses.length } : {}),
			lookHere:
				status === 'off' && d
					? [...d.pauses]
							.sort((a, b) => b.end - b.start - (a.end - a.start))
							.slice(0, STYLE_CHECK_LOOK_HERE)
							.sort((a, b) => a.start - b.start)
							.map((p) => look(seq, p.start, `${round((p.end - p.start) / fps, 2)} s pause`))
					: [],
		});
	}

	// ---- subtitles
	metrics.push(subtitleMetric(doc, seq, T.subtitleOnCut, fps));

	// ---- music
	{
		const tracks = seq.audioTracks.filter((t) => /^music(?: \d+)?$/i.test((t.name ?? '').trim()));
		const clips = tracks
			.flatMap((t) => clipsOnTrack(seq, t.id))
			.filter((c) => c.kind === 'audio' && c.enabled !== false);
		const gains = clips
			.map((c) => (c as { gainDb?: number }).gainDb)
			.filter((g): g is number => typeof g === 'number' && Number.isFinite(g));
		// the shorts' intro step (a first part until the first cut) is not the bed's level
		const firstCut = cuts[0] ?? Number.POSITIVE_INFINITY;
		const body = clips.filter(
			(c) => !(c.start === 0 && c.start + c.duration <= firstCut && clips.length > 1),
		);
		const bodyGains = body
			.map((c) => (c as { gainDb?: number }).gainDb)
			.filter((g): g is number => typeof g === 'number' && Number.isFinite(g));
		const v = median(bodyGains.length ? bodyGains : gains);
		const t = T.musicGainDb;
		const m = targetMetric('musicGainDb', 'db', v, t, {
			message: clips.length
				? `${clips.length} music clips, median clip gain ${round(v ?? 0, 1)} dB`
				: 'No music bed (a track named “Music”)',
			count: clips.length,
		});
		if (t)
			m.lookHere = body
				.filter((c) => Math.abs(((c as { gainDb?: number }).gainDb ?? 0) - t.value) > t.tolerance)
				.slice(0, STYLE_CHECK_LOOK_HERE)
				.map((c) => look(seq, c.start, `music at ${round((c as { gainDb?: number }).gainDb ?? 0, 1)} dB`));
		metrics.push(m);
	}
	const counts = { ok: 0, off: 0, unmeasured: 0, unchecked: 0 };
	for (const m of metrics) counts[m.status]++;
	return {
		sequenceId: seq.id,
		recipe: { id: recipe.id, name: recipe.name },
		durationSeconds: round(total / fps, 3),
		metrics,
		counts,
	};
}

/** Spec 13's measure on the sequence's subtitle groups (text clips with `caption`). */
function subtitleMetric(
	doc: ProjectDocument,
	seq: Sequence,
	t: RecipeTargets['subtitleOnCut'],
	fps: number,
): StyleCheckMetric {
	const base = {
		id: 'subtitleOnCut' as const,
		label: STYLE_CHECK_LABELS.subtitleOnCut,
		unit: 'share' as const,
		target: t ? { min: t.min, max: t.maxCrossing } : null,
	};
	const groups = (seq as { captionGroups?: Record<string, { trackId?: string; cutAware?: unknown }> })
		.captionGroups;
	const subs = Object.values(seq.clips).filter((c) => {
		const cap = (c as { caption?: { groupId?: unknown } }).caption;
		return c.kind === 'text' && c.enabled !== false && cap && typeof cap.groupId === 'string';
	});
	if (!subs.length || !groups || !Object.keys(groups).length)
		return {
			...base,
			value: null,
			status: t ? 'unmeasured' : 'unchecked',
			message: 'No subtitles (Sequence ▸ Captions ▸ Create Subtitles…)',
			lookHere: [],
		};
	const F = flicksPerFrame(seq.settings.frameRate);
	const words: number[] = [];
	for (const c of subs) {
		const ws = ((c as { caption?: { words?: { start: number }[] } }).caption?.words ?? []) as {
			start: number;
		}[];
		for (const w of ws)
			if (Number.isFinite(w.start)) words.push(c.start + Math.floor((w.start - c.sourceIn) / F));
	}
	words.sort((a, b) => a - b);
	const trackId = subs[0]!.trackId;
	let events: { frame: number; zone?: { start: number; end: number } }[] = [];
	try {
		events = subtitleCutEvents(doc, seq, trackId, DEFAULT_CUT_AWARE as CutAwareOptions).events;
	} catch {
		events = [];
	}
	const starts = new Set(subs.map((c) => c.start));
	const half = Math.round(0.5 * fps);
	const speech = events.filter((e) => words.some((w) => w >= e.frame && w < e.frame + half));
	const off = speech.filter((e) => !starts.has(e.frame));
	const crossing = events.filter(
		(e) => !e.zone && subs.some((c) => c.start < e.frame && c.start + c.duration > e.frame),
	);
	const v = speech.length ? (speech.length - off.length) / speech.length : null;
	const status: StyleCheckStatus = !t
		? 'unchecked'
		: v === null
			? 'unmeasured'
			: v + 1e-9 >= t.min && crossing.length <= t.maxCrossing
				? 'ok'
				: 'off';
	return {
		...base,
		value: v === null ? null : round(v),
		status,
		message:
			v === null
				? 'No speech cut under the subtitles'
				: `${speech.length - off.length} of ${speech.length} speech cuts start a subtitle; ${crossing.length} subtitles cross a cut`,
		count: speech.length - off.length,
		of: speech.length,
		lookHere: [
			...crossing.map((e) => ({ frame: e.frame, note: 'a subtitle runs across this cut' })),
			...off.map((e) => ({ frame: e.frame, note: 'speech starts after this cut but no subtitle does' })),
		]
			.sort((a, b) => a.frame - b.frame)
			.slice(0, STYLE_CHECK_LOOK_HERE)
			.map((x) => look(seq, x.frame, x.note)),
	};
}
