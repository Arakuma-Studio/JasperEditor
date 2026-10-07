// Essential Sound and Remix handlers (audio-fx; docs/wp-notes/audio-fx.md). Essential Sound edits reconcile the
// clip's essential effects, gain, Volume and pan with its settings (essential/reconcile.ts); Remix replaces a music
// clip by its pieces (grouped clips, constant-power crossfades at the joints) or restores it.
import { current, type Draft, isDraft } from 'immer';
import { contentTimeAt } from '../../derive/index.ts';
import {
	type AudioType,
	builtinEssentialPresets,
	DEFAULT_LOUDNESS_TARGET,
	type EssentialSound,
	EssentialSoundError,
	newEssentialSound,
	readEssentialSound,
	setEssentialValue,
	withPreset,
} from '../../essential/model.ts';
import { reconcileEssential } from '../../essential/reconcile.ts';
import { EASE_PRESETS } from '../../keyframes.ts';
import type { ParamValue } from '../../schema/common.ts';
import type { AudioClip, Clip, ClipRemix } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational, secondsToFlicks } from '../../time.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import {
	assertUnlocked,
	cleanupSequence,
	findTrackIn,
	reidentifyClipChildren,
	removeClip,
	trackClips,
} from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { transitionHandlers } from './transition.ts';
import { type HandlerMap, idList } from './util.ts';

export const ESSENTIAL_OWNER = 'audio-fx' as const;

type DAudio = Draft<AudioClip>;

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(isDraft(v) ? current(v as Draft<T>) : v)) as T;

function audioClips(doc: DDoc, ids: readonly string[], h: HandlerContext): { seq: DSeq; clips: DAudio[] } {
	const { seq, clips } = h.clipsOf(doc, ids);
	for (const c of clips) {
		if (c.kind !== 'audio')
			h.fail('E_INVALID_PARAM', `${c.id} is not an audio clip (Essential Sound works on audio clips)`, {
				path: [c.id],
			});
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
	}
	return { seq, clips: clips as unknown as DAudio[] };
}

/** Content time (flicks) of the playhead `at` inside the clip (clamped to its frames), default its first frame. */
function timeIn(
	seq: DSeq,
	clip: DAudio,
	at: CommandOf<'essentialSound.set'>['at'],
	h: HandlerContext,
): number {
	const rate = seq.settings.frameRate as Rational;
	const f = at === undefined ? clip.start : h.frame(seq, at);
	const k = Math.min(Math.max(f, clip.start), clip.start + clip.duration - 1);
	return Math.round(contentTimeAt(clip as unknown as Clip, k, rate));
}

/** Writes the new settings and reconciles the clip's effects and levels (one place for every command). */
function update(clip: DAudio, next: EssentialSound | null, time: number, h: HandlerContext): void {
	const old = readEssentialSound(clip.essential);
	reconcileEssential(clip as never, old, next, {
		time,
		newEffectId: () => h.ids.next('fx'),
		newKey: (t, value: ParamValue, hold) => ({
			id: h.ids.next('kf'),
			time: t,
			value,
			interpolation: hold ? 'hold' : 'linear',
			easeIn: { ...EASE_PRESETS.linear },
			easeOut: { ...EASE_PRESETS.linear },
		}),
	});
	if (next) clip.essential = next as never;
	else delete clip.essential;
}

function tryValue<T>(f: () => T, h: HandlerContext, clipId: string): T {
	try {
		return f();
	} catch (e) {
		if (e instanceof EssentialSoundError) return h.fail('E_INVALID_PARAM', e.message, { path: [clipId] });
		throw e;
	}
}

// ---------------------------------------------------------------- remix helpers

const end = (c: { start: number; duration: number }) => c.start + c.duration;

/** The pieces of the remix a clip belongs to (sorted by start), or just the clip. */
function remixPieces(seq: DSeq, clip: DClip): DAudio[] {
	const r = (clip as DAudio).remix;
	if (!r) return [clip as DAudio];
	return (
		Object.values(seq.clips).filter((c) => c.kind === 'audio' && (c as DAudio).remix?.id === r.id) as DAudio[]
	).sort((a, b) => a.start - b.start);
}

/** Replaces a remix's pieces by the original clip (the first piece keeps its id); returns the restored clip. */
function revertRemix(seq: DSeq, any: DAudio, h: HandlerContext): DAudio {
	const pieces = remixPieces(seq, any);
	const first = pieces[0]!;
	const info = first.remix!;
	const lastId = pieces[pieces.length - 1]!.id;
	// Fades at the remix's ends follow the restored clip; joint crossfades go with the pieces.
	const fadeOut = Object.values(seq.transitions).filter(
		(t) => t.outgoingClipId === lastId && !t.incomingClipId,
	);
	for (const t of fadeOut) t.outgoingClipId = first.id;
	for (const p of pieces.slice(1)) removeClip(seq, p.id, h);
	for (const t of Object.values(seq.transitions))
		if (t.outgoingClipId === first.id && t.incomingClipId) delete seq.transitions[t.id];
	first.start = info.original.start;
	first.duration = info.original.duration;
	first.sourceIn = info.original.sourceIn;
	first.name = first.name.replace(/ \(Remix \d+\/\d+\)$/, '');
	if (first.groupId === info.id) first.groupId = null;
	delete first.remix;
	cleanupSequence(seq, h);
	return first;
}

export const essentialHandlers: HandlerMap = {
	'essentialSound.setType': (doc, cmd: CommandOf<'essentialSound.setType'>, h) => {
		const { seq, clips } = audioClips(doc, idList(cmd.clipIds), h);
		for (const c of clips) {
			const cur = readEssentialSound(c.essential);
			if (cur?.type === cmd.audioType) continue;
			update(c, newEssentialSound(cmd.audioType as AudioType), timeIn(seq, c, undefined, h), h);
		}
		return { clips: clips.map((c) => c.id), audioType: cmd.audioType };
	},

	'essentialSound.clearType': (doc, cmd: CommandOf<'essentialSound.clearType'>, h) => {
		const { seq, clips } = audioClips(doc, idList(cmd.clipIds), h);
		for (const c of clips) if (c.essential !== undefined) update(c, null, timeIn(seq, c, undefined, h), h);
		return { clips: clips.map((c) => c.id) };
	},

	'essentialSound.set': (doc, cmd: CommandOf<'essentialSound.set'>, h) => {
		const { seq, clips } = audioClips(doc, idList(cmd.clipIds), h);
		const entries = Object.entries(cmd.values);
		if (entries.length === 0) h.fail('E_INVALID_PARAM', 'values is empty');
		for (const c of clips) {
			const cur = readEssentialSound(c.essential);
			if (!cur)
				h.fail('E_INVALID_PARAM', `Clip ${c.id} has no audio type; set one first (essentialSound.setType)`, {
					path: [c.id],
				});
			let next = cur!;
			for (const [k, v] of entries) next = tryValue(() => setEssentialValue(next, k, v), h, c.id);
			update(c, next, timeIn(seq, c, cmd.at, h), h);
		}
		return { clips: clips.map((c) => c.id) };
	},

	'essentialSound.applyPreset': (doc, cmd: CommandOf<'essentialSound.applyPreset'>, h) => {
		if (!cmd.preset === !cmd.settings)
			h.fail('E_INVALID_PARAM', 'Give exactly one of preset (a built-in name) or settings');
		const { seq, clips } = audioClips(doc, idList(cmd.clipIds), h);
		const builtins = builtinEssentialPresets();
		for (const c of clips) {
			const cur = readEssentialSound(c.essential);
			let preset: { name: string; settings: EssentialSound };
			if (cmd.settings) {
				const s = readEssentialSound({ ...cmd.settings, ...(cmd.audioType ? { type: cmd.audioType } : {}) });
				if (!s) h.fail('E_INVALID_PARAM', 'settings need a valid "type" (dialogue, music, sfx, ambience)');
				preset = {
					name:
						typeof cmd.settings.preset === 'string' && cmd.settings.preset ? cmd.settings.preset : 'Custom',
					settings: s!,
				};
			} else {
				const type = cmd.audioType ?? cur?.type;
				if (!type)
					h.fail('E_INVALID_PARAM', `Clip ${c.id} has no audio type; pass "audioType"`, { path: [c.id] });
				const found = builtins.find(
					(p) => p.type === type && p.name.toLowerCase() === cmd.preset!.toLowerCase(),
				);
				if (!found)
					h.fail(
						'E_INVALID_PARAM',
						`No ${type} preset "${cmd.preset}" (${builtins
							.filter((p) => p.type === type)
							.map((p) => p.name)
							.join(', ')})`,
					);
				preset = found!;
			}
			update(c, withPreset(cur, preset), timeIn(seq, c, cmd.at, h), h);
		}
		return { clips: clips.map((c) => c.id) };
	},

	'essentialSound.autoMatch': (doc, cmd: CommandOf<'essentialSound.autoMatch'>, h) => {
		const ids = Object.keys(cmd.measuredLufs);
		if (ids.length === 0) h.fail('E_INVALID_PARAM', 'measuredLufs is empty');
		const { seq, clips } = audioClips(doc, ids, h);
		const out: Record<string, { gainDb: number } | { skipped: string }> = {};
		for (const c of clips) {
			const cur = readEssentialSound(c.essential);
			if (!cur) {
				out[c.id] = { skipped: 'no audio type' };
				continue;
			}
			const measured = cmd.measuredLufs[c.id];
			if (measured === null || measured === undefined || !Number.isFinite(measured)) {
				out[c.id] = { skipped: 'silent' };
				continue;
			}
			const target = cmd.targetLufs ?? cur.loudness.targetLufs ?? DEFAULT_LOUDNESS_TARGET;
			// The clip gain applies linearly after the effects: the user's own gain (without the previous match) counts.
			const userGain = c.gainDb - (cur.loudness.enabled ? cur.loudness.gainDb : 0);
			const gainDb = Math.min(Math.max(target - measured - userGain, -96), 96);
			const next: EssentialSound = {
				...cur,
				loudness: { enabled: true, measuredLufs: measured, targetLufs: target, gainDb },
			};
			update(c, next, timeIn(seq, c, undefined, h), h);
			out[c.id] = { gainDb: Math.round(gainDb * 1000) / 1000 };
		}
		return { clips: out };
	},

	'clip.remix': (doc, cmd: CommandOf<'clip.remix'>, h) => {
		const found = h.clip(doc, cmd.clipId);
		const seq = found.seq;
		let clip = found.clip as DAudio;
		if (clip.kind !== 'audio') h.fail('E_INVALID_PARAM', 'Remix works on audio clips (music)');
		const track = findTrackIn(seq, clip.trackId)!.track;
		assertUnlocked(track, h);
		if (clip.speed.rate !== 1 || clip.speed.reverse)
			h.fail('E_INVALID_PARAM', 'Remix needs a clip at 100 % speed, not reversed (reset its speed first)');
		if (clip.linkId) h.fail('E_INVALID_PARAM', 'Unlink the clip from its video before remixing it');
		const rate = seq.settings.frameRate as Rational;
		const F = flicksPerFrame(rate);
		const frameSec = rate.den / rate.num;
		// A remixed clip is remixed again from its original.
		const previous = clip.remix ? plain(clip.remix) : null;
		if (previous) clip = revertRemix(seq, clip, h);
		const original = { start: clip.start, duration: clip.duration, sourceIn: clip.sourceIn };
		const target = cmd.targetFrames;
		// Room on the track: [start, start + target) must be free except for this clip.
		for (const o of trackClips(seq, clip.trackId))
			if (o.id !== clip.id && o.start < clip.start + target && end(o) > clip.start)
				h.fail(
					'E_OVERLAP',
					`The remix (${target} frames) would overlap clip ${o.id} on the track; make room first`,
					{
						blocking: [o.id],
					},
				);
		const maxContent = original.duration * F; // flicks of source the clip may use (its in…out range)
		// Output cut points in frames; each piece's source start is shifted by the cut's rounding so the jump offsets
		// (whole beats) stay exact.
		const pieces = cmd.pieces;
		let outSec = 0;
		const cuts: number[] = [0];
		for (const p of pieces) {
			outSec += p.lenSeconds;
			cuts.push(Math.round(outSec / frameSec));
		}
		cuts[cuts.length - 1] = target;
		const made: DAudio[] = [];
		const remixId = h.ids.next('grp');
		const base = plain(clip) as AudioClip;
		let outAcc = 0;
		for (let k = 0; k < pieces.length; k++) {
			const p = pieces[k]!;
			const f0 = cuts[k]!;
			const f1 = cuts[k + 1]!;
			const exactOut = outAcc;
			outAcc += p.lenSeconds;
			if (f1 <= f0) continue;
			const delta = f0 * frameSec - exactOut;
			let srcIn = Math.round(secondsToFlicks(Math.max(0, p.srcSeconds + delta)));
			srcIn = Math.min(srcIn, Math.max(0, maxContent - (f1 - f0) * F));
			const piece = (made.length === 0 ? clip : (plain(base) as unknown as DAudio)) as DAudio;
			if (made.length > 0) {
				piece.id = h.ids.next('clp');
				reidentifyClipChildren(piece as unknown as Clip, h);
				seq.clips[piece.id] = piece as never;
			}
			piece.start = original.start + f0;
			piece.duration = f1 - f0;
			piece.sourceIn = original.sourceIn + srcIn;
			made.push(piece);
		}
		if (made.length === 0) h.fail('E_INVALID_PARAM', 'The remix plan has no pieces');
		const info = (i: number): ClipRemix => ({
			id: remixId,
			index: i,
			count: made.length,
			original,
			targetFrames: target,
			segments: cmd.segments ?? previous?.segments ?? 50,
			variations: cmd.variations ?? previous?.variations ?? 50,
			bpm: cmd.bpm,
		});
		const baseName = base.name.replace(/ \(Remix \d+\/\d+\)$/, '');
		made.forEach((c, i) => {
			c.remix = info(i) as never;
			c.name = made.length > 1 ? `${baseName} (Remix ${i + 1}/${made.length})` : baseName;
			if (made.length > 1) c.groupId = remixId;
		});
		if (made.length > 1) seq.groups[remixId] = { id: remixId, members: made.map((c) => c.id) };
		// Essential Sound ▸ Duration follows the Remix tool: the target and settings the remix was made with.
		for (const c of made) {
			const es = readEssentialSound(c.essential);
			if (!es) continue;
			es.duration = {
				...es.duration,
				method: 'remix',
				targetSeconds: Math.round(target * frameSec * 100) / 100,
				segments: info(0).segments,
				variations: info(0).variations,
			};
			c.essential = es as never;
		}
		// A fade-out of the original follows the last piece.
		const lastPiece = made[made.length - 1]!;
		for (const t of Object.values(seq.transitions))
			if (t.outgoingClipId === clip.id && !t.incomingClipId && lastPiece.id !== clip.id)
				t.outgoingClipId = lastPiece.id;
		// Constant-power crossfades centred on the joints (shortened to the media handles when needed).
		const xf = cmd.crossfadeFrames ?? 1;
		const addTransition = transitionHandlers['transition.add']!;
		for (let i = 1; i < made.length; i++)
			addTransition(
				doc,
				{
					type: 'transition.add',
					sequenceId: seq.id,
					trackId: clip.trackId,
					at: made[i]!.start,
					effectId: 'jasper.constant-power',
					duration: xf,
					alignment: 'center',
				},
				h,
			);
		return { clipIds: made.map((c) => c.id), pieces: made.length, targetFrames: target, remixId };
	},

	'clip.remixRevert': (doc, cmd: CommandOf<'clip.remixRevert'>, h) => {
		const { seq, clip } = h.clip(doc, cmd.clipId);
		if (clip.kind !== 'audio' || !(clip as DAudio).remix)
			h.fail('E_INVALID_PARAM', `Clip ${cmd.clipId} is not part of a remix`);
		assertUnlocked(findTrackIn(seq, clip.trackId)!.track, h);
		const restored = revertRemix(seq, clip as DAudio, h);
		// The original span must still be free.
		for (const o of trackClips(seq, restored.trackId))
			if (o.id !== restored.id && o.start < end(restored) && end(o) > restored.start)
				h.fail('E_OVERLAP', `The original clip would overlap clip ${o.id}; make room first`, {
					blocking: [o.id],
				});
		return { clipId: restored.id };
	},
};
