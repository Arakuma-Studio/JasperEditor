// M2 MCP tools for transitions (S10:TUI-060, ARCHITECTURE §19.9): list_transitions, update_transition,
// remove_transitions, apply_default_transitions. add_transition lives with the timeline helpers in
// editing.ts. Every edit is one transaction, i.e. one "Agent: <label>" History entry.
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
	trackLabel,
	transitionSpec,
} from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT,
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
import { TIME_FORMATS } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE). */
export const TRANSITION_GUIDE = `Transitions:
- add_transition adds one at an edit point (track + at) or a fade at a clip edge (clipId + edge). apply_default_transitions puts the default transitions on every edge of the given clips in one step (the editor user's default types and alignment from Preferences ▸ Timeline when the editor is open, else cross-dissolve / constant-power, center; the project's default length per medium); pass media: ["video", "audio"] to include the linked audio.
- set_transition_defaults changes the project's default lengths (video and audio transitions, stills); the default types and alignment are the user's preferences in the editor and can only be overridden per call.
- list_transitions shows each transition's id, type, track, cut, span and the media handles of its clips; get_timeline lists them per track too. update_transition changes the length, alignment or type (within video or within audio); remove_transitions deletes them.
- A transition between two clips needs media beyond the cut ("handles"): center needs both, start-at-cut only the outgoing clip's tail handle, end-at-cut only the incoming clip's head handle. Durations are shortened to what fits (warning W_TRANSITION_SHORTENED); E_OUT_OF_MEDIA means nothing fits: try another alignment or trim the clips.`;

/** Short type names (as in add_transition's `type`) → effect ids. */
const SHORT_TYPES = TRANSITION_SPECS.map((s) => s.id.replace(/^jasper\./, ''));
const TYPE_LIST = SHORT_TYPES.join(', ');

/** "cross-dissolve" or "jasper.cross-dissolve" → "jasper.cross-dissolve" (unknown ids pass through). */
export function transitionEffectId(type: string): string {
	const t = type.trim();
	return t.includes('.') ? t : `jasper.${t}`;
}

const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');
const AlignmentArg = z
	.enum(['center', 'start-at-cut', 'end-at-cut'])
	.describe(
		'Where a transition between two clips sits: center (default) needs handles on both clips, start-at-cut only on the outgoing clip, end-at-cut only on the incoming one. Fades at a single clip edge have a fixed alignment.',
	);

/** Handle length for JSON: Infinity (stills, text, solids) → "unlimited". */
const handleValue = (n: number): number | 'unlimited' => (Number.isFinite(n) ? n : 'unlimited');

export type TransitionSummary = {
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
	alignment: Transition['alignment'];
	oneSided: boolean;
	outgoingClipId: string | null;
	incomingClipId: string | null;
	/** Media available beyond the cut: the outgoing clip's tail and the incoming clip's head, in frames. */
	handles: { outgoingTail?: number | 'unlimited'; incomingHead?: number | 'unlimited' };
	/** What the current span uses of those handles. */
	uses?: { outgoingTail: number; incomingHead: number };
	supported?: false;
};

/** The list_transitions entry of one transition (pure). */
export function transitionSummary(
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
		alignment: t.alignment,
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
		...(spec ? {} : { supported: false as const }),
	};
}

/** The transitions of a sequence overlapping [from, to), in track order then time (pure). */
export function listTransitions(
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
export function expandForMedia(
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
	E_UNKNOWN_EFFECT: `Transition types: ${TYPE_LIST} (video: cross-dissolve, dip-to-black; audio: constant-gain, constant-power).`,
	E_TRACK_KIND:
		'Video transitions (cross-dissolve, dip-to-black) go on V tracks, audio ones (constant-gain, constant-power) on A tracks; a type change stays within the same medium.',
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
			let seq: Sequence;
			try {
				seq = pickSequence(doc, sequenceId);
			} catch (e) {
				throw new ToolError('E_NOT_FOUND', (e as Error).message, 'Call get_project for sequence ids.');
			}
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
			description: `Changes an existing transition (transition.update): its length (duration, in frames), alignment, or type (effectId, within the same medium: ${TYPE_LIST}). The length is shortened to what the clips and their media handles allow (warning W_TRANSITION_SHORTENED). Returns the updated transition as list_transitions shows it.`,
			input: {
				projectId: ProjectIdArg,
				transitionId: z
					.string()
					.min(1)
					.describe('Transition id ("trn_…") from list_transitions or get_timeline'),
				duration: z.number().int().min(1).max(600).optional().describe('New length in frames'),
				alignment: AlignmentArg.optional(),
				effectId: z
					.string()
					.min(1)
					.optional()
					.describe(`New type: ${TYPE_LIST}, or the full effect id ("jasper.dip-to-black")`),
			},
			annotations: EDIT,
		},
		async ({ projectId, transitionId, duration, alignment, effectId }, extra) => {
			if (duration === undefined && alignment === undefined && effectId === undefined)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to change',
					'Pass duration, alignment and/or effectId.',
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
			annotations: DESTRUCTIVE,
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
					.describe('Audio transition: constant-power (default) or constant-gain (or the effect id)'),
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
			annotations: EDIT,
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
			annotations: EDIT,
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
