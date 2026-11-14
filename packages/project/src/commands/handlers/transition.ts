// A transition sits on one track at one edit point (TRN-001). Two-sided video transitions (cross dissolve,
// dip to black) join two adjacent clips and need handles (TRN-003); one-sided ones are fades at a clip's
// head or tail (TRN-004). Audio tracks take one-sided fades and two-sided crossfades (constant gain /
// constant power, S10:TUI-052; handles as for a cross dissolve). `transition.add` with `clipId` + `edge` on an
// audio clip, or with `oneSided`, is a transition of that clip only (Premiere's single-sided transition), also where
// another clip touches the edge (that clip cuts straight); otherwise a video clip edge where another clip touches it,
// like an edit point given by `trackId` + `at`, joins the two clips. Durations are
// shortened to what the clips and their media handles allow (`handles: 'shorten'`, the agent default), or — video
// transitions with `handles: 'freeze'` (Premiere's "Insufficient media… repeated frames") — kept, the missing
// handle frames repeating the clips' edge frames (`Transition.freezeHandles`, edit-structure). Audio transitions
// always shorten. Rendering is defined in ../../transitions.ts.
import type { Draft } from 'immer';
import type { Clip, Sequence, Transition } from '../../schema/sequence.ts';
import {
	CONSTANT_POWER,
	CROSS_DISSOLVE,
	clipHandles,
	clipsAtEditPoint,
	cutOffsetOf,
	cutPositionFor,
	defaultTransitionFrames,
	fitTransitionDuration,
	isLayer3D,
	TRANSITION_SPECS,
	type TransitionSpec,
	transitionSpan,
	transitionSpec,
} from '../../transitions.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, end, findTrackIn } from '../placement.ts';
import { ruleFromParam, validateValue } from './param.ts';
import type { HandlerMap } from './util.ts';

type DTransition = Draft<Transition>;

/**
 * Writes static param values (validated and clamped against the spec's ParamSpecs) into a transition. Unknown names
 * fail with the list of the transition's params; a keyframed param is refused (param.set edits keys).
 */
function writeParams(
	t: DTransition,
	spec: TransitionSpec,
	values: Record<string, unknown>,
	h: HandlerContext,
) {
	for (const [name, v] of Object.entries(values)) {
		const p = spec.params.find((x) => x.name === name);
		if (!p)
			h.fail(
				'E_INVALID_PARAM',
				spec.params.length
					? `${spec.label} has no parameter "${name}". Parameters: ${spec.params.map((x) => x.name).join(', ')}`
					: `Transition ${spec.id} has no parameters`,
			);
		const label = `${spec.label}.${name}`;
		const { value, clamped } = validateValue(v, ruleFromParam(p!), h, label);
		if (clamped) h.warn('W_VALUE_CLAMPED', `${label} clamped to ${JSON.stringify(value)}`);
		const cur = t.params[name];
		if (cur && cur.keyframes.length > 0)
			h.fail(
				'E_INVALID_PARAM',
				`${label} has keyframes; edit it with param.set {target: ["transition", "${t.id}", "${name}"], at}`,
			);
		t.params[name] = { value: value as never, keyframes: [] };
	}
}

function specOf(effectId: string, h: HandlerContext): TransitionSpec {
	const spec = transitionSpec(effectId);
	if (!spec)
		return h.fail(
			'E_UNKNOWN_EFFECT',
			`Unknown transition "${effectId}". Available: ${TRANSITION_SPECS.map((s) => s.id).join(', ')}`,
		);
	return spec;
}

function locate(doc: DDoc, transitionId: string, h: HandlerContext): { seq: DSeq; t: DTransition } {
	for (const seq of Object.values(doc.sequences)) {
		const t = seq.transitions[transitionId];
		if (t) return { seq, t };
	}
	return h.fail('E_NOT_FOUND', `Transition not found: ${transitionId}`);
}

function trackOf(seq: DSeq, trackId: string, h: HandlerContext) {
	const found = findTrackIn(seq, trackId);
	if (!found) return h.fail('E_NOT_FOUND', `Track not found: ${trackId}`);
	return found.track;
}

/** Longest duration ≤ `wanted` that the clips at this edit point allow, with the reason when it is shorter. */
function fit(
	doc: DDoc,
	seq: DSeq,
	effectId: string,
	wanted: number,
	alignment: Transition['alignment'],
	outgoing: Clip | null,
	incoming: Clip | null,
	freeze = false,
	cutPosition?: number,
): number {
	const inf = Number.POSITIVE_INFINITY;
	return fitTransitionDuration({
		effectId,
		wanted,
		alignment,
		cutPosition,
		outgoing: outgoing
			? {
					duration: outgoing.duration,
					tail: freeze ? inf : clipHandles(doc as never, seq as Sequence, outgoing).tail,
				}
			: null,
		incoming: incoming
			? {
					duration: incoming.duration,
					head: freeze ? inf : clipHandles(doc as never, seq as Sequence, incoming).head,
				}
			: null,
	});
}

/**
 * Duration of a transition with the handle policy: `freeze` (video only) keeps what the clips' lengths allow and
 * reports whether media frames are missing (they repeat); `shorten` fits the media handles.
 */
function fitWithHandles(
	doc: DDoc,
	seq: DSeq,
	effectId: string,
	wanted: number,
	alignment: Transition['alignment'],
	outgoing: Clip | null,
	incoming: Clip | null,
	freezeWanted: boolean,
	cutPosition?: number,
): { duration: number; freeze: boolean } {
	const media = fit(doc, seq, effectId, wanted, alignment, outgoing, incoming, false, cutPosition);
	if (!freezeWanted || !outgoing || !incoming) return { duration: media, freeze: false };
	const frozen = fit(doc, seq, effectId, wanted, alignment, outgoing, incoming, true, cutPosition);
	return frozen > media ? { duration: frozen, freeze: true } : { duration: media, freeze: false };
}

function noRoomMessage(
	alignment: Transition['alignment'],
	wanted: number,
	two: boolean,
	cutPosition?: number,
): string {
	if (!two) return 'The clip is too short for this transition';
	const { start, end: e } = transitionSpan(0, wanted, alignment, cutPosition);
	const where = cutPosition === undefined ? alignment : `custom-start (${-start} frames before the cut)`;
	return (
		`No media handles for a ${wanted}-frame ${where} transition: the outgoing clip needs ${Math.max(0, e)} ` +
		`frame(s) of media after its out-point and the incoming clip ${Math.max(0, -start)} before its in-point. ` +
		'Trim the clips so the media extends past the cut, or use another alignment ' +
		'("start-at-cut" only needs the outgoing clip\'s handle, "end-at-cut" only the incoming one\'s).'
	);
}

type AddArgs = {
	seq: DSeq;
	trackId: string;
	outgoing: Clip | null;
	incoming: Clip | null;
	effectId: string;
	duration?: number;
	alignment?: Transition['alignment'];
	cutOffset?: number;
	handles?: 'shorten' | 'freeze';
	params?: Record<string, unknown>;
	ref?: string;
};

/**
 * A Custom Start request (`cutOffset` frames of a `wanted`-frame span before the cut) → the alignment and cut position
 * to store; refused on fades, past the span, or together with a different alignment.
 */
function customStart(
	cutOffset: number,
	wanted: number,
	alignment: Transition['alignment'] | undefined,
	two: boolean,
	h: HandlerContext,
): { alignment: Transition['alignment']; cutPosition?: number } {
	if (!two)
		return h.fail('E_INVALID_PARAM', 'A fade at a single clip edge has a fixed alignment (no cutOffset)');
	if (cutOffset > wanted)
		h.fail(
			'E_INVALID_PARAM',
			`cutOffset ${cutOffset} is past the end of the ${wanted}-frame span (0…${wanted})`,
		);
	const r = cutPositionFor(cutOffset, wanted);
	if (alignment !== undefined && alignment !== r.alignment)
		h.fail(
			'E_INVALID_PARAM',
			`Give alignment or cutOffset, not both (cutOffset ${cutOffset} is not ${alignment})`,
		);
	return r;
}

/** The result fields of a transition's position: alignment and, for a Custom Start, the cut offset in frames. */
function positionResult(t: Pick<Transition, 'alignment' | 'cutPosition' | 'duration'>) {
	return {
		alignment: t.alignment,
		...(t.cutPosition !== undefined
			? { cutOffset: cutOffsetOf(t.duration, t.alignment, t.cutPosition) }
			: {}),
	};
}

function addTransition(doc: DDoc, a: AddArgs, h: HandlerContext) {
	const { seq, outgoing, incoming } = a;
	const spec = specOf(a.effectId, h);
	const track = trackOf(seq, a.trackId, h);
	assertUnlocked(track, h);
	if (track.kind !== spec.appliesTo)
		h.fail(
			'E_TRACK_KIND',
			`${spec.label} is ${spec.appliesTo === 'video' ? 'a video' : 'an audio'} transition`,
		);
	// three-d: a 3D layer is a plane of the 3D scene; transitions (pictures mixed in the frame) do not apply to it.
	for (const c of [outgoing, incoming])
		if (c && isLayer3D(c))
			h.fail(
				'E_INVALID_PARAM',
				`"${c.name}" is a 3D layer: 3D layers take no transitions (animate Opacity instead)`,
				{
					blocking: [c.id],
				},
			);
	const two = !!outgoing && !!incoming;
	const wanted = a.duration ?? defaultTransitionFrames(doc.settings, spec.appliesTo);
	const custom = a.cutOffset !== undefined ? customStart(a.cutOffset, wanted, a.alignment, two, h) : null;
	const alignment: Transition['alignment'] = custom
		? custom.alignment
		: two
			? (a.alignment ?? 'center')
			: incoming
				? 'start-at-cut'
				: 'end-at-cut';
	const cutPosition = custom?.cutPosition;
	const { duration, freeze } = fitWithHandles(
		doc,
		seq,
		a.effectId,
		wanted,
		alignment,
		outgoing,
		incoming,
		a.handles === 'freeze' && spec.appliesTo === 'video',
		cutPosition,
	);
	if (duration === 0) h.fail('E_OUT_OF_MEDIA', noRoomMessage(alignment, wanted, two, cutPosition));
	if (duration < wanted)
		h.warn(
			'W_TRANSITION_SHORTENED',
			`Transition shortened from ${wanted} to ${duration} frames (clip length${freeze || a.handles === 'freeze' ? '' : ' or media handles'})`,
		);
	if (freeze)
		h.warn(
			'W_TRANSITION_FREEZE_FRAMES',
			'Insufficient media: this transition contains repeated frames (freeze-frame handles)',
		);
	// One transition per clip edge (INV-010): a new one replaces what is there.
	for (const t of Object.values(seq.transitions)) {
		if ((outgoing && t.outgoingClipId === outgoing.id) || (incoming && t.incomingClipId === incoming.id))
			delete seq.transitions[t.id];
	}
	const id = h.ids.next('trn');
	h.defineRef(a.ref, id);
	seq.transitions[id] = {
		id,
		trackId: a.trackId,
		effectId: spec.id,
		effectVersion: spec.version,
		outgoingClipId: outgoing?.id ?? null,
		incomingClipId: incoming?.id ?? null,
		duration,
		alignment,
		params: {},
		...(freeze ? { freezeHandles: true } : {}),
		...(cutPosition !== undefined ? { cutPosition } : {}),
	};
	if (a.params) writeParams(seq.transitions[id]!, spec, a.params, h);
	return {
		transitionId: id,
		duration,
		...positionResult(seq.transitions[id]!),
		outgoingClipId: outgoing?.id ?? null,
		incomingClipId: incoming?.id ?? null,
		...(freeze ? { freezeHandles: true } : {}),
	};
}

export const transitionHandlers = {
	'transition.add': (doc, cmd, h) => {
		let seq: DSeq;
		let trackId: string;
		let cut: number;
		if (cmd.clipId !== undefined) {
			if (!cmd.edge) h.fail('E_INVALID_PARAM', 'edge ("in" or "out") is required with clipId');
			const r = h.clip(doc, cmd.clipId);
			const clip = r.clip as Clip;
			seq = r.seq;
			trackId = clip.trackId;
			cut = cmd.edge === 'in' ? clip.start : end(clip);
			// An audio clip edge is always a fade of that clip; `oneSided` makes a video clip edge one too, also where
			// another clip touches it (that clip cuts straight, without handles: Premiere's single-sided transition).
			if (cmd.oneSided || trackOf(seq, trackId, h).kind === 'audio') {
				const at = clipsAtEditPoint(seq as Sequence, trackId, cut);
				const adjacent = cmd.edge === 'in' ? at.outgoing : at.incoming;
				const fixed = cmd.edge === 'in' ? 'start-at-cut' : 'end-at-cut';
				if (adjacent && (cmd.cutOffset !== undefined || (cmd.alignment ?? fixed) !== fixed))
					h.fail(
						'E_INVALID_PARAM',
						`A transition at one clip edge is one-sided (fixed alignment): ${adjacent.id} cuts straight. For a transition between both clips, give the track and at ${cut} instead of clipId + edge.`,
					);
				if (cmd.cutOffset !== undefined)
					h.fail('E_INVALID_PARAM', 'A fade at a single clip edge has a fixed alignment (no cutOffset)');
				const added = addTransition(
					doc,
					{
						seq,
						trackId,
						outgoing: cmd.edge === 'out' ? clip : null,
						incoming: cmd.edge === 'in' ? clip : null,
						effectId: cmd.effectId,
						duration: cmd.duration,
						handles: cmd.handles,
						params: cmd.params,
						ref: cmd.ref,
					},
					h,
				);
				return adjacent ? { ...added, adjacentClipId: adjacent.id } : added;
			}
		} else {
			if (cmd.trackId === undefined || cmd.at === undefined)
				return h.fail('E_INVALID_PARAM', 'Give clipId + edge, or trackId + at (the frame of the edit point)');
			seq = h.sequence(doc, cmd.sequenceId);
			trackId = h.track(seq, cmd.trackId).id;
			cut = cmd.at;
		}
		const { outgoing, incoming } = clipsAtEditPoint(seq as Sequence, trackId, cut);
		if (!outgoing && !incoming)
			h.fail('E_INVALID_PARAM', `No clip starts or ends at frame ${cut} on that track (not an edit point)`);
		return addTransition(
			doc,
			{
				seq,
				trackId,
				outgoing,
				incoming,
				effectId: cmd.effectId,
				duration: cmd.duration,
				alignment: cmd.alignment,
				cutOffset: cmd.cutOffset,
				handles: cmd.handles,
				params: cmd.params,
				ref: cmd.ref,
			},
			h,
		);
	},

	'transition.update': (doc, cmd, h) => {
		const { seq, t } = locate(doc, cmd.transitionId, h);
		const track = trackOf(seq, t.trackId, h);
		assertUnlocked(track, h);
		// change the type within the same medium; the duration is re-fitted below.
		let effectId = t.effectId;
		if (cmd.effectId !== undefined && cmd.effectId !== t.effectId) {
			const spec = specOf(cmd.effectId, h);
			if (spec.appliesTo !== track.kind)
				h.fail(
					'E_TRACK_KIND',
					`${spec.label} is ${spec.appliesTo === 'video' ? 'a video' : 'an audio'} transition; this transition is on ${track.kind === 'video' ? 'a video' : 'an audio'} track`,
				);
			effectId = spec.id;
		}
		const outgoing = t.outgoingClipId ? ((seq.clips[t.outgoingClipId] as Clip | undefined) ?? null) : null;
		const incoming = t.incomingClipId ? ((seq.clips[t.incomingClipId] as Clip | undefined) ?? null) : null;
		const two = !!outgoing && !!incoming;
		if (cmd.alignment && !two && cmd.alignment !== t.alignment)
			h.fail('E_INVALID_PARAM', 'A fade at a single clip edge has a fixed alignment');
		const wanted = cmd.duration ?? t.duration;
		// Custom Start: a new cutOffset sets it, a new alignment drops it, otherwise the stored fraction stays.
		const custom =
			cmd.cutOffset !== undefined ? customStart(cmd.cutOffset, wanted, cmd.alignment, two, h) : null;
		const alignment = custom ? custom.alignment : (cmd.alignment ?? t.alignment);
		const cutPosition = custom
			? custom.cutPosition
			: cmd.alignment !== undefined || !two
				? undefined
				: (t.cutPosition as number | undefined);
		const freezeWanted =
			track.kind === 'video' && (cmd.handles ? cmd.handles === 'freeze' : t.freezeHandles === true);
		const { duration, freeze } = fitWithHandles(
			doc,
			seq,
			effectId,
			wanted,
			alignment,
			outgoing,
			incoming,
			freezeWanted,
			cutPosition,
		);
		if (duration === 0) h.fail('E_OUT_OF_MEDIA', noRoomMessage(alignment, wanted, two, cutPosition));
		if (duration < wanted)
			h.warn(
				'W_TRANSITION_SHORTENED',
				`Transition shortened from ${wanted} to ${duration} frames (clip length${freezeWanted ? '' : ' or media handles'})`,
			);
		if (freeze && !t.freezeHandles)
			h.warn(
				'W_TRANSITION_FREEZE_FRAMES',
				'Insufficient media: this transition contains repeated frames (freeze-frame handles)',
			);
		if (freeze) t.freezeHandles = true;
		else delete t.freezeHandles;
		if (effectId !== t.effectId) {
			t.effectId = effectId;
			t.effectVersion = transitionSpec(effectId)!.version;
			t.params = {};
		}
		t.alignment = alignment;
		t.duration = duration;
		if (cutPosition !== undefined) t.cutPosition = cutPosition;
		else delete t.cutPosition;
		if (cmd.params && Object.keys(cmd.params).length > 0) writeParams(t, specOf(effectId, h), cmd.params, h);
		return {
			transitionId: t.id,
			effectId,
			duration,
			...positionResult(t),
			...(freeze ? { freezeHandles: true } : {}),
		};
	},

	'transition.remove': (doc, cmd, h) => {
		const removed: string[] = [];
		for (const id of new Set(cmd.transitionIds)) {
			const { seq, t } = locate(doc, id, h);
			assertUnlocked(trackOf(seq, t.trackId, h), h);
			delete seq.transitions[id];
			removed.push(id);
		}
		return { removed };
	},

	'transition.applyDefault': (doc, cmd, h) => {
		const ids = cmd.clipIds === '$selection' ? [] : cmd.clipIds;
		if (ids.length === 0) h.fail('E_INVALID_PARAM', 'No clips given');
		const { seq, clips } = h.clipsOf(doc, ids);
		// media, the user's default transitions and a duration override.
		const media = new Set(cmd.media ?? ['video']);
		const effectFor = {
			video: cmd.videoEffectId ?? CROSS_DISSOLVE,
			audio: cmd.audioEffectId ?? CONSTANT_POWER,
		};
		for (const kind of ['video', 'audio'] as const) {
			if (!media.has(kind)) continue;
			const spec = specOf(effectFor[kind], h);
			if (spec.appliesTo !== kind)
				h.fail(
					'E_TRACK_KIND',
					`${spec.label} is not ${kind === 'video' ? 'a video' : 'an audio'} transition`,
				);
		}
		// S10:TUI-032/033: each medium's project default length; the user's alignment for two-sided ones.
		const wantedFor = {
			video: cmd.duration ?? defaultTransitionFrames(doc.settings, 'video'),
			audio: cmd.duration ?? defaultTransitionFrames(doc.settings, 'audio'),
		};
		const created: string[] = [];
		const done = new Set<string>();
		for (const clip of clips) {
			const track = trackOf(seq, clip.trackId, h);
			if (track.kind !== 'video' && track.kind !== 'audio') continue;
			if (!media.has(track.kind) || track.locked) continue;
			const effectId = effectFor[track.kind];
			const wanted = wantedFor[track.kind];
			for (const edge of cmd.edges === 'both' ? (['in', 'out'] as const) : [cmd.edges]) {
				const cut = edge === 'in' ? clip.start : end(clip);
				// Where two clips meet: a cross dissolve / an audio crossfade (S10:TUI-052); free edges: fades.
				const { outgoing, incoming } = clipsAtEditPoint(seq as Sequence, clip.trackId, cut);
				const key = outgoing && incoming ? `${clip.trackId}:${cut}` : `${clip.id}:${edge}`;
				if (done.has(key)) continue;
				done.add(key);
				const two = !!outgoing && !!incoming;
				const alignment: Transition['alignment'] = two
					? (cmd.alignment ?? 'center')
					: incoming
						? 'start-at-cut'
						: 'end-at-cut';
				if ((outgoing && isLayer3D(outgoing)) || (incoming && isLayer3D(incoming))) {
					h.warn('W_TRANSITION_3D', '3D layers take no transitions: skipped the edit points of 3D layers');
					continue;
				}
				const freezeWanted = cmd.handles === 'freeze' && track.kind === 'video';
				// Edit points without room are skipped instead of failing the whole command.
				if (fit(doc, seq, effectId, wanted, alignment, outgoing, incoming, freezeWanted) === 0) continue;
				const r = addTransition(
					doc,
					{
						seq,
						trackId: clip.trackId,
						outgoing,
						incoming,
						effectId,
						duration: wanted,
						alignment,
						...(cmd.handles ? { handles: cmd.handles } : {}),
					},
					h,
				);
				created.push(r.transitionId);
			}
		}
		return { transitionIds: created };
	},
} satisfies HandlerMap;
