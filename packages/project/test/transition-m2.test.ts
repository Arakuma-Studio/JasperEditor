import { describe, expect, it } from 'vitest';
import { checkInvariants, type Transition } from '../src/index.ts';
import { Harness } from './helpers.ts';

/** Two adjacent video clips with audio (linked), cut at frame 100, with 30+ frames of handles on each side. */
function twoLinkedClips() {
	const h = new Harness();
	const a = h.registerVideo({ audio: true });
	const b = h.registerVideo({ audio: true });
	const r = h.ok([
		{
			type: 'clip.place',
			source: { mediaId: a },
			at: 0,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
			ref: '$a',
		},
		{
			type: 'clip.place',
			source: { mediaId: b },
			at: 100,
			sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
			ref: '$b',
		},
	]);
	const [va, aa] = (r.results[0] as { clipIds: string[] }).clipIds as [string, string];
	const [vb, ab] = (r.results[1] as { clipIds: string[] }).clipIds as [string, string];
	return { h, va, aa, vb, ab };
}
const transitions = (h: Harness) => Object.values(h.seq.transitions) as Transition[];

describe('transition.update {effectId} (TUI-050)', () => {
	const cases: {
		name: string;
		from: string;
		to: string;
		audio?: boolean;
		code?: string;
	}[] = [
		{ name: 'cross dissolve → dip to black', from: 'jasper.cross-dissolve', to: 'jasper.dip-to-black' },
		{ name: 'dip to black → cross dissolve', from: 'jasper.dip-to-black', to: 'jasper.cross-dissolve' },
		{ name: 'same type is a no-op', from: 'jasper.cross-dissolve', to: 'jasper.cross-dissolve' },
		{
			name: 'video → audio refused',
			from: 'jasper.cross-dissolve',
			to: 'jasper.constant-power',
			code: 'E_TRACK_KIND',
		},
		{
			name: 'audio → video refused',
			from: 'jasper.constant-gain',
			to: 'jasper.dip-to-black',
			audio: true,
			code: 'E_TRACK_KIND',
		},
		{
			name: 'audio → audio',
			from: 'jasper.constant-gain',
			to: 'jasper.constant-power',
			audio: true,
		},
		{
			name: 'unknown id',
			from: 'jasper.cross-dissolve',
			to: 'jasper.not-a-transition',
			code: 'E_UNKNOWN_EFFECT',
		},
	];
	for (const c of cases) {
		it(c.name, () => {
			const { h, va, aa } = twoLinkedClips();
			const add = h.ok([
				{
					type: 'transition.add',
					clipId: c.audio ? aa : va,
					edge: 'out',
					effectId: c.from,
					duration: 12,
					ref: '$t',
				},
			]);
			const id = add.refs.$t!;
			const r = h.tx([{ type: 'transition.update', transitionId: id, effectId: c.to }]);
			if (c.code) {
				expect(r.ok).toBe(false);
				if (!r.ok) expect(r.errors[0]!.code).toBe(c.code);
				expect(h.seq.transitions[id]!.effectId).toBe(c.from);
				return;
			}
			expect(r.ok).toBe(true);
			if (r.ok) expect(r.results[0]).toMatchObject({ transitionId: id, effectId: c.to, duration: 12 });
			expect(h.seq.transitions[id]).toMatchObject({ effectId: c.to, effectVersion: 1, duration: 12 });
			expect(checkInvariants(h.doc)).toEqual([]);
		});
	}

	it('re-fits the duration when the new type needs other handles', () => {
		// Clips that use all of their media: no handles. A centred dip to black fits (each clip fades on its
		// own frames); a centred cross dissolve needs handles on both sides and is refused.
		const h = new Harness();
		const m = h.registerVideo({ seconds: 2, audio: false });
		const q = h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 0, ref: '$a' },
			{ type: 'clip.place', source: { mediaId: m }, at: 60, ref: '$b' },
		]);
		const t = h.ok([
			{
				type: 'transition.add',
				clipId: q.refs.$b,
				edge: 'in',
				effectId: 'jasper.dip-to-black',
				duration: 12,
				ref: '$t',
			},
		]).refs.$t!;
		const r = h.tx([{ type: 'transition.update', transitionId: t, effectId: 'jasper.cross-dissolve' }]);
		expect(r.ok === false && r.errors[0]!.code).toBe('E_OUT_OF_MEDIA');
		// …but as start-at-cut with a short tail handle it fits, shortened.
		const h2 = new Harness();
		const m2 = h2.registerVideo({ seconds: 4, audio: false });
		const q2 = h2.ok([
			{
				type: 'clip.place',
				source: { mediaId: m2 },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 115 } },
				ref: '$a',
			},
			{ type: 'clip.place', source: { mediaId: m2 }, at: 115, ref: '$b' },
		]);
		const t2 = h2.ok([
			{
				type: 'transition.add',
				clipId: q2.refs.$b,
				edge: 'in',
				effectId: 'jasper.dip-to-black',
				duration: 12,
				alignment: 'start-at-cut',
				ref: '$t',
			},
		]).refs.$t!;
		const r2 = h2.ok([{ type: 'transition.update', transitionId: t2, effectId: 'jasper.cross-dissolve' }]);
		expect(r2.results[0]).toMatchObject({ effectId: 'jasper.cross-dissolve', duration: 5 });
		expect(r2.warnings.map((w) => w.code)).toEqual(['W_TRANSITION_SHORTENED']);
	});
});

describe('transition.applyDefault M2 fields (TUI-051)', () => {
	const table: {
		name: string;
		args: Record<string, unknown>;
		clips: ('va' | 'vb' | 'aa' | 'ab')[];
		expect: { effectId: string; count: number; duration: number; kinds: ('video' | 'audio')[] }[];
		code?: string;
	}[] = [
		{
			name: 'media [video, audio], custom effects and duration',
			args: {
				media: ['video', 'audio'],
				edges: 'in',
				videoEffectId: 'jasper.dip-to-black',
				audioEffectId: 'jasper.constant-gain',
				duration: 10,
			},
			clips: ['va', 'vb', 'aa', 'ab'],
			expect: [
				{ effectId: 'jasper.dip-to-black', count: 2, duration: 10, kinds: ['video'] },
				{ effectId: 'jasper.constant-gain', count: 2, duration: 10, kinds: ['audio'] },
			],
		},
		{
			name: 'a video id as the audio default is refused',
			args: { media: ['audio'], edges: 'both', audioEffectId: 'jasper.cross-dissolve' },
			clips: ['aa'],
			expect: [],
			code: 'E_TRACK_KIND',
		},
		{
			name: 'unknown video default',
			args: { edges: 'both', videoEffectId: 'jasper.not-a-transition' },
			clips: ['va'],
			expect: [],
			code: 'E_UNKNOWN_EFFECT',
		},
		{
			name: 'audio clips are ignored when media is video only',
			args: { edges: 'out' },
			clips: ['aa', 'ab'],
			expect: [],
		},
	];
	for (const c of table) {
		it(c.name, () => {
			const env = twoLinkedClips();
			const { h } = env;
			const r = h.tx([{ type: 'transition.applyDefault', clipIds: c.clips.map((k) => env[k]), ...c.args }]);
			if (c.code) {
				expect(r.ok === false && r.errors[0]!.code).toBe(c.code);
				return;
			}
			expect(r.ok).toBe(true);
			const all = transitions(h);
			const kindOf = (t: Transition) =>
				h.seq.videoTracks.some((v) => v.id === t.trackId) ? 'video' : 'audio';
			expect(all).toHaveLength(c.expect.reduce((n, e) => n + e.count, 0));
			for (const e of c.expect) {
				const mine = all.filter((t) => t.effectId === e.effectId);
				expect(mine).toHaveLength(e.count);
				expect(mine.every((t) => t.duration === e.duration && e.kinds.includes(kindOf(t)))).toBe(true);
			}
			expect(checkInvariants(h.doc)).toEqual([]);
		});
	}

	it('skips edit points without room and locked tracks instead of failing', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 2, audio: false });
		const q = h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: 0, ref: '$a' },
			{ type: 'clip.place', source: { mediaId: m }, at: 60, ref: '$b' },
		]);
		// The cut has no handles (cross dissolve refused); the two free edges get fades.
		const r = h.ok([{ type: 'transition.applyDefault', clipIds: [q.refs.$a!, q.refs.$b!], edges: 'both' }]);
		expect((r.results[0] as { transitionIds: string[] }).transitionIds).toHaveLength(2);
		h.ok([{ type: 'transition.remove', transitionIds: transitions(h).map((t) => t.id) }]);
		h.ok([{ type: 'track.update', trackId: h.seq.videoTracks[0]!.id, patch: { locked: true } }]);
		const locked = h.ok([{ type: 'transition.applyDefault', clipIds: [q.refs.$a!], edges: 'both' }]);
		expect((locked.results[0] as { transitionIds: string[] }).transitionIds).toEqual([]);
	});
});
