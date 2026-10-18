import {
	type AudioClassifyResult,
	type BeatsResult,
	MAX_REMIX_SOURCE_SECONDS,
	type RemixPlanRequest,
	type RemixPlanResult,
	TimeSignatureSchema,
} from '@jasper/api';
import {
	AUDIO_EFFECTS,
	AUDIO_TYPES,
	type AudioClip,
	audioEffectSpec,
	builtinEssentialPresets,
	clipContentTimeAtFrame,
	DEFAULT_LOUDNESS_TARGET,
	duckTriggerClips,
	type EffectInstance,
	type EffectSpec,
	endOnBarPlan,
	essentialKeys,
	evaluate,
	FLICKS_PER_SECOND,
	frameAtContent,
	listStrips,
	type MediaAsset,
	type ParamSpec,
	type ProjectDocument,
	type Rational,
	readEssentialSound,
	readRemixAnchors,
	remixCommandOf,
	remixPiecesOf,
	remixSourceRange,
	remixStartFrame,
	type Sequence,
	sequenceTimecode,
	soundCuesOf,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	type Extra,
	frameOf,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { analyze, apply } from './audio.ts';

export const AUDIO_FX_GUIDE = `Audio effects (Premiere's Audio Effects folders: Amplitude and Compression, Delay and Echo, Filter and EQ, Modulation, Noise Reduction/Restoration, Reverb, Special, Stereo Imagery, Time and Pitch): list_audio_effects gives every effect id ("jasper.audio.…") with its parameters (units dB, Hz, ms, Q, ratio, %, st, cents, LUFS; every number keyframable). add_audio_effect puts one on an audio clip, an audio track ("A1"…, a submix "S1"…) or the Mix ("Mix"); set_audio_effect changes parameters (a value, or {"keyframes": [{at, value}…]} for automation), enables/bypasses or reorders it; remove_audio_effect deletes it; get_audio_effects lists the stacks with values at a time. The same DSP runs in the preview (AudioWorklet) and every export. Order: clip effects → clip gain / Volume / fades → pan → track effects → fader.
Essential Sound: set_essential_sound gives clips an audio type (dialogue | music | sfx | ambience), applies a preset (get_essential_sound lists them) and/or sets options by dotted key (e.g. {"repair.noise.on": true, "repair.noise.amount": 6, "clarity.eqPreset": "Balanced Voice", "creative.reverb.on": true}); the options become ordinary keyframable clip effects you can also edit with set_audio_effect; Clip Volume and the SFX Pan are offsets on the clip's own Volume and pan (switched off, the clip's levels come back; projects saved when Pan was written into the pan open with the Pan section off, value kept, so their pan stays as saved). clear_essential_sound removes the type and every change it made. auto_tag_audio classifies clips as dialogue / music / sfx / ambience by listening to them (Premiere's Auto Tag) and tags them in one undoable step, marked "auto" until the user confirms (set_essential_sound with the same type confirms; another type changes it); it never replaces a type the user set unless force, returns each tag's confidence and why, and you should report low-confidence tags (< 60 %) to the user. The editor's Preferences ▸ Audio ▸ "Auto-tag audio types in the timeline" (off by default) tags only what the user adds by hand: clips you place are yours to tag with auto_tag_audio. To select every clip of a type in the open editor, run ui_command audio.selectAudioType {type}. auto_match_loudness measures each clip (BS.1770, its own signal) and sets its gain to −23 LUFS (or targetLufs); silent clips and clips shorter than 400 ms are skipped with the reason. generate_essential_ducking ducks Music / Ambience clips under the clips of their "Duck against" types (ducking.* options) with Volume keyframes.
Music Remix: remix_audio clips a music clip to a target duration by beat tracking and re-cutting on beats (grouped pieces joined by short crossfades that end just before a beat's attack, one undo step; at most 30 min of music is analysed); revert_remix restores the original.
Music to picture (you cannot hear the music: these tools measure it): find_music_drops {clipId} lists the music's drop candidates (bar, score, where each plays now), its key (C major, confidence), tempo and bar lines. Land the drop on the picture with remix_audio {landDropAt: frame | {cueId} | "hero", dropSec?} (or fit_music_to_picture {mode: "land-drop"}): the music is re-cut at bar lines so the drop (the top candidate, or dropSec in media seconds) plays exactly on that frame (within 1 ms), the outro still ending the clip (its length moves by at most half a bar unless you give targetDuration; an exact target no plan reaches is refused with the nearest lengths that work); a later remix of the clip keeps the drop where it landed. fit_music_to_picture {mode: "end-on-bar"} ends the music on a bar line (just before a downbeat, faded over a beat) instead of mid-bar. plan_sound_design tunes chimes and pitched sounds to the music's key and puts stop-befores on the bar line by default (style tuneToMusic / stopOnBar).`;

const ClipIdsArg = z.array(z.string().min(1)).min(1).describe('Audio clip ids (get_timeline)');
const ScalarValue = z.union([z.number(), z.boolean(), z.string()]);
const ParamValueArg = z.union([
	ScalarValue,
	z.strictObject({
		keyframes: z
			.array(
				z.strictObject({
					at: z.unknown().describe('Sequence time: frames, {"seconds": x} or "HH:MM:SS:FF"'),
					value: ScalarValue,
				}),
			)
			.min(1)
			.max(512),
	}),
]);
const ParamsArg = z
	.record(z.string(), ParamValueArg)
	.optional()
	.describe('Parameter name → value, or {"keyframes": [{at, value}…]} (list_audio_effects gives the names)');

function paramJson(p: ParamSpec) {
	return {
		name: p.name,
		label: p.label,
		type: p.type,
		default: p.default,
		...(p.range ? { min: p.range.min, max: p.range.max } : {}),
		...(p.unit ? { unit: p.unit } : {}),
		...(p.options ? { options: p.options } : {}),
		keyframable: p.animatable,
	};
}

function specOrThrow(effectId: string): EffectSpec {
	const spec = audioEffectSpec(effectId);
	if (!spec)
		throw new ToolError(
			'E_NOT_FOUND',
			`No audio effect "${effectId}"`,
			'list_audio_effects lists the ids ("jasper.audio.…").',
		);
	return spec;
}

type Located = {
	fx: EffectInstance;
	owner: { clip: AudioClip } | { strip: string };
};

function findEffect(seq: Sequence, instanceId: string): Located {
	for (const c of Object.values(seq.clips)) {
		if (c.kind !== 'audio') continue;
		const fx = c.effects.find((e) => e.id === instanceId);
		if (fx) return { fx, owner: { clip: c } };
	}
	for (const s of listStrips(seq)) {
		const fx = s.effects.find((e) => e.id === instanceId);
		if (fx) return { fx, owner: { strip: s.label } };
	}
	throw new ToolError(
		'E_NOT_FOUND',
		`No audio effect instance ${instanceId} in this sequence`,
		'get_audio_effects lists the instances of a clip or track.',
	);
}

function audioClip(seq: Sequence, id: string): AudioClip {
	const c = seq.clips[id];
	if (c?.kind !== 'audio')
		throw new ToolError(
			'E_NOT_FOUND',
			`${id} is not an audio clip of this sequence`,
			'get_timeline lists the clips; audio clips sit on A1, A2…',
		);
	return c;
}

/** param.set / param.setAnimated commands for one effect instance (validated against the spec). */
function paramCommands(
	seq: Sequence,
	spec: EffectSpec,
	fxRef: string,
	params: Record<string, z.infer<typeof ParamValueArg>>,
	current?: EffectInstance,
): unknown[] {
	const out: unknown[] = [];
	for (const [name, v] of Object.entries(params)) {
		const p = spec.params.find((x) => x.name === name);
		if (!p)
			throw new ToolError(
				'E_INVALID_PARAM',
				`${spec.label} has no parameter "${name}"`,
				`Parameters: ${spec.params.map((x) => x.name).join(', ')}`,
			);
		const target = ['effect', fxRef, name];
		const animated = (current?.params[name]?.keyframes.length ?? 0) > 0;
		if (typeof v === 'object') {
			if (!p.animatable)
				throw new ToolError('E_INVALID_PARAM', `${p.label} is not keyframable`, 'Give a single value.');
			const keys = v.keyframes.map((k) => ({ frame: frameOf(seq, k.at), value: k.value }));
			if (animated) out.push({ type: 'param.setAnimated', target, animated: false });
			out.push({ type: 'param.set', target, value: keys[0]!.value });
			out.push({
				type: 'param.setAnimated',
				target,
				animated: true,
				at: { sequenceFrame: keys[0]!.frame },
			});
			for (const k of keys.slice(1))
				out.push({ type: 'param.set', target, value: k.value, at: { sequenceFrame: k.frame } });
		} else {
			if (animated) out.push({ type: 'param.setAnimated', target, animated: false });
			out.push({ type: 'param.set', target, value: v });
		}
	}
	return out;
}

function valuesAt(fx: EffectInstance, spec: EffectSpec | undefined, t: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [name, a] of Object.entries(fx.params)) {
		out[name] = evaluate(a, t);
		if (a.keyframes.length) out[`${name}.keyframes`] = a.keyframes.length;
	}
	for (const p of spec?.params ?? []) if (!(p.name in out)) out[p.name] = p.default;
	return out;
}

function stackJson(fxs: readonly EffectInstance[], t: number) {
	return fxs
		.filter((e) => audioEffectSpec(e.effectId) || e.effectId.startsWith('jasper.audio.'))
		.map((e, i) => {
			const spec = audioEffectSpec(e.effectId);
			return {
				index: i,
				id: e.id,
				effectId: e.effectId,
				label: spec?.label ?? e.effectId,
				enabled: e.enabled,
				...(e.essential ? { essentialSound: e.essential } : {}),
				values: valuesAt(e, spec, t),
			};
		});
}

function mediaKeyOf(doc: ProjectDocument, mediaId: string): string {
	const asset = doc.media[mediaId] as MediaAsset | undefined;
	const loc = asset?.locators.find((l) => l.type === 'engine-store') as { key: string } | undefined;
	if (!loc)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Media ${mediaId} is not stored by the engine`,
			'Re-import it with import_media.',
		);
	return loc.key;
}

/** The length of a music clip as a remix sees it: a remix's target, else the clip's duration (frames). */
function remixLengthOf(clip: AudioClip): number {
	return clip.remix ? clip.remix.targetFrames : clip.duration;
}

/** Frames free on the clip's track from the remix's start (the next other clip), or Infinity. */
function roomOf(seq: Sequence, clip: AudioClip): number {
	const start = remixStartFrame(clip);
	const own = new Set(remixPiecesOf(seq, clip).map((c) => c.id));
	let next = Number.POSITIVE_INFINITY;
	for (const c of Object.values(seq.clips))
		if (c.trackId === clip.trackId && !own.has(c.id) && c.start >= start) next = Math.min(next, c.start);
	return next - start;
}

/** The frame `landDropAt` names: a time (frames, {"seconds": x}, timecode), {cueId}, or "hero". */
function landingFrame(seq: Sequence, clip: AudioClip, at: unknown): { frame: number; what: string } {
	const start = remixStartFrame(clip);
	if (at === 'hero') {
		const end = start + remixLengthOf(clip);
		const heroes = soundCuesOf(seq)
			.filter((c) => c.weight === 'hero' && !c.muted && c.frame >= start && c.frame < end)
			.sort((a, b) => a.frame - b.frame);
		if (!heroes.length)
			throw new ToolError(
				'E_NOT_FOUND',
				'No hero cue plays under this music clip',
				'Give landDropAt a frame or {"cueId": …}; find_sound_cues / set_sound_cues make hero cues.',
			);
		return { frame: heroes[0]!.frame, what: `the hero cue ${heroes[0]!.id}` };
	}
	if (at && typeof at === 'object' && typeof (at as { cueId?: unknown }).cueId === 'string') {
		const id = (at as { cueId: string }).cueId;
		const cue = soundCuesOf(seq).find((c) => c.id === id);
		if (!cue)
			throw new ToolError(
				'E_NOT_FOUND',
				`No sound cue ${id} in this sequence`,
				'list_sound_cues lists them.',
			);
		return { frame: cue.frame, what: `cue ${id}` };
	}
	const frame = frameOf(
		seq,
		at,
		'landDropAt: frames, {"seconds": x}, "HH:MM:SS:FF", {"cueId": …} or "hero".',
	);
	return { frame, what: sequenceTimecode(seq, frame) };
}

/** Where a media second of a music clip (or its remix) plays now: the frame, or null when it is not heard. */
function frameOfMediaSec(seq: Sequence, clip: AudioClip, sec: number): number | null {
	const rate = seq.settings.frameRate as Rational;
	for (const p of remixPiecesOf(seq, clip)) {
		const f = frameAtContent(p, sec * FLICKS_PER_SECOND, rate);
		if (f >= p.start && f < p.start + p.duration) return Math.round(f);
	}
	return null;
}

function remixError(e: unknown): ToolError {
	const err = e as { code?: string; message?: string; detail?: { nearestTargetSeconds?: number[] } };
	const near = err.detail?.nearestTargetSeconds;
	return new ToolError(
		err.code ?? 'E_REMIX_FAILED',
		err.message ?? String(e),
		near?.length
			? `Plans that land it end at ${near.map((t) => `${t} s`).join(' or ')}: give one of them as targetDuration ({"seconds": x}), or leave targetDuration out.`
			: 'Remix needs music with a steady beat at least a few bars long; the drop must lie inside the clip and land inside it.',
	);
}

type LandArgs = {
	projectId: string;
	sequenceId?: string | undefined;
	clipId: string;
	landDropAt: unknown;
	dropSec?: number | undefined;
	targetDuration?: unknown;
	timeSignature?: number | 'auto' | undefined;
};

/** Land a music clip's drop on a frame (remix_audio {landDropAt}, fit_music_to_picture land-drop). */
async function landDrop(ctx: ToolContext, a: LandArgs, extra: Extra) {
	const { doc } = await loadDoc(ctx, a.projectId);
	const seq = pickSequence(doc, a.sequenceId);
	const clip = audioClip(seq, a.clipId);
	const rate = seq.settings.frameRate as Rational;
	const fps = rate.num / rate.den;
	const { startSec, durSec } = remixSourceRange(clip, rate);
	if (durSec > MAX_REMIX_SOURCE_SECONDS)
		throw new ToolError(
			'E_INVALID_PARAM',
			`The music clip is ${Math.round(durSec / 60)} min long; Remix analyses at most ${MAX_REMIX_SOURCE_SECONDS / 60} min`,
			'Trim the clip (trim_clip) or split it, then land the drop in a part.',
		);
	const at = landingFrame(seq, clip, a.landDropAt);
	const start = remixStartFrame(clip);
	if (at.frame < start)
		throw new ToolError(
			'E_INVALID_PARAM',
			`${at.what} (${sequenceTimecode(seq, at.frame)}) is before the music starts (${sequenceTimecode(seq, start)})`,
			'Move the music clip earlier first, or choose a later frame.',
		);
	const base: RemixPlanRequest = {
		mediaKey: mediaKeyOf(doc, clip.mediaId),
		...(clip.channels.streamIndex !== undefined ? { streamIndex: clip.channels.streamIndex } : {}),
		startSeconds: startSec,
		durationSeconds: durSec,
		targetSeconds: remixLengthOf(clip) / fps,
		...(a.timeSignature !== undefined ? { timeSignature: a.timeSignature } : {}),
	};
	let dropSource: number;
	let dropInfo: { bar: number; score: number } | null = null;
	if (a.dropSec !== undefined) {
		dropSource = a.dropSec - startSec;
		if (dropSource < 0 || dropSource >= durSec)
			throw new ToolError(
				'E_INVALID_PARAM',
				`dropSec ${a.dropSec} s is outside the clip's music (${startSec.toFixed(2)}–${(startSec + durSec).toFixed(2)} s)`,
				'find_music_drops lists the drops in media seconds.',
			);
	} else {
		const first = await ctx
			.engine((c) => c.remixPlan(base))
			.catch((e: unknown) => {
				throw remixError(e);
			});
		const top = first.drops?.[0];
		if (!top)
			throw new ToolError(
				'E_NOT_FOUND',
				'No drop found in this music (no bar lifts into a loud section)',
				'Pass dropSec (media seconds of the moment to land), e.g. a downbeat from find_music_drops.',
			);
		dropSource = top.sourceSeconds;
		dropInfo = { bar: top.bar, score: top.score };
	}
	const room = roomOf(seq, clip);
	const exact = a.targetDuration !== undefined;
	const targetFrames = exact ? frameOf(seq, a.targetDuration) : remixLengthOf(clip);
	if (targetFrames < 1)
		throw new ToolError('E_INVALID_PARAM', 'targetDuration must be positive', 'e.g. {"seconds": 30}.');
	const plan: RemixPlanResult = await ctx
		.engine((c) =>
			c.remixPlan({
				...base,
				targetSeconds: targetFrames / fps,
				anchors: [{ sourceSeconds: dropSource, outputSeconds: (at.frame - start) / fps }],
				fit: exact ? 'exact' : 'nearest',
				...(!exact && Number.isFinite(room) ? { maxTargetSeconds: room / fps } : {}),
			}),
		)
		.catch((e: unknown) => {
			throw remixError(e);
		});
	const cmd = remixCommandOf(clip, plan, rate);
	const body = await apply(ctx, a.projectId, 'Land the Drop', [cmd], extra, seq.id);
	const landed = plan.anchors?.[0];
	return jsonResult({
		...body,
		drop: {
			mediaSeconds: Math.round((startSec + dropSource) * 1e4) / 1e4,
			...(dropInfo ?? {}),
			landsAt: { frame: at.frame, timecode: sequenceTimecode(seq, at.frame), on: at.what },
			errorMs: landed?.errorMs ?? null,
		},
		bpm: plan.bpm,
		pieces: plan.pieces.length,
		lengthFrames: (cmd as { targetFrames: number }).targetFrames,
		lengthSeconds: plan.lengthSeconds,
		headTrimSeconds: plan.headTrimSeconds ?? 0,
		note:
			!exact && Math.abs((cmd as { targetFrames: number }).targetFrames - targetFrames) > 0
				? `The music is ${(((cmd as { targetFrames: number }).targetFrames - targetFrames) / fps).toFixed(2)} s ${(cmd as { targetFrames: number }).targetFrames > targetFrames ? 'longer' : 'shorter'}: its outro ends on its own bar line`
				: undefined,
	});
}

/** The engine's beat analysis of a music clip's content range (media seconds). */
async function beatsOf(
	ctx: ToolContext,
	doc: ProjectDocument,
	seq: Sequence,
	clip: AudioClip,
	ts?: number | 'auto',
) {
	const rate = seq.settings.frameRate as Rational;
	const { startSec, durSec } = remixSourceRange(clip, rate);
	return ctx
		.engine((c) =>
			c.audioBeats({
				mediaKey: mediaKeyOf(doc, clip.mediaId),
				...(clip.channels.streamIndex !== undefined ? { streamIndex: clip.channels.streamIndex } : {}),
				startSeconds: startSec,
				durationSeconds: Math.min(durSec, MAX_REMIX_SOURCE_SECONDS),
				...(ts !== undefined ? { timeSignature: ts } : {}),
			}),
		)
		.catch((e: unknown) => {
			const err = e as { code?: string; message?: string };
			throw new ToolError(err.code ?? 'E_ANALYSIS_FAILED', err.message ?? String(e), 'Is the media online?');
		}) as Promise<BeatsResult>;
}

export function registerAudioFxTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_audio_effects',
		{
			title: 'List audio effects',
			description:
				'The audio effect catalogue: id, name, Premiere folder, description and parameters (name, type, default, range, unit, options, keyframable). Filter by folder or a search word.',
			input: {
				folder: z.string().optional().describe('e.g. "Filter and EQ", "Amplitude and Compression"'),
				search: z.string().optional().describe('Matches id, name, description and keywords'),
				withParams: z.boolean().optional().describe('Include parameters (default true)'),
			},
			annotations: READ_ONLY,
		},
		async ({ folder, search, withParams }) => {
			const q = search?.toLowerCase();
			const list = AUDIO_EFFECTS.filter((e) => !folder || e.category.toLowerCase() === folder.toLowerCase())
				.filter(
					(e) =>
						!q ||
						[e.id, e.label, e.description ?? '', ...(e.keywords ?? [])].some((s) =>
							s.toLowerCase().includes(q),
						),
				)
				.map((e) => ({
					effectId: e.id,
					name: e.label,
					folder: e.category,
					description: e.description,
					...(withParams === false ? {} : { params: e.params.map(paramJson) }),
				}));
			return jsonResult({ count: list.length, effects: list });
		},
	);

	defineTool(
		ctx,
		'get_audio_effects',
		{
			title: 'Get audio effects',
			description:
				'The audio effect stack of a clip, a track ("A1"…, "S1"…) or the Mix, with each instance id, enabled state, Essential Sound slot and parameter values at a time (default: the clip start / 0; keyframed parameters also give their key count).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipId: z.string().optional(),
				track: z.string().optional().describe('"A1"…, "S1"…, "Mix" or a track id'),
				at: z.unknown().optional().describe('Sequence time to read values at'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, clipId, track, at }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const rate = seq.settings.frameRate;
			if (clipId) {
				const c = audioClip(seq, clipId);
				const frame = at !== undefined ? frameOf(seq, at) : c.start;
				const t = clipContentTimeAtFrame(c, frame, rate).time;
				return jsonResult({
					clipId,
					essentialSound: readEssentialSound(c.essential)?.type ?? null,
					effects: stackJson(c.effects, t),
				});
			}
			if (!track) throw new ToolError('E_INVALID_PARAM', 'Give clipId or track', 'e.g. {"track": "A1"}.');
			const strip = listStrips(seq).find(
				(s) =>
					s.label.toLowerCase() === track.toLowerCase() ||
					s.id === track ||
					s.name === track ||
					(/^(mix|master)$/i.test(track) && s.kind === 'master'),
			);
			if (!strip) throw new ToolError('E_NOT_FOUND', `No track "${track}"`, 'get_mixer lists the strips.');
			const F = (705_600_000 * rate.den) / rate.num;
			const t = at !== undefined ? frameOf(seq, at) * F : 0;
			return jsonResult({ track: strip.label, effects: stackJson(strip.effects, t) });
		},
	);

	defineTool(
		ctx,
		'add_audio_effect',
		{
			title: 'Add audio effect',
			description:
				'Adds an audio effect (list_audio_effects) to an audio clip, a track ("A1"…, "S1"…) or the Mix ("Mix"), with optional parameter values or keyframes and stack position (one undo step). Returns the new instance id.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				effectId: z.string().min(1).describe('"jasper.audio.…" (list_audio_effects)'),
				clipId: z.string().optional(),
				track: z.string().optional().describe('"A1"…, "S1"… or "Mix" (track effect)'),
				index: z.number().int().min(0).optional().describe('Stack position (default: last)'),
				params: ParamsArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const spec = specOrThrow(a.effectId);
			if (!a.clipId === !a.track)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give clipId or track (one of them)',
					'e.g. {"clipId": "clp_…"}.',
				);
			if (a.clipId) audioClip(seq, a.clipId);
			const target = a.clipId
				? { clipId: a.clipId }
				: /^(mix|master)$/i.test(a.track!)
					? 'master'
					: { trackId: a.track!, sequenceId: seq.id };
			const commands: unknown[] = [
				{
					type: 'effect.add',
					target,
					effectId: spec.id,
					sequenceId: seq.id,
					...(a.index !== undefined ? { index: a.index } : {}),
					ref: '$fx',
				},
				...paramCommands(seq, spec, '$fx', a.params ?? {}),
			];
			const body = await apply(ctx, a.projectId, `Add ${spec.label}`, commands, extra, seq.id);
			return jsonResult(body);
		},
	);

	defineTool(
		ctx,
		'set_audio_effect',
		{
			title: 'Set audio effect',
			description:
				'Changes an audio effect instance (get_audio_effects gives ids): parameter values (a value replaces any keyframes; {"keyframes": [{at, value}…]} replaces them with these keys), enabled (bypass when false) and stack position (index). One undo step.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				effectInstanceId: z.string().min(1),
				params: ParamsArg,
				enabled: z.boolean().optional(),
				index: z.number().int().min(0).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const { fx } = findEffect(seq, a.effectInstanceId);
			const spec = specOrThrow(fx.effectId);
			const commands: unknown[] = [
				...paramCommands(seq, spec, fx.id, a.params ?? {}, fx),
				...(a.enabled !== undefined
					? [{ type: 'effect.setEnabled', effectInstanceId: fx.id, enabled: a.enabled }]
					: []),
				...(a.index !== undefined
					? [{ type: 'effect.reorder', effectInstanceId: fx.id, index: a.index }]
					: []),
			];
			if (!commands.length)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to change', 'Pass params, enabled or index.');
			return jsonResult(await apply(ctx, a.projectId, `Edit ${spec.label}`, commands, extra, seq.id));
		},
	);

	defineTool(
		ctx,
		'remove_audio_effect',
		{
			title: 'Remove audio effect',
			description:
				'Removes audio effect instances (get_audio_effects gives ids). An Essential Sound effect comes back when its option is set again.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				effectInstanceIds: z.array(z.string().min(1)).min(1),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			for (const id of a.effectInstanceIds) findEffect(seq, id);
			return jsonResult(
				await apply(
					ctx,
					a.projectId,
					'Remove Audio Effect',
					a.effectInstanceIds.map((id) => ({ type: 'effect.remove', effectInstanceId: id })),
					extra,
					seq.id,
				),
			);
		},
	);

	defineTool(
		ctx,
		'get_essential_sound',
		{
			title: 'Get Essential Sound',
			description:
				"The Essential Sound settings of audio clips (type, preset and every option by dotted key) plus the option keys and built-in presets of an audio type (the first clip's type or audioType).",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: z.array(z.string().min(1)).optional(),
				audioType: z.enum(AUDIO_TYPES).optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, clipIds, audioType }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const clips = (clipIds ?? []).map((id) => {
				const c = audioClip(seq, id);
				// `residual` (what the fader ranges clamped away) and `panOffset` (how Pan is applied) are bookkeeping of
				// the commands, not settings.
				const s = readEssentialSound(c.essential);
				if (!s) return { clipId: id, settings: null };
				const { residual: _residual, panOffset: _panOffset, ...settings } = s;
				return { clipId: id, settings };
			});
			const type = audioType ?? clips.find((c) => c.settings)?.settings?.type ?? null;
			const presets = builtinEssentialPresets();
			return jsonResult({
				clips,
				...(type
					? {
							audioType: type,
							optionKeys: essentialKeys(presets.find((p) => p.type === type)!.settings),
							presets: presets.filter((p) => p.type === type).map((p) => p.name),
						}
					: { audioTypes: AUDIO_TYPES }),
			});
		},
	);

	defineTool(
		ctx,
		'set_essential_sound',
		{
			title: 'Set Essential Sound',
			description:
				'Essential Sound on audio clips, in order: audioType (dialogue | music | sfx | ambience; a new type starts from its defaults), preset (a built-in preset name of that type, get_essential_sound), values (options by dotted key, e.g. {"repair.noise.on": true, "repair.noise.amount": 6}; keyframed effect parameters get a key at `at`). Clip Volume (volume.on / volume.levelDb) and Pan (pan.enabled / pan.value, SFX) are offsets on the clip\'s own Volume and pan, every keyframe included (clamped to −∞…+15 dB and ±100; switching them off gives the clip\'s own levels back). One undo step.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: ClipIdsArg,
				audioType: z.enum(AUDIO_TYPES).optional(),
				preset: z.string().min(1).optional(),
				values: z.record(z.string(), z.unknown()).optional(),
				at: z.unknown().optional().describe('Sequence time for keys of keyframed parameters'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			for (const id of a.clipIds) audioClip(seq, id);
			const at = a.at !== undefined ? frameOf(seq, a.at) : undefined;
			const commands: unknown[] = [];
			if (a.audioType)
				commands.push({ type: 'essentialSound.setType', clipIds: a.clipIds, audioType: a.audioType });
			if (a.preset)
				commands.push({
					type: 'essentialSound.applyPreset',
					clipIds: a.clipIds,
					preset: a.preset,
					...(a.audioType ? { audioType: a.audioType } : {}),
					...(at !== undefined ? { at } : {}),
				});
			if (a.values && Object.keys(a.values).length)
				commands.push({
					type: 'essentialSound.set',
					clipIds: a.clipIds,
					values: a.values,
					...(at !== undefined ? { at } : {}),
				});
			if (!commands.length)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to change', 'Pass audioType, preset or values.');
			return jsonResult(await apply(ctx, a.projectId, 'Essential Sound', commands, extra, seq.id));
		},
	);

	defineTool(
		ctx,
		'clear_essential_sound',
		{
			title: 'Clear Essential Sound',
			description:
				'"Clear Audio Type": removes the Essential Sound settings of audio clips and every effect, gain, Volume and pan change they made.',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg, clipIds: ClipIdsArg },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			for (const id of a.clipIds) audioClip(seq, id);
			return jsonResult(
				await apply(
					ctx,
					a.projectId,
					'Clear Audio Type',
					[{ type: 'essentialSound.clearType', clipIds: a.clipIds }],
					extra,
					seq.id,
				),
			);
		},
	);

	defineTool(
		ctx,
		'auto_match_loudness',
		{
			title: 'Auto-Match loudness',
			description:
				"Essential Sound ▸ Loudness ▸ Auto-Match: measures each clip's integrated loudness (ITU-R BS.1770 on the engine, its effects without its gain / Volume / fades / pan) and sets the match gain to targetLufs (default −23 LUFS). Clips without an audio type become Dialogue. Silent clips and clips shorter than 400 ms (integrated loudness needs one BS.1770 gating block) are left as they are; results[].clips names the reason per clip.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: ClipIdsArg,
				targetLufs: z.number().min(-60).max(0).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const untyped = a.clipIds.filter((id) => !readEssentialSound(audioClip(seq, id).essential));
			const r = await analyze(ctx, a.projectId, {
				sequenceId: seq.id,
				scope: { type: 'clips', clipIds: a.clipIds },
				levels: 'source',
			});
			const measured: Record<string, number | null> = {};
			for (const id of a.clipIds) measured[id] = r.clips?.[id]?.integratedLufs ?? null;
			const body = await apply(
				ctx,
				a.projectId,
				'Auto-Match Loudness',
				[
					...(untyped.length
						? [{ type: 'essentialSound.setType', clipIds: untyped, audioType: 'dialogue' }]
						: []),
					{
						type: 'essentialSound.autoMatch',
						measuredLufs: measured,
						...(a.targetLufs !== undefined ? { targetLufs: a.targetLufs } : {}),
					},
				],
				extra,
				seq.id,
			);
			return jsonResult({
				...body,
				measuredLufs: measured,
				note: `Each clip's total gain now brings it to ${a.targetLufs ?? `its target (default ${DEFAULT_LOUDNESS_TARGET})`} LUFS; clips measured as null (silent, or shorter than 400 ms) are unchanged — see the per-clip reasons.`,
			});
		},
	);

	defineTool(
		ctx,
		'auto_tag_audio',
		{
			title: 'Auto Tag audio types',
			description:
				'Essential Sound ▸ Auto Tag (Premiere\'s "Auto Tag Audio Types"): listens to each audio clip (the media range it plays; long clips are sampled) and classifies it as dialogue, music, sfx or ambience from measured features (voice activity and syllabic modulation, pitch over time, onsets and their periodicity, sustained tones, stationarity, duration) — deterministic rules, not a trained model. mode "apply" (default) gives the clips that type in ONE undoable transaction, marked "auto" (the clip badge is dotted until the user confirms it in Essential Sound); "propose" only returns the results. A type the user set is never replaced unless force. clipIds default: every audio clip of the sequence without an audio type. Returns a table with each clip\'s tag, confidence and why. Report tags under 60 % confidence (low) to the user instead of trusting them; silent clips are left untyped.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: z
					.array(z.string().min(1))
					.min(1)
					.max(500)
					.optional()
					.describe('Audio clip ids (get_timeline); default every untyped audio clip'),
				mode: z
					.enum(['apply', 'propose'])
					.optional()
					.describe('apply (default): tag them; propose: only classify'),
				force: z.boolean().optional().describe('Also replace audio types the user set (default false)'),
				minConfidence: z
					.number()
					.min(0)
					.max(1)
					.optional()
					.describe('Leave clips under this confidence untyped (default 0: tag every result)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc, revision } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const ids =
				a.clipIds ??
				Object.values(seq.clips)
					.filter((c) => c.kind === 'audio' && !readEssentialSound((c as AudioClip).essential))
					.sort((x, y) => x.start - y.start)
					.map((c) => c.id)
					.slice(0, 500);
			if (ids.length === 0)
				return jsonResult({
					ok: true,
					tagged: [],
					note: 'Every audio clip already has an audio type (pass clipIds with force: true to re-tag clips the user typed).',
				});
			for (const id of ids) audioClip(seq, id);
			const job = await ctx.engine((c) =>
				c.classifyAudio(
					{ envelope: toolEnvelope(doc, revision), sequenceId: seq.id, clipIds: ids },
					{ wait: true },
				),
			);
			if (job.state !== 'succeeded')
				throw new ToolError(
					job.error?.code ?? 'E_ANALYSIS_FAILED',
					job.error?.message ?? `The job ${job.state}`,
					'Check engine_status; the media must be in the engine (import_media).',
				);
			const res = job.result as AudioClassifyResult;
			const pct = (x: number) => `${Math.round(x * 100)} %`;
			const rows = res.items.map((it) => ({
				clipId: it.clipId ?? '',
				name: it.name,
				before: it.currentType ?? null,
				category: it.result?.category ?? null,
				confidence: it.result ? Math.round(it.result.confidence * 1000) / 1000 : null,
				low: !!it.result && !it.result.silent && it.result.confidence < res.lowConfidence,
				why: it.error
					? `${it.error.code}: ${it.error.message}`
					: it.result?.silent
						? 'silent'
						: (it.result?.reasons ?? []).join('; '),
			}));
			const results = Object.fromEntries(
				res.items
					.filter((it) => it.clipId && it.result?.category && !it.result.silent)
					.map((it) => [
						it.clipId!,
						{
							category: it.result!.category!,
							confidence: it.result!.confidence,
							scores: it.result!.scores,
							reasons: it.result!.reasons.slice(0, 6),
						},
					]),
			);
			const table = [
				'clip | name | before | tag | confidence | why',
				...rows.map(
					(r) =>
						`${r.clipId} | ${r.name} | ${r.before ?? '—'} | ${r.category ?? '—'} | ${r.confidence === null ? '—' : `${pct(r.confidence)}${r.low ? ' (low)' : ''}`} | ${r.why}`,
				),
			].join('\n');
			const low = rows.filter((r) => r.low).map((r) => r.clipId);
			const base = { counts: res.counts, lowConfidence: res.lowConfidence, low, table, items: rows };
			if (a.mode === 'propose' || Object.keys(results).length === 0)
				return jsonResult({
					ok: true,
					mode: a.mode ?? 'apply',
					applied: false,
					...base,
					next: 'Apply with mode "apply" (or essentialSound.autoTag in apply_commands with these results).',
				});
			const body = await apply(
				ctx,
				a.projectId,
				'Auto Tag Audio Types',
				[
					{
						type: 'essentialSound.autoTag',
						results,
						...(a.force ? { force: true } : {}),
						...(a.minConfidence !== undefined ? { minConfidence: a.minConfidence } : {}),
					},
				],
				extra,
				seq.id,
			);
			return jsonResult({
				...body,
				mode: 'apply',
				applied: true,
				...base,
				next: low.length
					? `Tell the user ${low.length} tag(s) are low-confidence (${low.join(', ')}): they confirm or change them in Essential Sound (the dotted badge).`
					: 'Tags are marked auto until the user confirms them in Essential Sound (set_essential_sound with the same type confirms).',
			});
		},
	);

	defineTool(
		ctx,
		'generate_essential_ducking',
		{
			title: 'Generate Essential Sound ducking',
			description:
				'Essential Sound ▸ Ducking ▸ Generate Keyframes: Music / Ambience clips duck under the clips of their "Duck against" types (options ducking.against, ducking.againstUntyped, ducking.sensitivity, ducking.reduceDb, ducking.fadeSeconds; set them with set_essential_sound). Turns Ducking on and replaces the clips\' Volume keyframes in the ducked ranges. Use auto_duck for explicit triggers.',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg, clipIds: ClipIdsArg },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const targets = a.clipIds.map((id) => audioClip(seq, id));
			const s = readEssentialSound(targets[0]!.essential);
			if (!s || (s.type !== 'music' && s.type !== 'ambience'))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Ducking applies to Music or Ambience clips',
					'set_essential_sound {audioType: "music"} first.',
				);
			const triggers = duckTriggerClips(seq, a.clipIds, s);
			if (!triggers.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					`No clips of the "Duck against" types (${s.ducking.against.join(', ')}) in the sequence`,
					'Give the dialogue clips an audio type (set_essential_sound) or set ducking.againstUntyped.',
				);
			const start = Math.min(...targets.map((c) => c.start));
			const end = Math.max(...targets.map((c) => c.start + c.duration));
			const r = await analyze(ctx, a.projectId, {
				sequenceId: seq.id,
				scope: { type: 'clips', clipIds: triggers },
				activity: { sensitivity: s.ducking.sensitivity, startFrame: start, endFrame: end },
			});
			const regions = r.activity?.regions ?? [];
			const body = await apply(
				ctx,
				a.projectId,
				'Auto Duck',
				[
					...(s.ducking.enabled
						? []
						: [{ type: 'essentialSound.set', clipIds: a.clipIds, values: { 'ducking.enabled': true } }]),
					{
						type: 'audio.autoDuck',
						targetClipIds: a.clipIds,
						regions,
						amountDb: -s.ducking.reduceDb,
						fadeMs: s.ducking.fadeSeconds * 1000,
					},
				],
				extra,
				seq.id,
			);
			return jsonResult({ ...body, triggerClips: triggers.length, duckedRegions: regions.length });
		},
	);

	defineTool(
		ctx,
		'remix_audio',
		{
			title: 'Remix music to a duration',
			description:
				'Music Remix (Essential Sound ▸ Duration ▸ Remix, the Remix tool): beat-tracks the music clip on the engine and re-cuts it on beats to targetDuration (frames, {"seconds": x} or timecode; the result lands within about a beat). The clip becomes grouped pieces joined by short constant-power crossfades that end just before a beat\'s attack (one undo step). segments (0…100, default 50) favours longer or shorter pieces, variations (0…100, default 50) how freely sections are reordered. A remixed clip is remixed again from its original, keeping a drop it landed earlier where it is. landDropAt (a frame, {"seconds": x}, timecode, {"cueId": …} or "hero": the first hero cue under the music) lands the music\'s drop there within 1 ms instead (spec 12 P6-E11): joints only at bar lines, the outro still ending the clip — without targetDuration its length moves by at most half a bar (never over the next clip); with targetDuration an exact length no plan reaches is refused (E_INVALID_PARAM) naming the lengths that work. dropSec picks the moment to land (media seconds; default the top drop of find_music_drops). The music range analysed is limited to 30 minutes.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipId: z.string().min(1),
				targetDuration: z
					.unknown()
					.optional()
					.describe('Target length: frames, {"seconds": x} or "HH:MM:SS:FF" (required without landDropAt)'),
				segments: z.number().min(0).max(100).optional(),
				variations: z.number().min(0).max(100).optional(),
				landDropAt: z
					.unknown()
					.optional()
					.describe('Land the drop on: a frame, {"seconds": x}, "HH:MM:SS:FF", {"cueId": "cue_…"} or "hero"'),
				dropSec: z
					.number()
					.min(0)
					.max(864_000)
					.optional()
					.describe('The moment to land (media seconds; default the top drop candidate)'),
				timeSignature: TimeSignatureSchema.optional().describe(
					'Beats per bar (default "auto": 3 or 4 detected)',
				),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			if (a.landDropAt !== undefined)
				return landDrop(
					ctx,
					{
						projectId: a.projectId,
						sequenceId: a.sequenceId,
						clipId: a.clipId,
						landDropAt: a.landDropAt,
						dropSec: a.dropSec,
						targetDuration: a.targetDuration,
						timeSignature: a.timeSignature,
					},
					extra,
				);
			if (a.targetDuration === undefined)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give targetDuration (or landDropAt)',
					'e.g. {"targetDuration": {"seconds": 30}}.',
				);
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const clip = audioClip(seq, a.clipId);
			const rate = seq.settings.frameRate;
			const fps = rate.num / rate.den;
			const frames = frameOf(seq, a.targetDuration);
			if (frames < 1)
				throw new ToolError('E_INVALID_PARAM', 'targetDuration must be positive', 'e.g. {"seconds": 30}.');
			const { startSec, durSec } = remixSourceRange(clip, rate);
			if (durSec > MAX_REMIX_SOURCE_SECONDS)
				throw new ToolError(
					'E_INVALID_PARAM',
					`The music clip is ${Math.round(durSec / 60)} min long; Remix analyses at most ${MAX_REMIX_SOURCE_SECONDS / 60} min`,
					'Trim the clip (trim_clip) or split it, then remix a part.',
				);
			const base: RemixPlanRequest = {
				mediaKey: mediaKeyOf(doc, clip.mediaId),
				...(clip.channels.streamIndex !== undefined ? { streamIndex: clip.channels.streamIndex } : {}),
				startSeconds: startSec,
				durationSeconds: durSec,
				targetSeconds: frames / fps,
				...(a.segments !== undefined ? { segments: a.segments } : {}),
				...(a.variations !== undefined ? { variations: a.variations } : {}),
				...(a.timeSignature !== undefined ? { timeSignature: a.timeSignature } : {}),
			};
			// a drop the clip landed earlier lands again (P6-E11), when it still fits
			const start = remixStartFrame(clip);
			const kept = readRemixAnchors(clip.remix).filter((x) => x.frame - start < frames);
			let plan: RemixPlanResult | null = null;
			let keptNote: string | undefined;
			if (kept.length) {
				const room = roomOf(seq, clip);
				plan = await ctx
					.engine((c) =>
						c.remixPlan({
							...base,
							anchors: kept.map((x) => ({
								sourceSeconds: x.sourceSeconds,
								outputSeconds: (x.frame - start) / fps,
							})),
							fit: 'nearest',
							...(Number.isFinite(room) ? { maxTargetSeconds: room / fps } : {}),
						}),
					)
					.catch(() => null);
				keptNote = plan
					? `kept the landed drop at ${kept.map((x) => sequenceTimecode(seq, x.frame)).join(', ')}`
					: 'the landed drop no longer fits this length: remixed without it';
			}
			plan ??= await ctx
				.engine((c) => c.remixPlan(base))
				.catch((e: unknown) => {
					throw remixError(e);
				});
			const cmd = remixCommandOf(clip, plan, rate, {
				...(a.segments !== undefined ? { segments: a.segments } : {}),
				...(a.variations !== undefined ? { variations: a.variations } : {}),
			});
			const body = await apply(ctx, a.projectId, 'Remix', [cmd], extra, seq.id);
			return jsonResult({
				...body,
				bpm: plan.bpm,
				pieces: plan.pieces.length,
				lengthFrames: (cmd as { targetFrames: number }).targetFrames,
				lengthSeconds: plan.lengthSeconds,
				...(keptNote ? { note: keptNote } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'find_music_drops',
		{
			title: 'Find the drops of a music clip',
			description:
				'Listens to a music clip on the engine (cached) and returns its drop candidates — bars where the music lifts into a loud section (spec 12 P6-E11; adapted from earshot): bar number, score (lift / 3 + 2 × novelty), lift in dB, the media second of the drop\'s downbeat and the frame / timecode where it plays now (null when the clip does not play it) — best first; plus the music\'s key ("C major", confidence 0…1: ≥ 0.6 is clear), tempo, beats per bar and how many bar lines. Land one with remix_audio {landDropAt, dropSec} or fit_music_to_picture.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipId: z.string().min(1),
				timeSignature: TimeSignatureSchema.optional().describe(
					'Beats per bar (default "auto": 3 or 4 detected)',
				),
			},
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const clip = audioClip(seq, a.clipId);
			const b = await beatsOf(ctx, doc, seq, clip, a.timeSignature);
			const drops = b.drops.map((d) => {
				const f = frameOfMediaSec(seq, clip, d.sourceSeconds);
				return {
					bar: d.bar,
					score: d.score,
					liftDb: d.liftDb,
					mediaSeconds: d.sourceSeconds,
					playsAt: f === null ? null : { frame: f, timecode: sequenceTimecode(seq, f) },
				};
			});
			return jsonResult({
				clipId: clip.id,
				bpm: b.bpm,
				beatsPerBar: b.beatsPerBar,
				barLines: b.downbeats?.length ?? 0,
				barsGuessed: b.dropBarsGuessed,
				key: b.key
					? { name: b.key.name, tonic: b.key.tonic, mode: b.key.mode, confidence: b.key.confidence }
					: null,
				drops,
				...(b.reason ? { reason: b.reason } : {}),
				summary: drops.length
					? `${drops.length} drop candidate${drops.length === 1 ? '' : 's'}; the top one is bar ${drops[0]!.bar} (${drops[0]!.mediaSeconds} s${drops[0]!.playsAt ? `, now at ${drops[0]!.playsAt.timecode}` : ', not played by the clip'})${b.key ? `; key ${b.key.name} (${Math.round(b.key.confidence * 100)} %)` : ''}`
					: `No drop found${b.reason ? ` (${b.reason})` : ''}${b.key ? `; key ${b.key.name} (${Math.round(b.key.confidence * 100)} %)` : ''}`,
			});
		},
	);

	defineTool(
		ctx,
		'fit_music_to_picture',
		{
			title: 'Fit music to the picture',
			description:
				'Music to picture (spec 12 P6-E11), one undo step: mode "land-drop" lands the music clip\'s drop (the top candidate, or dropSec in media seconds) on `at` (a frame, {"seconds": x}, timecode, {"cueId": …} or "hero"; default "hero") within 1 ms — the same as remix_audio {landDropAt}; mode "end-on-bar" ends the music on a bar line: just before a downbeat\'s attack (within a frame), with a constant-power fade-out of fadeSeconds (default one beat) ending there; direction "earlier" (default: the last bar line inside the clip) or "nearest" (up to half a bar later when the media and the track have room). The bar lines come from the engine\'s beat analysis (refused when the music has no clear downbeat: give timeSignature).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipId: z.string().min(1),
				mode: z.enum(['land-drop', 'end-on-bar']),
				at: z.unknown().optional().describe('land-drop: where (default "hero")'),
				dropSec: z
					.number()
					.min(0)
					.max(864_000)
					.optional()
					.describe('land-drop: the moment to land (media seconds)'),
				targetDuration: z
					.unknown()
					.optional()
					.describe("land-drop: an exact length (default: the clip's, ± half a bar)"),
				fadeSeconds: z
					.number()
					.positive()
					.max(10)
					.optional()
					.describe('end-on-bar: fade-out length (default one beat)'),
				direction: z
					.enum(['earlier', 'nearest'])
					.optional()
					.describe('end-on-bar: which bar line (default earlier)'),
				timeSignature: TimeSignatureSchema.optional().describe(
					'Beats per bar (default "auto": 3 or 4 detected)',
				),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			if (a.mode === 'land-drop')
				return landDrop(
					ctx,
					{
						projectId: a.projectId,
						sequenceId: a.sequenceId,
						clipId: a.clipId,
						landDropAt: a.at ?? 'hero',
						dropSec: a.dropSec,
						targetDuration: a.targetDuration,
						timeSignature: a.timeSignature,
					},
					extra,
				);
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const clip = audioClip(seq, a.clipId);
			const b = await beatsOf(ctx, doc, seq, remixPiecesOf(seq, clip)[0]!, a.timeSignature);
			if (!b.downbeats?.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					b.reason === 'NO_BEAT'
						? 'The music has no steady beat'
						: 'The music has no clear bar lines (no beat per bar is accented)',
					'Give timeSignature (e.g. 4) so the beats are grouped into bars, or trim the clip by hand.',
				);
			const p = endOnBarPlan(doc, seq, clip.id, b.downbeats, {
				bpm: b.bpm,
				...(a.fadeSeconds !== undefined ? { fadeSeconds: a.fadeSeconds } : {}),
				...(a.direction ? { direction: a.direction } : {}),
			});
			if (!p.ok) throw new ToolError(p.code, p.message, 'find_music_drops shows the tempo and bar lines.');
			const body = await apply(ctx, a.projectId, 'End on Bar', p.commands, extra, seq.id);
			return jsonResult({
				...body,
				clipId: p.clipId,
				endsAt: { frame: p.endFrame, timecode: sequenceTimecode(seq, p.endFrame) },
				barLine: { mediaSeconds: p.barSeconds, frame: p.barFrame },
				fadeFrames: p.fadeFrames,
			});
		},
	);

	defineTool(
		ctx,
		'revert_remix',
		{
			title: 'Revert remix',
			description: 'Restores the original clip of a remix (pass any of its pieces).',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg, clipId: z.string().min(1) },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			if (!audioClip(seq, a.clipId).remix)
				throw new ToolError('E_INVALID_PARAM', `${a.clipId} is not a remix`, 'remix_audio makes one.');
			return jsonResult(
				await apply(
					ctx,
					a.projectId,
					'Revert Remix',
					[{ type: 'clip.remixRevert', clipId: a.clipId }],
					extra,
					seq.id,
				),
			);
		},
	);
}
