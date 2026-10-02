// Transitions and fades (S01 §13): transition.add / update / remove / applyDefault.
//
// A transition sits on one track at one edit point (TRN-001). Two-sided video transitions (cross dissolve,
// dip to black) join two adjacent clips and need handles (TRN-003); one-sided ones are fades at a clip's
// head or tail (TRN-004). Audio tracks take one-sided fades and two-sided crossfades (constant gain /
// constant power, S10:TUI-052; handles as for a cross dissolve); `transition.add` with `clipId` + `edge` on an
// audio clip is always a fade of that clip, an edit point given by `trackId` + `at` a crossfade. Durations are
// shortened to what the clips and their media handles allow (`handles: 'shorten'`, the agent default);
// freeze-frame handles are not implemented. Rendering is defined in ../../transitions.ts.
import type { Draft } from 'immer';
import type { Clip, Sequence, Transition } from '../../schema/sequence.ts';
import {
	CONSTANT_POWER,
	CROSS_DISSOLVE,
	clipHandles,
	clipsAtEditPoint,
	defaultTransitionFrames,
	fitTransitionDuration,
	TRANSITION_SPECS,
	type TransitionSpec,
	transitionSpan,
	transitionSpec,
} from '../../transitions.ts';
import type { DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, end, findTrackIn } from '../placement.ts';
import type { HandlerMap } from './util.ts';

type DTransition = Draft<Transition>;

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
): number {
	return fitTransitionDuration({
		effectId,
		wanted,
		alignment,
		outgoing: outgoing
			? { duration: outgoing.duration, tail: clipHandles(doc as never, seq as Sequence, outgoing).tail }
			: null,
		incoming: incoming
			? { duration: incoming.duration, head: clipHandles(doc as never, seq as Sequence, incoming).head }
			: null,
	});
}

function noRoomMessage(alignment: Transition['alignment'], wanted: number, two: boolean): string {
	if (!two) return 'The clip is too short for this transition';
	const { start, end: e } = transitionSpan(0, wanted, alignment);
	return (
		`No media handles for a ${wanted}-frame ${alignment} transition: the outgoing clip needs ${Math.max(0, e)} ` +
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
	handles?: 'shorten' | 'freeze';
	ref?: string;
};

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
	const two = !!outgoing && !!incoming;
	const alignment: Transition['alignment'] = two
		? (a.alignment ?? 'center')
		: incoming
			? 'start-at-cut'
			: 'end-at-cut';
	const wanted = a.duration ?? defaultTransitionFrames(doc.settings, spec.appliesTo);
	const duration = fit(doc, seq, a.effectId, wanted, alignment, outgoing, incoming);
	if (duration < wanted) {
		if (duration === 0) h.fail('E_OUT_OF_MEDIA', noRoomMessage(alignment, wanted, two));
		if (a.handles === 'freeze')
			h.fail(
				'E_NOT_IMPLEMENTED',
				`Freeze-frame handles are not implemented; ${duration} frame(s) fit with the media available (handles: "shorten")`,
			);
		h.warn(
			'W_TRANSITION_SHORTENED',
			`Transition shortened from ${wanted} to ${duration} frames (clip length or media handles)`,
		);
	}
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
	};
	return {
		transitionId: id,
		duration,
		alignment,
		outgoingClipId: outgoing?.id ?? null,
		incomingClipId: incoming?.id ?? null,
	};
}

export const transitionHandlers: HandlerMap = {
	'transition.add': (doc, cmd, h) => {
		let seq: DSeq;
		let trackId: string;
		let cut: number;
		if (cmd.clipId !== undefined) {
			if (!cmd.edge) h.fail('E_INVALID_PARAM', 'edge ("in" or "out") is required with clipId');
			const r = h.clip(doc, cmd.clipId);
			seq = r.seq;
			trackId = r.clip.trackId;
			cut = cmd.edge === 'in' ? r.clip.start : end(r.clip);
			// An audio clip edge is always a fade of that clip, also when another clip touches it.
			if (trackOf(seq, trackId, h).kind === 'audio') {
				return addTransition(
					doc,
					{
						seq,
						trackId,
						outgoing: cmd.edge === 'out' ? (r.clip as Clip) : null,
						incoming: cmd.edge === 'in' ? (r.clip as Clip) : null,
						effectId: cmd.effectId,
						duration: cmd.duration,
						handles: cmd.handles,
						ref: cmd.ref,
					},
					h,
				);
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
				handles: cmd.handles,
				ref: cmd.ref,
			},
			h,
		);
	},

	'transition.update': (doc, cmd, h) => {
		const { seq, t } = locate(doc, cmd.transitionId, h);
		const track = trackOf(seq, t.trackId, h);
		assertUnlocked(track, h);
		// M2 (S10:TUI-050): change the type within the same medium; the duration is re-fitted below.
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
		if (cmd.params && Object.keys(cmd.params).length > 0)
			h.fail('E_INVALID_PARAM', `Transition ${effectId} has no parameters`);
		const outgoing = t.outgoingClipId ? ((seq.clips[t.outgoingClipId] as Clip | undefined) ?? null) : null;
		const incoming = t.incomingClipId ? ((seq.clips[t.incomingClipId] as Clip | undefined) ?? null) : null;
		const two = !!outgoing && !!incoming;
		if (cmd.alignment && !two && cmd.alignment !== t.alignment)
			h.fail('E_INVALID_PARAM', 'A fade at a single clip edge has a fixed alignment');
		const alignment = cmd.alignment ?? t.alignment;
		const wanted = cmd.duration ?? t.duration;
		const duration = fit(doc, seq, effectId, wanted, alignment, outgoing, incoming);
		if (duration === 0) h.fail('E_OUT_OF_MEDIA', noRoomMessage(alignment, wanted, two));
		if (duration < wanted)
			h.warn(
				'W_TRANSITION_SHORTENED',
				`Transition shortened from ${wanted} to ${duration} frames (clip length or media handles)`,
			);
		if (effectId !== t.effectId) {
			t.effectId = effectId;
			t.effectVersion = transitionSpec(effectId)!.version;
			t.params = {};
		}
		t.alignment = alignment;
		t.duration = duration;
		return { transitionId: t.id, effectId, duration, alignment };
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
		// M2 (S10:TUI-030/051): media, the user's default transitions and a duration override.
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
				// Edit points without room are skipped instead of failing the whole command.
				if (fit(doc, seq, effectId, wanted, alignment, outgoing, incoming) === 0) continue;
				const r = addTransition(
					doc,
					{ seq, trackId: clip.trackId, outgoing, incoming, effectId, duration: wanted, alignment },
					h,
				);
				created.push(r.transitionId);
			}
		}
		return { transitionIds: created };
	},
};
