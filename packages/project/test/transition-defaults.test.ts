// M3 transition defaults (S10:TUI-032…034): per-medium project default lengths
// (`defaultTransitionFrames` / `defaultAudioTransitionFrames`), the alignment of transition.applyDefault, and the
// session-only `preferences.get` agent query.
import { describe, expect, it } from 'vitest';
import {
	AgentQueryError,
	checkInvariants,
	defaultTransitionFrames,
	exportAgentQuerySchemas,
	runAgentQuery,
	type Transition,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

/** Two adjacent video clips with linked audio, cut at frame 100, 30+ frames of handles on each side. */
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
const all = (h: Harness) => Object.values(h.seq.transitions) as Transition[];
const isVideo = (h: Harness, t: Transition) => h.seq.videoTracks.some((v) => v.id === t.trackId);

describe('defaultTransitionFrames (TUI-032)', () => {
	it('audio falls back to the video length when the project has no audio length', () => {
		expect(defaultTransitionFrames({ defaultTransitionFrames: 24 }, 'video')).toBe(24);
		expect(defaultTransitionFrames({ defaultTransitionFrames: 24 }, 'audio')).toBe(24);
		const s = { defaultTransitionFrames: 24, defaultAudioTransitionFrames: 12 };
		expect(defaultTransitionFrames(s, 'video')).toBe(24);
		expect(defaultTransitionFrames(s, 'audio')).toBe(12);
	});

	it('project.updateSettings accepts defaultAudioTransitionFrames (one undo step) and validates it', () => {
		const h = new Harness();
		h.ok([
			{
				type: 'project.updateSettings',
				settings: { defaultTransitionFrames: 20, defaultAudioTransitionFrames: 15 },
			},
		]);
		expect(h.doc.settings).toMatchObject({ defaultTransitionFrames: 20, defaultAudioTransitionFrames: 15 });
		const bad = h.tx([{ type: 'project.updateSettings', settings: { defaultAudioTransitionFrames: 0 } }]);
		expect(bad.ok).toBe(false);
		expect(checkInvariants(h.doc)).toEqual([]);
	});
});

describe('transition.applyDefault uses each medium’s default length (TUI-032)', () => {
	it('video and audio lengths differ', () => {
		const { h, va, vb, aa, ab } = twoLinkedClips();
		h.ok([
			{
				type: 'project.updateSettings',
				settings: { defaultTransitionFrames: 20, defaultAudioTransitionFrames: 10 },
			},
		]);
		h.ok([
			{
				type: 'transition.applyDefault',
				clipIds: [va, vb, aa, ab],
				edges: 'both',
				media: ['video', 'audio'],
			},
		]);
		const ts = all(h);
		expect(ts).toHaveLength(6);
		for (const t of ts) expect(t.duration).toBe(isVideo(h, t) ? 20 : 10);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('an explicit duration overrides both', () => {
		const { h, va, aa } = twoLinkedClips();
		h.ok([{ type: 'project.updateSettings', settings: { defaultAudioTransitionFrames: 10 } }]);
		h.ok([
			{
				type: 'transition.applyDefault',
				clipIds: [va, aa],
				edges: 'in',
				media: ['video', 'audio'],
				duration: 8,
			},
		]);
		expect(all(h).map((t) => t.duration)).toEqual([8, 8]);
	});

	it('transition.add without a duration uses the default of the track’s medium', () => {
		const { h, aa } = twoLinkedClips();
		h.ok([{ type: 'project.updateSettings', settings: { defaultAudioTransitionFrames: 6 } }]);
		const r = h.ok([{ type: 'transition.add', clipId: aa, edge: 'in', effectId: 'jasper.constant-gain' }]);
		expect(r.results[0]).toMatchObject({ duration: 6 });
		const v = h.ok([
			{
				type: 'transition.add',
				trackId: h.seq.videoTracks[0]!.id,
				at: 100,
				effectId: 'jasper.cross-dissolve',
			},
		]);
		expect(v.results[0]).toMatchObject({ duration: 30 });
	});
});

describe('transition.applyDefault alignment (TUI-033)', () => {
	for (const alignment of ['center', 'start-at-cut', 'end-at-cut'] as const) {
		it(`two-sided transitions get ${alignment}; fades keep their fixed alignment`, () => {
			const { h, va, vb } = twoLinkedClips();
			h.ok([{ type: 'transition.applyDefault', clipIds: [va, vb], edges: 'both', alignment }]);
			const ts = all(h);
			const two = ts.find((t) => t.outgoingClipId && t.incomingClipId)!;
			expect(two.alignment).toBe(alignment);
			expect(ts.find((t) => !t.outgoingClipId)!.alignment).toBe('start-at-cut');
			expect(ts.find((t) => !t.incomingClipId)!.alignment).toBe('end-at-cut');
			expect(checkInvariants(h.doc)).toEqual([]);
		});
	}

	it('without it the two-sided ones stay centred (M2 behaviour)', () => {
		const { h, va, vb } = twoLinkedClips();
		h.ok([{ type: 'transition.applyDefault', clipIds: [va, vb], edges: 'both' }]);
		expect(all(h).find((t) => t.outgoingClipId && t.incomingClipId)!.alignment).toBe('center');
	});

	it('refuses an unknown alignment', () => {
		const { h, va } = twoLinkedClips();
		const r = h.tx([{ type: 'transition.applyDefault', clipIds: [va], edges: 'both', alignment: 'middle' }]);
		expect(r.ok).toBe(false);
	});

	it('skips a cut that the chosen alignment cannot use (no handle on that side)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10, audio: false });
		// A ends at the end of its media (no tail handle); B starts at frame 60 of its media (head handle).
		const q = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { sourceFrames: 200 }, out: { sourceFrames: 300 } },
				ref: '$a',
			},
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 100,
				sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
				ref: '$b',
			},
		]);
		const ids = [q.refs.$a!, q.refs.$b!];
		// start-at-cut needs the outgoing clip's tail: none → the cut is skipped (free edges still fade).
		const r = h.ok([
			{ type: 'transition.applyDefault', clipIds: ids, edges: 'both', alignment: 'start-at-cut' },
		]);
		expect(all(h).some((t) => t.outgoingClipId && t.incomingClipId)).toBe(false);
		expect((r.results[0] as { transitionIds: string[] }).transitionIds).toHaveLength(2);
		// end-at-cut only needs the incoming head: it fits.
		h.ok([{ type: 'transition.applyDefault', clipIds: ids, edges: 'both', alignment: 'end-at-cut' }]);
		expect(all(h).find((t) => t.outgoingClipId && t.incomingClipId)?.alignment).toBe('end-at-cut');
	});
});

describe('preferences.get agent query (TUI-034)', () => {
	it('is session-only and returns what the session provides', () => {
		const h = new Harness();
		const base = { doc: h.doc, revision: 1 };
		expect(() => runAgentQuery(base, 'preferences.get')).toThrow(AgentQueryError);
		const prefs = {
			transitions: { video: 'jasper.dip-to-black', audio: 'jasper.constant-gain', alignment: 'end-at-cut' },
		};
		const env = {
			...base,
			session: {
				activeSequenceId: null,
				selection: () => ({}),
				playhead: () => ({ frame: 0, playing: false }),
				history: () => ({ entries: [], position: 0 }),
				preferences: () => prefs,
			},
		};
		expect(runAgentQuery(env, 'preferences.get')).toEqual({ preferences: prefs });
		const { preferences: _p, ...noPrefs } = env.session;
		expect(runAgentQuery({ ...base, session: noPrefs }, 'preferences.get')).toEqual({ preferences: {} });
		expect(exportAgentQuerySchemas()['preferences.get'].sessionOnly).toBe(true);
	});
});
