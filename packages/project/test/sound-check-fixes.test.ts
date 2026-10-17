// Sound Check fixes judged together (`planSoundCheckFixes`; wp-note "WP6.5b → Sound Check"): a safe gain and a safe
// demotion of the same hero overload it together; with normalisation off a safe gain can push the mix's true peak over
// the ceiling; refused, moved / swapped and job fixes; determinism; a property: the accepted fixes apply as ONE
// transaction and never leave a measured sound worse than before them.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyTransaction,
	defaultRegistries,
	type LibraryProvenance,
	MASKED_MIN_LIFT_DB,
	planSoundCheckFixes,
	SOUND_CHECK_CAP_TOLERANCE_LU,
	SOUND_CHECK_MESSAGES,
	type SoundCheckFixCandidate,
	type SoundCheckLevelGuard,
	type SoundCheckLevelModel,
	soundCheckFixCandidates,
	soundCheckFixOrder,
	sfxSolverWeight,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';
import { LIB } from './sound-fixtures.ts';

const registries = defaultRegistries();
const BED_CAP = { hero: 10, support: 6, ambient: 6 } as const;

/** Two heroes 1.5 s apart (frames 40, 85) and a support at 150, on library media; the Mix normalisation optional. */
function fixture(opts: { normalise?: boolean } = {}) {
	const h = new Harness();
	const lib = (id: string, title: string): LibraryProvenance => ({ ...LIB, soundId: id, title, types: ['hit'] });
	const media = (id: string, title: string) =>
		(
			h.ok([
				{ type: 'media.register', asset: { ...videoAsset({ kind: 'audio', seconds: 0.5 }), library: lib(id, title) } },
			]).results[0] as { mediaId: string }
		).mediaId;
	const mA = media('snd_00000000000000a1', 'Hit A');
	const mB = media('snd_00000000000000b2', 'Hit B');
	const mC = media('snd_00000000000000c3', 'Click C');
	const place = (frame: number, weight: 'hero' | 'support', mediaId: string) => {
		const r = h.ok([
			{ type: 'soundCue.add', cues: [{ frame, kind: 'cut', weight, source: 'user', ref: '$c' }] },
			{ type: 'soundDesign.place', cueId: '$c', layers: [{ mediaId, role: weight, ref: '$x' }] },
		]);
		return { cue: r.refs.$c!, clip: r.refs.$x! };
	};
	const A = place(40, 'hero', mA);
	const B = place(85, 'hero', mB);
	const C = place(150, 'support', mC);
	h.ok([{ type: 'mixer.setLoudness', enabled: opts.normalise ?? true, targetLufs: -14, truePeakDb: -1 }]);
	return { h, A, B, C, mA, mB, mC };
}

const gainOf = (h: Harness, doc: unknown, clipId: string) =>
	(doc as typeof h.doc).sequences[h.seqId]!.clips[clipId] as unknown as { gainDb: number };

function model(h: Harness, clipId: string, over: Partial<SoundCheckLevelModel> = {}): SoundCheckLevelModel {
	const c = h.seq.clips[clipId] as unknown as { gainDb: number; start: number; duration: number };
	return {
		clipId,
		title: clipId,
		gainDb: c.gainDb,
		liftAt0Db: 10 - c.gainDb,
		peakOverBedAt0Lu: 2 - c.gainDb,
		truePeakAt0Db: -20 - c.gainDb,
		mixTruePeakDb: null,
		start: c.start,
		end: c.start + c.duration + 15,
		speech: false,
		...over,
	};
}
const guardOf = (levels: SoundCheckLevelModel[], over: Partial<SoundCheckLevelGuard> = {}): SoundCheckLevelGuard => ({
	ceilingDb: -1,
	eventCeilingDb: -1,
	bedCapLu: BED_CAP,
	capToleranceLu: SOUND_CHECK_CAP_TOLERANCE_LU,
	levels,
	...over,
});
const gainFix = (h: Harness, issueId: string, clipId: string, db: number, kind: 'masked' | 'overcap') =>
	({
		issueIds: [issueId],
		kind: 'commands',
		commands: [{ type: 'soundDesign.applyGains', sequenceId: h.seqId, gains: { [clipId]: db } }],
		targets: [{ clipId, kind }],
	}) satisfies SoundCheckFixCandidate;
const demote = (h: Harness, issueId: string, cueId: string, clipId: string) =>
	({
		issueIds: [issueId],
		kind: 'commands',
		commands: [
			{ type: 'soundCue.update', cueId, weight: 'support' },
			{ type: 'soundDesign.setRole', clipIds: [clipId], role: 'support' },
		],
	}) satisfies SoundCheckFixCandidate;

describe('planSoundCheckFixes', () => {
	/** B's gain after `soundDesign.setRole` (the role's default insert level replaces a default or solver gain). */
	const demotedGain = (h: Harness, B: { cue: string; clip: string }) => {
		const r = h.tx(demote(h, 'x', B.cue, B.clip).commands, { dryRun: true });
		expect(r.ok).toBe(true);
		const { document } = applyTransaction(
			h.doc,
			{ label: 'x', origin: 'user', sequenceId: h.seqId, commands: demote(h, 'x', B.cue, B.clip).commands },
			h.ctx(),
		);
		return gainOf(h, document, B.clip).gainDb;
	};

	it('a safe demotion and a safe gain of the same hero: the hero-solved gain would overload the support, so it is skipped', () => {
		const { h, B } = fixture();
		const gB = gainOf(h, h.doc, B.clip).gainDb;
		const gS = demotedGain(h, B);
		// B peaks 12 LU over the bed at its hero default (cap 10 + 0.5): OVERLOAD, the solver brings it to 10 (−2 dB);
		// the demotion alone resets it to the support default (6 dB lower: 6 LU over, under the support cap 6 + 0.5)
		expect(gB - gS).toBeCloseTo(6, 6);
		const mB = model(h, B.clip, { peakOverBedAt0Lu: 12 - gB, liftAt0Db: 12 - gB });
		const guard = guardOf([mB]);
		const candidates = [
			demote(h, 'DENSITY:cueB', B.cue, B.clip),
			gainFix(h, 'OVERLOAD:B', B.clip, gB - 2, 'overcap'),
		];
		// each on its own is safe
		for (const c of candidates)
			expect(planSoundCheckFixes(h.doc, h.seqId, [c], { registries, guard }).accepted).toHaveLength(1);
		const plan = planSoundCheckFixes(h.doc, h.seqId, candidates, { registries, guard });
		expect(plan.accepted.map((c) => c.issueIds[0])).toEqual(['DENSITY:cueB']);
		expect(plan.skipped).toHaveLength(1);
		expect(plan.skipped[0]!.candidate.issueIds).toEqual(['OVERLOAD:B']);
		expect(plan.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixOverCap);
		// the hero's 10 LU over the bed as a support (cap 6): 4.0 over
		expect(plan.skipped[0]!.reason.params).toEqual([`“${B.clip}”`, '4.0', 6]);
		expect(plan.skipped[0]!.conflictsWith).toEqual(['DENSITY:cueB']);
		// one transaction: the demotion only
		expect(plan.commands).toEqual(candidates[0]!.commands);
		expect(h.tx(plan.commands).ok).toBe(true);
		// applied together without the joint judgement, B would end 3.5 LU over the support cap's tolerance
		const { document } = applyTransaction(
			h.doc,
			{ label: 'x', origin: 'user', sequenceId: h.seqId, commands: candidates.flatMap((c) => c.commands) },
			h.ctx(),
		);
		expect(mB.peakOverBedAt0Lu! + gainOf(h, document, B.clip).gainDb).toBeCloseTo(10, 6);
	});

	it('the other order: the demotion resets the solved gain to the support default and leaves it masked: skipped', () => {
		const { h, B } = fixture();
		const gB = gainOf(h, h.doc, B.clip).gainDb;
		const gS = demotedGain(h, B);
		// at the support default B clears the bed by 1 dB (support minimum 1.5): the demotion undoes the gain fix
		const mB = model(h, B.clip, { liftAt0Db: 1 - gS, peakOverBedAt0Lu: 0 - gS });
		const plan = planSoundCheckFixes(
			h.doc,
			h.seqId,
			[gainFix(h, 'MASKED:B', B.clip, gB + (3.5 - (1 - gS + gB)), 'masked'), demote(h, 'DENSITY:cueB', B.cue, B.clip)],
			{ registries, guard: guardOf([mB]) },
		);
		expect(plan.accepted.map((c) => c.issueIds[0])).toEqual(['MASKED:B']);
		expect(plan.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixMasked);
		// the demotion alone would leave B masked too (its support default is 6 dB lower): not safe on its own
		expect(plan.skipped[0]!.conflictsWith).toEqual([]);
		expect(gainOf(h, plan.document, B.clip).gainDb).toBeCloseTo(3.5 - (1 - gS), 6);
	});

	it('a demotion alone that would leave a hand-set loud hero over the support cap is not safe (no conflict named)', () => {
		const { h, B } = fixture();
		// a gain set by hand is kept by the demotion (no default level)
		h.ok([{ type: 'audio.setGain', clipIds: [B.clip], mode: 'set', db: -3 }]);
		expect(demotedGain(h, B)).toBe(-3);
		const guard = guardOf([model(h, B.clip, { peakOverBedAt0Lu: 9.5 + 3 })]);
		const plan = planSoundCheckFixes(h.doc, h.seqId, [demote(h, 'DENSITY:cueB', B.cue, B.clip)], {
			registries,
			guard,
		});
		expect(plan.accepted).toEqual([]);
		expect(plan.skipped[0]!.reason.params).toEqual([`“${B.clip}”`, '3.5', 6]);
		expect(plan.skipped[0]!.conflictsWith).toEqual([]);
		const quiet = guardOf([model(h, B.clip, { peakOverBedAt0Lu: 4 + 3 })]);
		const ok = planSoundCheckFixes(h.doc, h.seqId, [demote(h, 'DENSITY:cueB', B.cue, B.clip)], {
			registries,
			guard: quiet,
		});
		expect(ok.accepted).toHaveLength(1);
		expect(ok.skipped).toEqual([]);
	});

	it('normalisation off: a gain that would push the mix past the ceiling is skipped; with normalisation it is not', () => {
		for (const normalise of [false, true]) {
			const { h, C } = fixture({ normalise });
			const g = gainOf(h, h.doc, C.clip).gainDb;
			// the mix peaks at −1.5 dBTP where C plays; C alone at −10 dBTP; +6 dB → ≤ +1.26 dBTP bound
			const guard = guardOf([
				model(h, C.clip, {
					liftAt0Db: -2 - g,
					peakOverBedAt0Lu: -6 - g,
					truePeakAt0Db: -10 - g,
					mixTruePeakDb: normalise ? null : -1.5,
				}),
			]);
			const plan = planSoundCheckFixes(h.doc, h.seqId, [gainFix(h, 'MASKED:C', C.clip, g + 6, 'masked')], {
				registries,
				guard,
			});
			if (normalise) expect(plan.accepted).toHaveLength(1);
			else {
				expect(plan.accepted).toEqual([]);
				expect(plan.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixMixPeak);
				const bound = 20 * Math.log10(10 ** (-1.5 / 20) + (10 ** (6 / 20) - 1) * 10 ** (-10 / 20));
				expect(plan.skipped[0]!.reason.params).toEqual([
					`“${C.clip}”`,
					(Math.round(bound * 10) / 10).toFixed(1),
					-1,
				]);
			}
		}
	});

	it('normalisation off: two gains that are each under the ceiling add up over it; the second is skipped', () => {
		const { h, A, B } = fixture({ normalise: false });
		const gA = gainOf(h, h.doc, A.clip).gainDb;
		const gB = gainOf(h, h.doc, B.clip).gainDb;
		// both play over one span (overlapping windows), the mix peaks at −4 dBTP there
		const span = { start: 40, end: 100, mixTruePeakDb: -4 };
		const guard = guardOf([
			model(h, A.clip, { ...span, liftAt0Db: 1 - gA, truePeakAt0Db: -9 - gA, peakOverBedAt0Lu: -4 - gA }),
			model(h, B.clip, { ...span, liftAt0Db: 1 - gB, truePeakAt0Db: -9 - gB, peakOverBedAt0Lu: -4 - gB }),
		]);
		// +4 dB on A alone: −4 dBTP ⊕ (10^0.2 − 1)·(−9 dBTP) = −1.77 dBTP — under −1; both: −0.07 dBTP — over
		const plan = planSoundCheckFixes(
			h.doc,
			h.seqId,
			[gainFix(h, 'MASKED:A', A.clip, gA + 4, 'masked'), gainFix(h, 'MASKED:B', B.clip, gB + 4, 'masked')],
			{ registries, guard },
		);
		expect(plan.accepted.map((c) => c.issueIds[0])).toEqual(['MASKED:A']);
		expect(plan.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixMixPeak);
		expect(plan.skipped[0]!.conflictsWith).toEqual(['MASKED:A']);
	});

	it('the sound’s own true peak over the ceiling, a fix that no longer resolves its finding, a refused fix', () => {
		const { h, A, B } = fixture();
		const gA = gainOf(h, h.doc, A.clip).gainDb;
		const guard = guardOf([model(h, A.clip, { truePeakAt0Db: -3 - gA, liftAt0Db: 1 - gA })]);
		const peak = planSoundCheckFixes(h.doc, h.seqId, [gainFix(h, 'MASKED:A', A.clip, gA + 4, 'masked')], {
			registries,
			guard,
		});
		expect(peak.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixEventPeak);
		// +1 dB lifts A to 2 dB: still under the hero's 3 dB → does not resolve MASKED
		const weak = planSoundCheckFixes(h.doc, h.seqId, [gainFix(h, 'MASKED:A', A.clip, gA + 1, 'masked')], {
			registries,
			guard: guardOf([model(h, A.clip, { liftAt0Db: 1 - gA })]),
		});
		expect(weak.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixUnresolved);
		// a clip deleted since the check: its gain fix is refused, the others go on
		h.ok([{ type: 'clip.lift', clipIds: [B.clip] }]);
		const refused = planSoundCheckFixes(
			h.doc,
			h.seqId,
			[gainFix(h, 'OVERLOAD:B', B.clip, 0, 'overcap'), gainFix(h, 'MASKED:A', A.clip, gA + 2.5, 'masked')],
			{ registries, guard: guardOf([model(h, A.clip, { liftAt0Db: 1 - gA })]) },
		);
		expect(refused.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixRefused);
		expect(refused.accepted.map((c) => c.issueIds[0])).toEqual(['MASKED:A']);
	});

	it('a gain and a swap / move of the same clip: the later one waits for the next check', () => {
		const { h, A, mB } = fixture();
		const gA = gainOf(h, h.doc, A.clip).gainDb;
		const guard = guardOf([model(h, A.clip, { liftAt0Db: 1 - gA })]);
		const gain = gainFix(h, 'MASKED:A', A.clip, gA + 3, 'masked');
		// a swap to another sound (registered at apply time: judged without commands)
		const swap: SoundCheckFixCandidate = {
			issueIds: ['LICENSE:A'],
			kind: 'swap',
			commands: null,
			swap: { clipId: A.clip, soundId: 'snd_00000000000000ff' },
		};
		const p1 = planSoundCheckFixes(h.doc, h.seqId, [swap, gain], { registries, guard });
		// commands first (the order fixes are applied in), so the gain is kept and the swap waits
		expect(p1.accepted.map((c) => c.issueIds[0])).toEqual(['MASKED:A']);
		expect(p1.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixSoundChanged);
		expect(p1.skipped[0]!.conflictsWith).toEqual(['MASKED:A']);
		// a swap to its own sound (re-registered copy with trailing silence) keeps the level model
		const own: SoundCheckFixCandidate = { ...swap, issueIds: ['TRUNCATED:A'], swap: { clipId: A.clip, soundId: 'snd_00000000000000a1' } };
		expect(planSoundCheckFixes(h.doc, h.seqId, [gain, own], { registries, guard }).accepted).toHaveLength(2);
		// a move (soundDesign.swap at the cue) before the gain: the gain was measured where the clip was
		const move: SoundCheckFixCandidate = {
			issueIds: ['OUT_OF_SYNC:A'],
			kind: 'commands',
			commands: [{ type: 'soundDesign.swap', clipId: A.clip, mediaId: mB, frame: 42 }],
		};
		const p2 = planSoundCheckFixes(h.doc, h.seqId, [move, gain], { registries, guard });
		expect(p2.accepted.map((c) => c.issueIds[0])).toEqual(['OUT_OF_SYNC:A']);
		expect(p2.skipped[0]!.conflictsWith).toEqual(['OUT_OF_SYNC:A']);
	});

	it('jobs: ducking after a gain change over the speech waits; without one it goes', () => {
		const { h, C } = fixture();
		const g = gainOf(h, h.doc, C.clip).gainDb;
		const guard = guardOf([model(h, C.clip, { liftAt0Db: -1 - g, speech: true })]);
		const duck: SoundCheckFixCandidate = {
			issueIds: ['MUSIC_OVER_VOICE:0'],
			kind: 'job',
			commands: null,
			job: { route: 'delivery' },
		};
		const p = planSoundCheckFixes(h.doc, h.seqId, [duck, gainFix(h, 'MASKED:C', C.clip, g + 4, 'masked')], {
			registries,
			guard,
		});
		expect(p.accepted.map((c) => c.issueIds[0])).toEqual(['MASKED:C']);
		expect(p.skipped[0]!.reason.key).toBe(SOUND_CHECK_MESSAGES.whyFixBedChanged);
		expect(planSoundCheckFixes(h.doc, h.seqId, [duck], { registries, guard }).accepted).toEqual([duck]);
	});

	it('candidates: a fix two findings share is one; order is commands, swaps, jobs; a prelude only with a swap', () => {
		const { h, A, mB } = fixture();
		const loud = { type: 'mixer.setLoudness', sequenceId: h.seqId, enabled: true, targetLufs: -14, truePeakDb: -1 };
		const cands = soundCheckFixCandidates(
			[
				{ id: 'LOUDNESS:mix', code: 'LOUDNESS', fix: { kind: 'commands', safe: true, commands: [loud] } },
				{ id: 'TRUE_PEAK:mix', code: 'TRUE_PEAK', fix: { kind: 'commands', safe: true, commands: [loud] } },
				{ id: 'X:job', code: 'MUSIC_OVER_VOICE', fix: { kind: 'job', safe: true, job: { route: 'delivery', body: {} } } },
				{ id: 'R:A', code: 'REPEAT', fix: { kind: 'swap', safe: true, swap: { clipId: A.clip, soundId: 's' } } },
				{ id: 'L:A', code: 'LICENSE', fix: { kind: 'swap', safe: true, swap: { clipId: A.clip, soundId: 's' } } },
				{ id: 'S:x', code: 'SILENCE', fix: { kind: 'commands', safe: false, commands: [loud] } },
			],
			{ safeOnly: true },
		);
		expect(cands.map((c) => c.issueIds)).toEqual([['LOUDNESS:mix', 'TRUE_PEAK:mix'], ['X:job'], ['R:A', 'L:A']]);
		expect(soundCheckFixOrder(cands).map((c) => c.kind)).toEqual(['commands', 'swap', 'job']);
		// a registered swap: the prelude registers the media under a ref the swap uses
		const prelude = [
			{
				type: 'media.register',
				asset: { ...videoAsset({ kind: 'audio', seconds: 0.5 }), library: { ...LIB, soundId: 'snd_00000000000000d4' } },
				ref: '$chk0',
			},
		];
		const swap: SoundCheckFixCandidate = {
			issueIds: ['L:A'],
			kind: 'swap',
			commands: [{ type: 'soundDesign.swap', clipId: A.clip, mediaId: '$chk0' }],
		};
		const p = planSoundCheckFixes(h.doc, h.seqId, [swap, { issueIds: ['LOUDNESS:mix'], kind: 'commands', commands: [loud] }], {
			registries,
			prelude,
		});
		expect(p.accepted).toHaveLength(2);
		expect(p.commands.map((c) => c.type)).toEqual(['media.register', 'mixer.setLoudness', 'soundDesign.swap']);
		expect(h.tx(p.commands).ok).toBe(true);
		// no swap accepted → no prelude
		const q = planSoundCheckFixes(h.doc, h.seqId, [{ issueIds: ['M'], kind: 'commands', commands: [{ type: 'soundDesign.swap', clipId: A.clip, mediaId: mB }] }], {
			registries,
			prelude,
		});
		expect(q.commands.map((c) => c.type)).toEqual(['soundDesign.swap']);
	});

	it('property: deterministic; the accepted fixes apply as ONE transaction and leave no measured sound worse', () => {
		const { h, A, B, C } = fixture({ normalise: false });
		const clips = [A, B, C];
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						lift: fc.double({ min: -10, max: 15, noNaN: true }),
						peak: fc.double({ min: -10, max: 15, noNaN: true }),
						tp: fc.double({ min: -30, max: 0, noNaN: true }),
						mix: fc.option(fc.double({ min: -12, max: 0, noNaN: true }), { nil: null }),
						speech: fc.boolean(),
					}),
					{ minLength: 3, maxLength: 3 },
				),
				fc.array(
					fc.record({
						clip: fc.integer({ min: 0, max: 2 }),
						op: fc.constantFrom('gain', 'demote', 'promote', 'job', 'swap'),
						db: fc.double({ min: -12, max: 12, noNaN: true }),
					}),
					{ maxLength: 8 },
				),
				(ms, ops) => {
					const levels = ms.map((m, i) => {
						const c = clips[i]!;
						const g = gainOf(h, h.doc, c.clip).gainDb;
						return model(h, c.clip, {
							liftAt0Db: m.lift - g,
							peakOverBedAt0Lu: m.peak - g,
							truePeakAt0Db: m.tp - g,
							mixTruePeakDb: m.mix,
							speech: m.speech,
							start: 0,
							end: 300,
						});
					});
					const guard = guardOf(levels);
					const cands: SoundCheckFixCandidate[] = ops.map((o, i) => {
						const c = clips[o.clip]!;
						const id = `F${i}`;
						if (o.op === 'gain')
							return { issueIds: [id], kind: 'commands', commands: [{ type: 'soundDesign.applyGains', gains: { [c.clip]: Math.round(o.db * 100) / 100 } }] };
						if (o.op === 'demote' || o.op === 'promote')
							return {
								issueIds: [id],
								kind: 'commands',
								commands: [{ type: 'soundDesign.setRole', clipIds: [c.clip], role: o.op === 'demote' ? 'support' : 'hero' }],
							};
						if (o.op === 'job') return { issueIds: [id], kind: 'job', commands: null, job: { route: 'delivery' } };
						return { issueIds: [id], kind: 'swap', commands: null, swap: { clipId: c.clip, soundId: `snd_${o.clip}` } };
					});
					const p1 = planSoundCheckFixes(h.doc, h.seqId, cands, { registries, guard });
					const p2 = planSoundCheckFixes(h.doc, h.seqId, cands, { registries, guard });
					expect(p2.accepted.map((c) => c.issueIds)).toEqual(p1.accepted.map((c) => c.issueIds));
					expect(p1.accepted.length + p1.skipped.length).toBe(cands.length);
					const r = h.tx(p1.commands, { dryRun: true });
					expect(r.ok).toBe(true);
					// oracle: every limit at the end is no further off than before any fix
					const mags = (doc: typeof h.doc) => {
						const off = !(doc.sequences[h.seqId]!.master as { loudness?: { enabled?: boolean } }).loudness?.enabled;
						return levels.map((m) => {
							const c = doc.sequences[h.seqId]!.clips[m.clipId] as unknown as { gainDb: number; sfx?: { role?: string } };
							const w = sfxSolverWeight((c.sfx?.role as 'hero') ?? null, ['hit']);
							const g = c.gainDb;
							let lin = 10 ** (m.mixTruePeakDb! / 20);
							for (const o of levels) {
								const oc = doc.sequences[h.seqId]!.clips[o.clipId] as unknown as { gainDb: number };
								const d = oc.gainDb - o.gainDb;
								if (d > 0.005) lin += (10 ** (d / 20) - 1) * 10 ** ((o.truePeakAt0Db! + o.gainDb) / 20);
							}
							return [
								Math.max(0, m.peakOverBedAt0Lu! + g - (BED_CAP[w] + 0.5)),
								w === 'ambient' ? 0 : Math.max(0, MASKED_MIN_LIFT_DB[w] - (m.liftAt0Db! + g)),
								Math.max(0, m.truePeakAt0Db! + g + 1),
								off && m.mixTruePeakDb !== null ? Math.max(0, 20 * Math.log10(lin) + 1) : 0,
							];
						});
					};
					const before = mags(h.doc);
					const after = mags(p1.document);
					after.forEach((row, i) =>
						row.forEach((x, k) => expect(x).toBeLessThanOrEqual(before[i]![k]! + 0.02)),
					);
				},
			),
			{ numRuns: 300 },
		);
	});
});
