import type { Draft } from 'immer';
import { contentTimeAt } from '../../derive/index.ts';
import {
	type AudioType,
	builtinEssentialPresets,
	DEFAULT_LOUDNESS_TARGET,
	type EssentialSound,
	EssentialSoundError,
	migrateLegacyPan,
	newEssentialSound,
	parseEssentialSound,
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
import { type HandlerMap, idList, clone as plain } from './util.ts';

export const ESSENTIAL_OWNER = 'audio-fx' as const;

type DAudio = Draft<AudioClip>;

function audioClips(doc: DDoc, ids: readonly string[], h: HandlerContext): { seq: DSeq; clips: DAudio[] } {
	const { seq, clips } = h.clipsOf(doc, ids);
	for (const c of clips) {
		if (c.kind !== 'audio')
			h.fail('E_INVALID_PARAM', `${c.id} is not an audio clip (Essential Sound works on audio clips)`, {
				path: [c.id],
			});
		assertUnlocked(findTrackIn(seq, c.trackId)!.track, h);
		// settings saved before Pan became an offset are read the way they were written (load does this too)
		migrateLegacyPan(c as never);
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
	migrateLegacyPan(clip as never);
	const old = readEssentialSound(clip.essential);
	const residual = {
		volume: { ...(old?.residual?.volume ?? {}) },
		pan: { ...(old?.residual?.pan ?? {}) },
	};
	reconcileEssential(clip as never, old, next, {
		time,
		residual,
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
	if (next) {
		// Residuals of values that no longer exist (deleted keyframes) are dropped.
		const live = new Set([
			'value',
			...clip.volumeDb.keyframes.map((k) => k.id),
			...clip.pan.keyframes.map((k) => k.id),
		]);
		const keep = (r: Record<string, number>) =>
			Object.fromEntries(Object.entries(r).filter(([k]) => live.has(k)));
		const r = { volume: keep(residual.volume), pan: keep(residual.pan) };
		const stored = { ...next } as EssentialSound;
		if (Object.keys(r.volume).length + Object.keys(r.pan).length > 0) stored.residual = r;
		else delete stored.residual;
		clip.essential = stored as never;
	} else delete clip.essential;
}

function tryValue<T>(f: () => T, h: HandlerContext, clipId: string): T {
	try {
		return f();
	} catch (e) {
		if (e instanceof EssentialSoundError) return h.fail('E_INVALID_PARAM', e.message, { path: [clipId] });
		throw e;
	}
}

const end = (c: { start: number; duration: number }) => c.start + c.duration;
/** Shortest remix joint crossfade (s): the frames of it, at least one (Sound Check's chopped-decay fade). */
export const REMIX_MIN_CROSSFADE_S = 0.03;

/** The pieces of the remix a clip belongs to (sorted by start), or just the clip. */
function remixPieces(seq: DSeq, clip: DClip): DAudio[] {
	const r = (clip as DAudio).remix;
	if (!r) return [clip as DAudio];
	return (
		Object.values(seq.clips).filter((c) => c.kind === 'audio' && (c as DAudio).remix?.id === r.id) as DAudio[]
	).sort((a, b) => a.start - b.start);
}

/** Replaces a remix's pieces by the original clip (the first piece keeps its id); returns the restored clip. */
function revertRemix(seq: DSeq, clip: DAudio, h: HandlerContext): DAudio {
	const pieces = remixPieces(seq, clip);
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
	// P6-E11: the fade-in the remix added over a trimmed intro goes with it
	const fadeIn = typeof info.fadeInId === 'string' ? seq.transitions[info.fadeInId] : undefined;
	if (fadeIn && fadeIn.incomingClipId === first.id && !fadeIn.outgoingClipId)
		delete seq.transitions[fadeIn.id];
	first.start = info.original.start;
	first.duration = info.original.duration;
	first.sourceIn = info.original.sourceIn;
	first.name = first.name.replace(/ \(Remix \d+\/\d+\)$/, '');
	if (first.groupId === info.id) first.groupId = null;
	delete first.remix;
	cleanupSequence(seq, h);
	return first;
}

export const essentialHandlers = {
	'essentialSound.setType': (doc, cmd: CommandOf<'essentialSound.setType'>, h) => {
		const { seq, clips } = audioClips(doc, idList(cmd.clipIds), h);
		const confirmed: string[] = [];
		for (const c of clips) {
			const cur = readEssentialSound(c.essential);
			if (cur?.type === cmd.audioType) {
				// the user chose the type Auto Tag gave: the tag is confirmed (settings untouched)
				if (cur.tagged) {
					const { tagged: _t, ...rest } = cur;
					update(c, rest as EssentialSound, timeIn(seq, c, undefined, h), h);
					confirmed.push(c.id);
				}
				continue;
			}
			update(c, newEssentialSound(cmd.audioType as AudioType), timeIn(seq, c, undefined, h), h);
		}
		return {
			clips: clips.map((c) => c.id),
			audioType: cmd.audioType,
			...(confirmed.length ? { confirmed } : {}),
		};
	},

	'essentialSound.autoTag': (doc, cmd: CommandOf<'essentialSound.autoTag'>, h) => {
		const ids = Object.keys(cmd.results);
		const { seq, clips } = audioClips(doc, ids, h);
		const min = cmd.minConfidence ?? 0;
		const tagged: { clipId: string; audioType: AudioType; confidence: number; from: AudioType | null }[] = [];
		const skipped: { clipId: string; code: 'USER_TYPE' | 'SAME' | 'LOW_CONFIDENCE'; reason: string }[] = [];
		for (const c of clips) {
			const r = cmd.results[c.id]!;
			const cur = readEssentialSound(c.essential);
			const type = r.category as AudioType;
			if (r.confidence < min) {
				skipped.push({
					clipId: c.id,
					code: 'LOW_CONFIDENCE',
					reason: `${type} at ${Math.round(r.confidence * 100)} % confidence is under ${Math.round(min * 100)} %`,
				});
				continue;
			}
			if (cur && !cur.tagged && !cmd.force) {
				skipped.push({
					clipId: c.id,
					code: cur.type === type ? 'SAME' : 'USER_TYPE',
					reason:
						cur.type === type
							? `already ${cur.type}`
							: `the audio type ${cur.type} was set by hand (pass force to replace it)`,
				});
				continue;
			}
			if (cur && !cur.tagged && cur.type === type) {
				skipped.push({ clipId: c.id, code: 'SAME', reason: `already ${cur.type}` });
				continue;
			}
			const mark = {
				by: 'auto' as const,
				confidence: Math.round(r.confidence * 1000) / 1000,
				...(r.scores ? { scores: { ...r.scores } } : {}),
				...(r.reasons ? { reasons: r.reasons.slice(0, 6) } : {}),
			};
			// re-tagged as the same type: the settings stay, only the mark is refreshed
			const next: EssentialSound =
				cur?.type === type ? { ...cur, tagged: mark } : { ...newEssentialSound(type), tagged: mark };
			update(c, next, timeIn(seq, c, undefined, h), h);
			tagged.push({ clipId: c.id, audioType: type, confidence: mark.confidence, from: cur?.type ?? null });
		}
		return { tagged, skipped };
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
			// a Ducking amount set here is the user's own (a delivery preset leaves it alone)
			if (Object.hasOwn(cmd.values, 'ducking.reduceDb') || Object.hasOwn(cmd.values, 'ducking'))
				next = { ...next, ducking: { ...next.ducking, depthBy: 'user' } } as EssentialSound;
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
				const { residual: _r, ...given } = cmd.settings;
				const s = parseEssentialSound({ ...given, ...(cmd.audioType ? { type: cmd.audioType } : {}) });
				if (typeof s === 'string') return h.fail('E_INVALID_PARAM', s);
				preset = {
					name:
						typeof cmd.settings.preset === 'string' && cmd.settings.preset ? cmd.settings.preset : 'Custom',
					settings: s,
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
				// No integrated loudness: silence, or a clip shorter than one 400 ms BS.1770 gating block.
				const rate = seq.settings.frameRate as Rational;
				const short = (c.duration * rate.den) / rate.num < 0.4;
				out[c.id] = { skipped: short ? 'shorter than 400 ms (integrated loudness is undefined)' : 'silent' };
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
		// P6-E11: what the plan landed must lie inside the remix
		for (const an of cmd.anchors ?? [])
			if (an.frame < original.start || an.frame >= original.start + target)
				h.fail(
					'E_INVALID_PARAM',
					`An anchor lands at frame ${an.frame}, outside the remix (frames ${original.start}–${original.start + target - 1})`,
				);
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
		// (whole beats) stay exact. Cuts round DOWN (P6-E11): the shift then moves both sides of a joint earlier in the
		// source, away from the next beat's attack the plan put the joint before.
		const pieces = cmd.pieces;
		let outSec = 0;
		const cuts: number[] = [0];
		for (const p of pieces) {
			outSec += p.lenSeconds;
			cuts.push(Math.floor(outSec / frameSec + 1e-6));
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
			...(cmd.anchors?.length ? { anchors: cmd.anchors.map((a) => ({ ...a })) } : {}),
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
		// Constant-power crossfades ENDING at the joints (P6-E11: a joint sits just before a beat's attack, so the fade
		// is over before it on both sides; the incoming piece's head handle feeds it, shortened when needed). At least
		// 30 ms: a shorter fade-out is a chopped decay (Sound Check EDGE).
		const xf = cmd.crossfadeFrames ?? Math.max(1, Math.ceil(REMIX_MIN_CROSSFADE_S / frameSec - 1e-9));
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
					duration: cmd.jointCrossfadeFrames?.[i - 1] ?? xf,
					alignment: 'end-at-cut',
				},
				h,
			);
		// P6-E11: a fade-in over an intro the plan trimmed (removed again by Revert Remix)
		if (
			cmd.fadeInFrames &&
			!Object.values(seq.transitions).some((t) => t.incomingClipId === made[0]!.id && !t.outgoingClipId)
		) {
			const r = addTransition(
				doc,
				{
					type: 'transition.add',
					sequenceId: seq.id,
					clipId: made[0]!.id,
					edge: 'in',
					effectId: 'jasper.constant-power',
					duration: Math.min(cmd.fadeInFrames, Math.max(1, made[0]!.duration - 1)),
				},
				h,
			) as { transitionId?: string } | undefined;
			if (r?.transitionId) for (const c of made) (c.remix as { fadeInId?: string }).fadeInId = r.transitionId;
		}
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
} satisfies HandlerMap;
