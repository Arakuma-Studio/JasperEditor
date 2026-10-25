import {
	type Clip,
	CONSTANT_POWER,
	CROSS_DISSOLVE,
	clipHandles,
	defaultTransitionFrames,
	linkedPartners,
	type ProjectDocument,
	type Sequence,
	sequenceTimecode,
	TimeInputSchema,
	TRANSITION_SPECS,
	type Transition,
	type TransitionSpec,
	trackLabel,
	transitionSpec,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT_IDEMPOTENT,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence, transitionPlacement } from '../format.ts';

export const TRANSITION_GUIDE = `Transitions:
- add_transition adds one at an edit point (track + at) or a fade at a clip edge (clipId + edge). apply_default_transitions puts the default transitions on every edge of the given clips in one step (the editor user's default types and alignment from Preferences ▸ Timeline when the editor is open, else cross-dissolve / constant-power, center; the project's default length per medium); pass media: ["video", "audio"] to include the linked audio.
- set_transition_defaults changes the project's default lengths (video and audio transitions, stills); the default types and alignment are the user's preferences in the editor and can only be overridden per call.
- list_transitions shows each transition's id, type, track, cut, span and the media handles of its clips; get_timeline lists them per track too. update_transition changes the length, alignment or type (within video or within audio); remove_transitions deletes them.
- A transition between two clips needs media beyond the cut ("handles"): center needs both, start-at-cut only the outgoing clip's tail handle, end-at-cut only the incoming clip's head handle. Durations are shortened to what fits (warning W_TRANSITION_SHORTENED); E_OUT_OF_MEDIA means nothing fits: try another alignment or trim the clips.
- Audio transitions follow Premiere: constant-gain (linear: amplitudes sum to 1, a dip at the middle), constant-power (quarter sine: powers sum to 1), exponential-fade (dB-linear over 60 dB) and custom-fade (Premiere's Custom Fade, what dragging a fade handle makes): fadeShape "linear" | "cosine" bent by fadeValue −100…100 (gain = base^(2^(−value/19)); Cosine at 19 is exactly constant power, Linear at 0 constant gain, positive values rise earlier), symmetry "symmetric" (the outgoing clip fades out on the mirror of the fade in) or "asymmetric" (outFadeShape / outFadeValue for the outgoing clip). Preview and every export play the same curves.
- Custom Start: cutOffset (add_transition / update_transition) puts the cut off-centre, as frames of the span before it (0…duration); it scales when the length is shortened; an alignment drops it. list_transitions shows it as alignment "custom-start" with cutOffset.
- list_transition_types is the catalogue: the built-ins (cross-dissolve, dip-to-black, constant-gain, constant-power, exponential-fade, custom-fade; native export) and the GPU transitions (Premiere bins 3D Motion, Dissolve, Iris, Page Peel, Slide, Wipe, Zoom and "Sapphire Transitions"; Remotion export) with their params. add_transition / update_transition take a type (short name, effect id or label) and params ({name: value}, e.g. {"direction": "eastToWest", "borderWidth": 4}); keyframes: apply_commands with param.set {target: ["transition", id, name], at}.`;

/** Short type names (as in add_transition's `type`) → effect ids. */
const shortType = (id: string) => id.replace(/^jasper\./, '');
const TYPE_LIST = `${TRANSITION_SPECS.filter((s) => !s.gpu)
	.map((s) => shortType(s.id))
	.join(', ')}, or any GPU transition of list_transition_types`;

/**
 * A transition type → its effect id: the id ("jasper.iris-round"), the short name ("iris-round",
 * "s.dissolve-luma") or the label ("Iris Round", "S_DissolveLuma"), case-insensitive. Unknown types pass through as
 * `jasper.<type>` (the command reports E_UNKNOWN_EFFECT).
 */
export function transitionEffectId(type: string): string {
	const t = type.trim();
	if (transitionSpec(t)) return t;
	if (transitionSpec(`jasper.${t}`)) return `jasper.${t}`;
	const lower = t.toLowerCase();
	const byLabel = TRANSITION_SPECS.find((s) => s.label.toLowerCase() === lower);
	if (byLabel) return byLabel.id;
	return t.startsWith('jasper.') ? t : `jasper.${t}`;
}

/** list_transition_types entry (pure). */
function transitionTypeSummary(s: TransitionSpec) {
	return {
		effectId: s.id,
		type: shortType(s.id),
		label: s.label,
		medium: s.appliesTo,
		bin: s.subBin ? `${s.bin}/${s.subBin}` : s.bin,
		gpu: !!s.gpu,
		export: s.gpu ? 'remotion' : 'native',
		...(s.expensive ? { expensive: true } : {}),
		description: s.description,
		...(s.keywords ? { keywords: s.keywords } : {}),
		params: s.params.map((p) => ({
			name: p.name,
			label: p.label,
			type: p.type,
			default: p.default,
			...(p.range ? { range: p.range } : {}),
			...(p.unit ? { unit: p.unit } : {}),
			...(p.options ? { options: p.options } : {}),
			...(p.mediaKinds ? { mediaKinds: p.mediaKinds } : {}),
			animatable: p.animatable,
		})),
	};
}

/** Static values of a transition's params (keyframed ones: "keyframed"), for list_transitions. */
function paramValues(t: Transition): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, a] of Object.entries(t.params)) out[k] = a.keyframes.length ? 'keyframed' : a.value;
	return out;
}

const AlignmentArg = z
	.enum(['center', 'start-at-cut', 'end-at-cut'])
	.describe(
		'Where a transition between two clips sits: center (default) needs handles on both clips, start-at-cut only on the outgoing clip, end-at-cut only on the incoming one. Fades at a single clip edge have a fixed alignment.',
	);

/** Handle length for JSON: Infinity (stills, text, solids) → "unlimited". */
const handleValue = (n: number): number | 'unlimited' => (Number.isFinite(n) ? n : 'unlimited');

type TransitionSummary = {
	id: string;
	effectId: string;
	type: string;
	label: string;
	medium: 'video' | 'audio' | 'unknown';
	track: string;
	trackId: string;
	cut: number | null;
	cutTimecode?: string;
	span?: { start: number; end: number; startTimecode: string; endTimecode: string };
	duration: number;
	/** `custom-start` for an off-centre span (Premiere's Custom Start; `cutOffset` frames before the cut). */
	alignment: Transition['alignment'] | 'custom-start';
	cutOffset?: number;
	oneSided: boolean;
	outgoingClipId: string | null;
	incomingClipId: string | null;
	/** Media available beyond the cut: the outgoing clip's tail and the incoming clip's head, in frames. */
	handles: { outgoingTail?: number | 'unlimited'; incomingHead?: number | 'unlimited' };
	/** What the current span uses of those handles. */
	uses?: { outgoingTail: number; incomingHead: number };
	/** GPU transition (exports through Remotion). */
	gpu?: true;
	/** Param values set on the transition (others are at their defaults; list_transition_types lists them). */
	params?: Record<string, unknown>;
	supported?: false;
};

/** The list_transitions entry of one transition (pure). */
function transitionSummary(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	t: Transition,
): TransitionSummary {
	const spec = transitionSpec(t.effectId);
	const out: Clip | undefined = t.outgoingClipId ? seq.clips[t.outgoingClipId] : undefined;
	const inc: Clip | undefined = t.incomingClipId ? seq.clips[t.incomingClipId] : undefined;
	const p = transitionPlacement(seq, t);
	const oneSided = !(t.outgoingClipId && t.incomingClipId);
	return {
		id: t.id,
		effectId: t.effectId,
		type: t.effectId.replace(/^jasper\./, ''),
		label: spec?.label ?? t.effectId,
		medium: spec?.appliesTo ?? 'unknown',
		track: trackLabel(seq, t.trackId) ?? t.trackId,
		trackId: t.trackId,
		cut: p?.cut ?? null,
		...(p
			? {
					cutTimecode: sequenceTimecode(seq, p.cut),
					span: {
						start: p.start,
						end: p.end,
						startTimecode: sequenceTimecode(seq, p.start),
						endTimecode: sequenceTimecode(seq, p.end),
					},
				}
			: {}),
		duration: t.duration,
		...(t.cutPosition !== undefined && !oneSided && p
			? { alignment: 'custom-start' as const, cutOffset: p.cut - p.start }
			: { alignment: t.alignment }),
		oneSided,
		outgoingClipId: t.outgoingClipId,
		incomingClipId: t.incomingClipId,
		handles: {
			...(out ? { outgoingTail: handleValue(clipHandles(doc, seq, out).tail) } : {}),
			...(inc ? { incomingHead: handleValue(clipHandles(doc, seq, inc).head) } : {}),
		},
		...(p && !oneSided
			? { uses: { outgoingTail: Math.max(0, p.end - p.cut), incomingHead: Math.max(0, p.cut - p.start) } }
			: {}),
		...(spec?.gpu ? { gpu: true as const } : {}),
		...(Object.keys(t.params).length ? { params: paramValues(t) } : {}),
		...(spec ? {} : { supported: false as const }),
	};
}

/** The transitions of a sequence overlapping [from, to), in track order then time (pure). */
function listTransitions(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	range: { from?: number; to?: number } = {},
): TransitionSummary[] {
	const from = range.from ?? Number.NEGATIVE_INFINITY;
	const to = range.to ?? Number.POSITIVE_INFINITY;
	const order = new Map(
		[...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].map((t, i) => [t.id, i] as const),
	);
	return Object.values(seq.transitions)
		.map((t) => transitionSummary(doc, seq, t))
		.filter((s) => !s.span || (s.span.start < to && s.span.end > from))
		.sort(
			(a, b) =>
				(order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0) ||
				(a.cut ?? 0) - (b.cut ?? 0) ||
				a.id.localeCompare(b.id),
		);
}

/**
 * The clip ids to give transition.applyDefault: the given ones plus their linked partners on tracks of a
 * requested medium (a video clip id with media ["video", "audio"] also covers its linked audio). Pure.
 */
function expandForMedia(
	doc: Pick<ProjectDocument, 'sequences'>,
	clipIds: readonly string[],
	media: readonly ('video' | 'audio')[],
): string[] {
	const out = new Set(clipIds);
	for (const id of clipIds) {
		const seq = Object.values(doc.sequences).find((s) => s.clips[id]);
		if (!seq) continue;
		const kindOf = (trackId: string) =>
			seq.videoTracks.some((t) => t.id === trackId)
				? 'video'
				: seq.audioTracks.some((t) => t.id === trackId)
					? 'audio'
					: null;
		for (const p of linkedPartners(seq, id)) {
			const k = kindOf(p.trackId);
			if (k && media.includes(k)) out.add(p.id);
		}
	}
	return [...out];
}

type Alignment = Transition['alignment'];
const ALIGNMENTS: readonly Alignment[] = ['center', 'start-at-cut', 'end-at-cut'];

/** The editor user's default transitions as `preferences.get` returns them (S10:TUI-034). */
type EditorTransitionDefaults = { video?: unknown; audio?: unknown; alignment?: unknown };

type ResolvedTransitionDefaults = {
	videoEffectId: string;
	audioEffectId: string;
	alignment: Alignment;
	/** Where the values not given in the call came from. */
	source: 'call' | 'editor preferences' | 'built-in';
};

/**
 * What apply_default_transitions uses (pure): the call's arguments, else the open editor's preferences
 * (when they are valid ids of the right medium), else the built-ins (cross dissolve, constant power, center).
 */
function resolveTransitionDefaults(
	args: { videoType?: string; audioType?: string; alignment?: Alignment },
	editor: EditorTransitionDefaults | null,
): ResolvedTransitionDefaults {
	const pref = (v: unknown, medium: 'video' | 'audio') =>
		typeof v === 'string' && transitionSpec(v)?.appliesTo === medium ? v : undefined;
	const ev = pref(editor?.video, 'video');
	const ea = pref(editor?.audio, 'audio');
	const eal = ALIGNMENTS.includes(editor?.alignment as Alignment)
		? (editor!.alignment as Alignment)
		: undefined;
	const allGiven = !!(args.videoType && args.audioType && args.alignment);
	return {
		videoEffectId: args.videoType ? transitionEffectId(args.videoType) : (ev ?? CROSS_DISSOLVE),
		audioEffectId: args.audioType ? transitionEffectId(args.audioType) : (ea ?? CONSTANT_POWER),
		alignment: args.alignment ?? eal ?? 'center',
		source: allGiven ? 'call' : editor && (ev || ea || eal) ? 'editor preferences' : 'built-in',
	};
}

/** The open editor's default transitions, or null (no editor open, or an editor without the query). */
async function editorTransitionDefaults(
	ctx: ToolContext,
	projectId: string,
): Promise<EditorTransitionDefaults | null> {
	try {
		const q = await ctx.engine((c) => c.agentQuery({ projectId, query: 'preferences.get', args: {} }));
		const t = (q.result as { preferences?: { transitions?: unknown } } | undefined)?.preferences?.transitions;
		return t && typeof t === 'object' ? (t as EditorTransitionDefaults) : null;
	} catch {
		return null;
	}
}

/** Transition-specific hints for the codes whose generic hint is about something else. */
const HINTS: Record<string, string> = {
	E_UNKNOWN_EFFECT: `Transition types: ${TYPE_LIST} (video: cross-dissolve, dip-to-black; audio: constant-gain, constant-power, exponential-fade, custom-fade). list_transition_types lists every type with its params.`,
	E_TRACK_KIND:
		'Video transitions (cross-dissolve, dip-to-black) go on V tracks, audio ones (constant-gain, constant-power, exponential-fade, custom-fade) on A tracks; a type change stays within the same medium.',
	E_OUT_OF_MEDIA:
		"No room for the transition: trim the clips so their media extends past the cut, shorten it, or use start-at-cut (needs only the outgoing clip's tail handle) / end-at-cut (only the incoming clip's head handle). list_transitions shows the handles.",
	E_NOT_FOUND: 'Look transition ids up with list_transitions (or get_timeline), clip ids with get_timeline.',
};

/** Runs one transaction; transaction errors get the transition hints above. */
async function run(
	ctx: ToolContext,
	projectId: string,
	label: string,
	commands: unknown[],
	extra: Parameters<typeof transact>[3],
	sequenceId?: string,
) {
	const res = await transact(ctx, projectId, { label, commands, sequenceId }, extra);
	try {
		return { res, r: requireOk(res) };
	} catch (e) {
		if (e instanceof ToolError && HINTS[e.code])
			throw new ToolError(e.code, e.message, HINTS[e.code], e.details);
		throw e;
	}
}

/** Summaries of the given transition ids in the current document (those that still exist). */
async function summariesOf(ctx: ToolContext, projectId: string, ids: readonly string[]) {
	const { doc } = await loadDoc(ctx, projectId);
	const out: TransitionSummary[] = [];
	for (const id of ids)
		for (const seq of Object.values(doc.sequences)) {
			const t = seq.transitions[id];
			if (t) out.push(transitionSummary(doc, seq, t));
		}
	return out;
}

export function registerTransitionTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_transition_types',
		{
			title: 'List transition types',
			description:
				'The transition catalogue: every type with its effect id, short type name, label, medium (video/audio), Effects-panel bin (Premiere bins: 3D Motion, Dissolve, Iris, Page Peel, Slide, Wipe, Zoom; "Sapphire Transitions/<sub-bin>"; Crossfade), gpu (a shader transition, exported through Remotion) or native, expensive (heavy in the preview), description and params (name, type, default, range, options, animatable). Filter by medium, bin or a search text.',
			input: {
				medium: z.enum(['video', 'audio']).optional().describe('Only video or audio transitions'),
				bin: z
					.string()
					.optional()
					.describe('Only this bin (prefix match, e.g. "Iris" or "Sapphire Transitions")'),
				search: z.string().optional().describe('Text in the label, id, description or keywords'),
			},
			annotations: READ_ONLY,
		},
		async ({ medium, bin, search }) => {
			const q = search?.trim().toLowerCase();
			const types = TRANSITION_SPECS.filter(
				(s) =>
					(!medium || s.appliesTo === medium) &&
					(!bin || `${s.bin}/${s.subBin ?? ''}`.toLowerCase().startsWith(bin.toLowerCase())) &&
					(!q || [s.id, s.label, s.description, ...(s.keywords ?? [])].join(' ').toLowerCase().includes(q)),
			).map(transitionTypeSummary);
			return jsonResult({ count: types.length, types });
		},
	);

	defineTool(
		ctx,
		'list_transitions',
		{
			title: 'List transitions',
			description:
				'The transitions and fades of one sequence, in track order then time: id, type (effect id and label), track, cut frame, span {start, end} in frames and timecode, duration, alignment, oneSided (a fade at a single clip edge), the outgoing/incoming clip ids, and the media handles of those clips beyond the cut (handles) next to what the current span uses (uses). Optionally only transitions overlapping a range.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				range: z
					.object({
						from: TimeInputSchema.optional().describe('Only transitions ending after this time'),
						to: TimeInputSchema.optional().describe('Only transitions starting before this time'),
					})
					.optional()
					.describe(`Time range [from, to). ${TIME_FORMATS}`),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId, range }) => {
			const { doc, revision, live } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const from = range?.from !== undefined ? frameOf(seq, range.from, TIME_FORMATS) : undefined;
			const to = range?.to !== undefined ? frameOf(seq, range.to, TIME_FORMATS) : undefined;
			return jsonResult({
				sequenceId: seq.id,
				revision: revision ?? null,
				editorOpen: live,
				defaultTransitionFrames: doc.settings.defaultTransitionFrames,
				defaultAudioTransitionFrames: defaultTransitionFrames(doc.settings, 'audio'),
				transitions: listTransitions(doc, seq, { from, to }),
			});
		},
	);

	defineTool(
		ctx,
		'update_transition',
		{
			title: 'Update transition',
			description: `Changes an existing transition (transition.update): its length (duration, in frames), alignment or Custom Start (cutOffset: frames of the span before the cut), type (effectId, within the same medium: ${TYPE_LIST}) or params (a custom-fade's fadeShape / fadeValue / symmetry / outFadeShape / outFadeValue). The length is shortened to what the clips and their media handles allow (warning W_TRANSITION_SHORTENED). Returns the updated transition as list_transitions shows it.`,
			input: {
				projectId: ProjectIdArg,
				transitionId: z
					.string()
					.min(1)
					.describe('Transition id ("trn_…") from list_transitions or get_timeline'),
				duration: z.number().int().min(1).max(600).optional().describe('New length in frames'),
				alignment: AlignmentArg.optional(),
				cutOffset: z
					.number()
					.int()
					.min(0)
					.max(600)
					.optional()
					.describe(
						'Custom Start (transitions between two clips): frames of the (new) span before the cut, 0…duration, instead of alignment',
					),
				effectId: z
					.string()
					.min(1)
					.optional()
					.describe(`New type: ${TYPE_LIST}, or the full effect id ("jasper.dip-to-black")`),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						"Param values {name: value} (list_transition_types lists each type's params; a type change resets them first)",
					),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, transitionId, duration, alignment, cutOffset, effectId, params }, extra) => {
			if (
				duration === undefined &&
				alignment === undefined &&
				cutOffset === undefined &&
				effectId === undefined &&
				!params
			)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to change',
					'Pass duration, alignment, cutOffset, effectId and/or params.',
				);
			const id = effectId !== undefined ? transitionEffectId(effectId) : undefined;
			const spec = id ? transitionSpec(id) : null;
			const { res, r } = await run(
				ctx,
				projectId,
				spec ? `Change to ${spec.label}` : 'Update Transition',
				[
					{
						type: 'transition.update',
						transitionId,
						...(id ? { effectId: id } : {}),
						...(duration !== undefined ? { duration } : {}),
						...(alignment ? { alignment } : {}),
						...(cutOffset !== undefined ? { cutOffset } : {}),
						...(params ? { params } : {}),
					},
				],
				extra,
			);
			const [transition] = await summariesOf(ctx, projectId, [transitionId]);
			return jsonResult({ ...txBody(res, r), ...(transition ? { transition } : {}) });
		},
	);

	defineTool(
		ctx,
		'remove_transitions',
		{
			title: 'Remove transitions',
			description:
				'Deletes transitions and fades (transition.remove) by id; the clips stay and cut straight again. Undoable in the editor.',
			input: {
				projectId: ProjectIdArg,
				transitionIds: z
					.array(z.string().min(1))
					.min(1)
					.max(1000)
					.describe('Transition ids ("trn_…") from list_transitions or get_timeline'),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, transitionIds }, extra) => {
			const n = transitionIds.length;
			const { res, r } = await run(
				ctx,
				projectId,
				n === 1 ? 'Remove transition' : `Remove ${n} transitions`,
				[{ type: 'transition.remove', transitionIds }],
				extra,
			);
			const removed = (r.results[0] as { removed?: string[] } | undefined)?.removed ?? transitionIds;
			return jsonResult({ ...txBody(res, r), removed });
		},
	);

	defineTool(
		ctx,
		'apply_default_transitions',
		{
			title: 'Apply default transitions',
			description: `Puts a transition on the edges of the given clips in one step (transition.applyDefault): at an edit point between two clips a two-sided transition (alignment center), at a free clip edge a fade. media picks the tracks (default ["video"]); with ["video", "audio"] the linked audio of the given video clips is included. Types and the alignment default to the editor user's defaults (Preferences ▸ Timeline, the same as Ctrl+D) when the project is open in the editor, else cross-dissolve (video), constant-power (audio) and center; the length to the project's default length of each medium (set_transition_defaults). Edges without room are skipped; longer lengths are shortened (W_TRANSITION_SHORTENED). An edge's existing transition is replaced. Returns the created transitions and the defaults used.`,
			input: {
				projectId: ProjectIdArg,
				clipIds: z.array(z.string().min(1)).min(1).max(1000).describe('Clip ids ("clp_…") from get_timeline'),
				edges: z
					.enum(['both', 'in', 'out'])
					.optional()
					.describe('in = the clip heads, out = the tails, both (default)'),
				media: z
					.array(z.enum(['video', 'audio']))
					.min(1)
					.optional()
					.describe('Which tracks get transitions (default ["video"])'),
				videoType: z
					.string()
					.min(1)
					.optional()
					.describe('Video transition: cross-dissolve (default) or dip-to-black (or the effect id)'),
				audioType: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Audio transition: constant-power (default), constant-gain, exponential-fade or custom-fade (or the effect id)',
					),
				durationFrames: z
					.number()
					.int()
					.min(1)
					.max(600)
					.optional()
					.describe("Length in frames (default: the project's default length of each medium)"),
				alignment: AlignmentArg.optional().describe(
					"Alignment of the transitions between two clips (default: the editor user's default, else center). center needs handles on both clips, start-at-cut only on the outgoing clip, end-at-cut only on the incoming one; edit points without room for it are skipped. Fades at a free clip edge have a fixed alignment.",
				),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (
			{ projectId, clipIds, edges, media, videoType, audioType, durationFrames, alignment, sequenceId },
			extra,
		) => {
			const kinds = media ?? ['video'];
			const { doc } = await loadDoc(ctx, projectId);
			const ids = expandForMedia(doc, clipIds, kinds);
			const given = { videoType, audioType, alignment };
			const defaults = resolveTransitionDefaults(
				given,
				videoType && audioType && alignment ? null : await editorTransitionDefaults(ctx, projectId),
			);
			const { res, r } = await run(
				ctx,
				projectId,
				'Apply Default Transitions',
				[
					{
						type: 'transition.applyDefault',
						clipIds: ids,
						edges: edges ?? 'both',
						media: kinds,
						videoEffectId: defaults.videoEffectId,
						audioEffectId: defaults.audioEffectId,
						alignment: defaults.alignment,
						...(durationFrames !== undefined ? { duration: durationFrames } : {}),
					},
				],
				extra,
				sequenceId,
			);
			const created = (r.results[0] as { transitionIds?: string[] } | undefined)?.transitionIds ?? [];
			return jsonResult({
				...txBody(res, r),
				clipIds: ids,
				defaults: {
					...(kinds.includes('video') ? { video: defaults.videoEffectId } : {}),
					...(kinds.includes('audio') ? { audio: defaults.audioEffectId } : {}),
					alignment: defaults.alignment,
					durationFrames: durationFrames ?? {
						video: defaultTransitionFrames(doc.settings, 'video'),
						audio: defaultTransitionFrames(doc.settings, 'audio'),
					},
					source: defaults.source,
				},
				transitions: await summariesOf(ctx, projectId, created),
				...(created.length
					? {}
					: {
							note: 'No transition was added: the clip edges have no room (clip length or media handles) or are on locked tracks or tracks of another medium.',
						}),
			});
		},
	);
	defineTool(
		ctx,
		'set_transition_defaults',
		{
			title: 'Set transition defaults',
			description:
				'Changes the project\'s default lengths (project.updateSettings, one undoable History entry "Agent: Transition Defaults"): the video and audio transition lengths in frames (used by apply_default_transitions, add_transition without a duration and transitions dropped in the editor) and the still image length in seconds (new stills). Existing transitions and clips keep their length. The default transition types and alignment are the editor user\'s preferences (Preferences ▸ Timeline) and are not part of the project. Returns the defaults after the change.',
			input: {
				projectId: ProjectIdArg,
				videoDurationFrames: z
					.number()
					.int()
					.min(1)
					.max(3600)
					.optional()
					.describe('Default video transition length in frames'),
				audioDurationFrames: z
					.number()
					.int()
					.min(1)
					.max(3600)
					.optional()
					.describe('Default audio transition length in frames'),
				stillDurationSeconds: z
					.number()
					.min(1 / 30)
					.max(3600)
					.optional()
					.describe('Default still image length in seconds (kept in 1/30 s)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, videoDurationFrames, audioDurationFrames, stillDurationSeconds }, extra) => {
			if (
				videoDurationFrames === undefined &&
				audioDurationFrames === undefined &&
				stillDurationSeconds === undefined
			)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to change',
					'Pass videoDurationFrames, audioDurationFrames and/or stillDurationSeconds.',
				);
			const { doc } = await loadDoc(ctx, projectId);
			const settings: Record<string, number> = {};
			if (videoDurationFrames !== undefined) {
				settings.defaultTransitionFrames = videoDurationFrames;
				// Older projects keep one length for both media: pin the audio one so it does not follow.
				if (doc.settings.defaultAudioTransitionFrames === undefined)
					settings.defaultAudioTransitionFrames = doc.settings.defaultTransitionFrames;
			}
			if (audioDurationFrames !== undefined) settings.defaultAudioTransitionFrames = audioDurationFrames;
			if (stillDurationSeconds !== undefined)
				settings.defaultStillDurationFrames = Math.max(1, Math.round(stillDurationSeconds * 30));
			const { res, r } = await run(
				ctx,
				projectId,
				'Transition Defaults',
				[{ type: 'project.updateSettings', settings }],
				extra,
			);
			const after = (await loadDoc(ctx, projectId)).doc.settings;
			return jsonResult({
				...txBody(res, r),
				defaults: {
					videoDurationFrames: defaultTransitionFrames(after, 'video'),
					audioDurationFrames: defaultTransitionFrames(after, 'audio'),
					stillDurationSeconds: after.defaultStillDurationFrames / 30,
				},
			});
		},
	);
}
