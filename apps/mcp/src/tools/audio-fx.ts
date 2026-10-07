// Audio effects, Essential Sound and Music Remix tools (audio-fx; docs/wp-notes/audio-fx.md): the audio effect
// catalogue, clip / track effect stacks with static or keyframed parameters, Essential Sound types, settings,
// presets, Loudness Auto-Match and Ducking, and remixing music to a duration.
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
	essentialKeys,
	evaluate,
	listStrips,
	type MediaAsset,
	type ParamSpec,
	type ProjectDocument,
	readEssentialSound,
	remixSourceRange,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	frameOf,
	loadDoc,
	READ_ONLY,
	type ToolContext,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { analyze, apply } from './audio.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const AUDIO_FX_GUIDE = `Audio effects (Premiere's Audio Effects folders: Amplitude and Compression, Delay and Echo, Filter and EQ, Modulation, Noise Reduction/Restoration, Reverb, Special, Stereo Imagery, Time and Pitch): list_audio_effects gives every effect id ("jasper.audio.…") with its parameters (units dB, Hz, ms, Q, ratio, %, st, cents, LUFS; every number keyframable). add_audio_effect puts one on an audio clip, an audio track ("A1"…, a submix "S1"…) or the Mix ("Mix"); set_audio_effect changes parameters (a value, or {"keyframes": [{at, value}…]} for automation), enables/bypasses or reorders it; remove_audio_effect deletes it; get_audio_effects lists the stacks with values at a time. The same DSP runs in the preview (AudioWorklet) and every export. Order: clip effects → clip gain / Volume / fades → pan → track effects → fader.
Essential Sound: set_essential_sound gives clips an audio type (dialogue | music | sfx | ambience), applies a preset (get_essential_sound lists them) and/or sets options by dotted key (e.g. {"repair.noise.on": true, "repair.noise.amount": 6, "clarity.eqPreset": "Balanced Voice", "creative.reverb.on": true}); the options become ordinary keyframable clip effects you can also edit with set_audio_effect. clear_essential_sound removes the type and every change it made. auto_match_loudness measures each clip (BS.1770, its own signal) and sets its gain to −23 LUFS (or targetLufs). generate_essential_ducking ducks Music / Ambience clips under the clips of their "Duck against" types (ducking.* options) with Volume keyframes.
Music Remix: remix_audio clips a music clip to a target duration by beat tracking and re-cutting on beats (grouped pieces joined by short crossfades, one undo step); revert_remix restores the original.`;

const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');
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
	if (!c || c.kind !== 'audio')
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
			const body = await apply(ctx, a.projectId, `Add ${spec.label}`, commands, extra as never, seq.id);
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
			return jsonResult(
				await apply(ctx, a.projectId, `Edit ${spec.label}`, commands, extra as never, seq.id),
			);
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
					extra as never,
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
				return { clipId: id, settings: readEssentialSound(c.essential) };
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
				'Essential Sound on audio clips, in order: audioType (dialogue | music | sfx | ambience; a new type starts from its defaults), preset (a built-in preset name of that type, get_essential_sound), values (options by dotted key, e.g. {"repair.noise.on": true, "repair.noise.amount": 6}; keyframed effect parameters get a key at `at`). One undo step.',
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
			return jsonResult(await apply(ctx, a.projectId, 'Essential Sound', commands, extra as never, seq.id));
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
					extra as never,
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
				"Essential Sound ▸ Loudness ▸ Auto-Match: measures each clip's integrated loudness (ITU-R BS.1770 on the engine, its effects without its gain / Volume / fades / pan) and sets the match gain to targetLufs (default −23 LUFS). Clips without an audio type become Dialogue. Silent clips are left as they are.",
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
				extra as never,
				seq.id,
			);
			return jsonResult({
				...body,
				measuredLufs: measured,
				note: `Each clip's total gain now brings it to ${a.targetLufs ?? `its target (default ${DEFAULT_LOUDNESS_TARGET})`} LUFS; silent clips (null) are unchanged.`,
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
				extra as never,
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
				'Music Remix (Essential Sound ▸ Duration ▸ Remix, the Remix tool): beat-tracks the music clip on the engine and re-cuts it on beats to targetDuration (frames, {"seconds": x} or timecode; the result lands within about a beat). The clip becomes grouped pieces joined by short constant-power crossfades (one undo step). segments (0…100, default 50) favours longer or shorter pieces, variations (0…100, default 50) how freely sections are reordered. A remixed clip is remixed again from its original.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipId: z.string().min(1),
				targetDuration: z.unknown().describe('Target length: frames, {"seconds": x} or "HH:MM:SS:FF"'),
				segments: z.number().min(0).max(100).optional(),
				variations: z.number().min(0).max(100).optional(),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			const clip = audioClip(seq, a.clipId);
			const rate = seq.settings.frameRate;
			const frames = frameOf(seq, a.targetDuration);
			if (frames < 1)
				throw new ToolError('E_INVALID_PARAM', 'targetDuration must be positive', 'e.g. {"seconds": 30}.');
			const { startSec, durSec } = remixSourceRange(clip, rate);
			const plan = await ctx
				.engine((c) =>
					c.remixPlan({
						mediaKey: mediaKeyOf(doc, clip.mediaId),
						streamIndex: clip.channels.streamIndex,
						startSeconds: startSec,
						durationSeconds: durSec,
						targetSeconds: (frames * rate.den) / rate.num,
						...(a.segments !== undefined ? { segments: a.segments } : {}),
						...(a.variations !== undefined ? { variations: a.variations } : {}),
					}),
				)
				.catch((e: unknown) => {
					const err = e as { code?: string; message?: string };
					throw new ToolError(
						err.code ?? 'E_REMIX_FAILED',
						err.message ?? String(e),
						'Remix needs music with a steady beat at least a few bars long.',
					);
				});
			const targetFrames = Math.max(1, Math.round((plan.lengthSeconds * rate.num) / rate.den));
			const body = await apply(
				ctx,
				a.projectId,
				'Remix',
				[
					{
						type: 'clip.remix',
						clipId: a.clipId,
						targetFrames,
						pieces: plan.pieces,
						bpm: plan.bpm,
						...(a.segments !== undefined ? { segments: a.segments } : {}),
						...(a.variations !== undefined ? { variations: a.variations } : {}),
					},
				],
				extra as never,
				seq.id,
			);
			return jsonResult({
				...body,
				bpm: plan.bpm,
				pieces: plan.pieces.length,
				lengthFrames: targetFrames,
				lengthSeconds: plan.lengthSeconds,
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
					extra as never,
					seq.id,
				),
			);
		},
	);
}
