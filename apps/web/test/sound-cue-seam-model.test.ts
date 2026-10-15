// Cue Seam model (spec 12 §2.7): glyph geometry, states, hit testing, keyboard order, accessible names, clip peaks,
// conversions, layout of the widened divider, cue / peak snapping.
import { FLICKS_PER_SECOND, type Marker, parseSfxRequest, type Sequence, type SoundCue } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moveDelta } from '../src/panels/timeline/model/gestures.ts';
import { computeLayout, hitY } from '../src/panels/timeline/model/layout.ts';
import { collectSnapTargets, findSnap } from '../src/panels/timeline/model/snapping.ts';
import {
	clipPeakFlicks,
	clipPeakFrame,
	contentFlicksAt,
	cueAfter,
	cueAriaLabel,
	cuesOf,
	cueToMarker,
	GLYPH_PX,
	glyphPaint,
	glyphPath,
	heroConflicts,
	hitCue,
	KIND_GLYPH,
	layoutCues,
	markerToCueInput,
	markersToConvert,
	neighbourCue,
	peakHandleGeom,
	peakSecondsIntoSound,
	SEAM_PX,
} from '../src/sound/cues/model.ts';
import { cueSeamShown } from '../src/sound/cues/seam.ts';

const R30 = { num: 30, den: 1 };
const cue = (id: string, frame: number, over: Partial<SoundCue> = {}): SoundCue => ({
	id,
	frame,
	kind: 'land',
	weight: 'support',
	source: 'derived',
	...over,
});
const seqWith = (cues: SoundCue[], clips: Record<string, unknown> = {}) =>
	({
		soundDesign: { cues: Object.fromEntries(cues.map((c) => [c.id, c])) },
		clips,
	}) as unknown as Sequence;
const V = { scrollFrame: 0, pxPerFrame: 10, width: 1000 };

describe('reading cues', () => {
	it('sorts by frame then id and skips values that are not cues', () => {
		const raw = {
			soundDesign: {
				cues: {
					b: cue('b', 30),
					a: cue('a', 30),
					c: cue('c', 10),
					bad: { id: 'bad', frame: Number.NaN },
					mismatch: cue('other', 1),
					junk: 7,
				},
			},
		} as unknown as Sequence;
		expect(cuesOf(raw).map((c) => c.id)).toEqual(['c', 'a', 'b']);
		expect(cuesOf(null)).toEqual([]);
		expect(cuesOf({ soundDesign: 'x' } as unknown as Sequence)).toEqual([]);
	});

	it('hostile sound design values never throw (property)', () => {
		fc.assert(
			fc.property(fc.anything(), (v) => {
				const out = cuesOf({ soundDesign: v } as unknown as Sequence);
				for (const c of out) expect(Number.isFinite(c.frame)).toBe(true);
			}),
			{ numRuns: 300 },
		);
	});
});

describe('glyphs', () => {
	it('every kind has its own shape and a closed path, sizes by weight', () => {
		const shapes = Object.values(KIND_GLYPH);
		expect(new Set(shapes).size).toBe(shapes.length);
		expect(KIND_GLYPH.cut).toBe('bar');
		expect(KIND_GLYPH.move).toBe('triangle-right');
		expect(KIND_GLYPH.land).toBe('triangle-down');
		expect(KIND_GLYPH.appear).toBe('circle');
		expect(GLYPH_PX).toEqual({ hero: 12, support: 8, ambient: 6 });
		for (const s of shapes) {
			const d = glyphPath(s, 12);
			expect(d.startsWith('M')).toBe(true);
			// every coordinate stays inside the glyph box
			for (const n of d.match(/-?\d+(\.\d+)?/g)!.map(Number)) expect(Math.abs(n)).toBeLessThanOrEqual(6);
		}
		expect(glyphPath('triangle-down', 12)).toBe('M-6,-4.8 L6,-4.8 L0,6 Z');
	});

	it('states differ by more than colour: dashes, fill, underline, agent tick, strike', () => {
		const st = { filled: false, agent: false, ghost: false, conflict: false, muted: false, selected: false };
		const unfilled = glyphPaint('hero', 'triangle-down', st);
		const filled = glyphPaint('hero', 'triangle-down', { ...st, filled: true });
		const agent = glyphPaint('support', 'bar', { ...st, agent: true });
		const ghost = glyphPaint('support', 'bar', { ...st, ghost: true });
		expect(unfilled.dash).toBe('3 1.5');
		expect(unfilled.fill).toBe('none');
		expect(unfilled.stroke).toBe('var(--pr-cue-unfilled)');
		expect(filled.dash).toBeNull();
		expect(filled.fill).toBe('var(--pr-cue-hero)');
		expect(glyphPaint('support', 'bar', { ...st, filled: true }).fill).toBe('none');
		expect(agent.dash).toBe('1 1.5');
		expect(agent.stroke).toBe('var(--pr-agent)');
		expect(agent.agentTick).toBe(true);
		expect(ghost.stroke).toBe('var(--pr-ghost-stroke)');
		expect(glyphPaint('hero', 'bar', { ...st, conflict: true }).underline).toBe(true);
		expect(glyphPaint('hero', 'bar', { ...st, muted: true })).toMatchObject({ strike: true, opacity: 0.45 });
	});

	it('hero conflicts: two heroes under 0.5 s apart (muted heroes ignored)', () => {
		const cs = [
			cue('a', 0, { weight: 'hero' }),
			cue('b', 14, { weight: 'hero' }),
			cue('c', 15, { weight: 'support' }),
			cue('d', 60, { weight: 'hero' }),
			cue('e', 74, { weight: 'hero', muted: true }),
		];
		expect([...heroConflicts(cs, R30)].sort()).toEqual(['a', 'b']);
		expect(heroConflicts(cs, { num: 0, den: 1 }).size).toBe(0);
	});
});

describe('layout and hit testing', () => {
	it('places glyphs at their frame, culls off-screen cues, maps spans', () => {
		const cs = [
			cue('a', 10, { weight: 'hero', window: { start: 5, end: 25 } }),
			cue('b', 50, { build: { seconds: 0.5, fromHz: 200, toHz: 2000 } }),
			cue('c', 5000),
			cue('d', 70, { stopBefore: { seconds: 1, depthDb: -24 }, placedClipIds: ['x'] }),
		];
		const g = layoutCues(cs, V, { rate: R30, selected: new Set(['b']), clips: { x: {} } });
		expect(g.map((x) => x.id)).toEqual(['a', 'b', 'd']);
		const [a, b, d] = g;
		expect(a).toMatchObject({ x: 100, size: 12, shape: 'triangle-down', window: { x0: 50, x1: 250 } });
		expect(b!.build).toEqual({ x0: 350, x1: 500 });
		expect(b!.state.selected).toBe(true);
		expect(d!.stopBefore).toEqual({ x0: 400, x1: 700 });
		expect(d!.state.filled).toBe(true);
		// a dangling placed clip id does not make a cue filled
		expect(layoutCues([cs[3]!], V, { rate: R30, selected: new Set(), clips: {} })[0]!.state.filled).toBe(false);
	});

	it('caps the glyphs drawn, keeping selected and heroes first', () => {
		const cs = Array.from({ length: 50 }, (_, i) =>
			cue(`c${String(i).padStart(2, '0')}`, i, { weight: i % 10 === 0 ? 'hero' : 'ambient' }),
		);
		const g = layoutCues(cs, V, { rate: R30, selected: new Set(['c07']), max: 6 });
		expect(g.map((x) => x.id)).toEqual(['c00', 'c07', 'c10', 'c20', 'c30', 'c40']);
	});

	it('hits the nearest glyph within its half size plus slop; heroes win ties', () => {
		const g = layoutCues(
			[cue('h', 10, { weight: 'hero' }), cue('s', 10), cue('far', 20, { weight: 'ambient' })],
			V,
			{ rate: R30, selected: new Set() },
		);
		expect(hitCue(g, 100)).toBe('h');
		expect(hitCue(g, 108.9)).toBe('h'); // hero: 6 + 3 px
		expect(hitCue(g, 109.5)).toBeNull();
		expect(hitCue(g, 205.9)).toBe('far'); // ambient: 3 + 3 px
		expect(hitCue(g, 206.5)).toBeNull();
		expect(hitCue([], 3)).toBeNull();
	});

	it('keyboard order and playhead navigation', () => {
		const cs = [cue('a', 10), cue('b', 20), cue('c', 30)];
		expect(neighbourCue(cs, null, 1, 15)).toBe('b');
		expect(neighbourCue(cs, null, -1, 15)).toBe('a');
		expect(neighbourCue(cs, 'b', 1)).toBe('c');
		expect(neighbourCue(cs, 'c', 1)).toBe('c');
		expect(neighbourCue(cs, 'a', -1)).toBe('a');
		expect(neighbourCue(cs, 'b', 'first')).toBe('a');
		expect(neighbourCue(cs, 'b', 'last')).toBe('c');
		expect(neighbourCue([], null, 1)).toBeNull();
		expect(cueAfter(cs, 20, 1)?.id).toBe('c');
		expect(cueAfter(cs, 20, -1)?.id).toBe('a');
		expect(cueAfter(cs, 30, 1)).toBeNull();
	});

	it('accessible names name weight, kind, timecode, state and reason', () => {
		const c = cue('a', 122, { weight: 'hero', reason: "Scale ease-out on V2 'Logo'" });
		expect(cueAriaLabel(c, { timecode: '00:00:04:02' })).toBe(
			"Hero Land cue at 00:00:04:02, unfilled, Scale ease-out on V2 'Logo'",
		);
		const filled = cue('b', 1, { source: 'agent', placedClipIds: ['x'], muted: true });
		expect(
			cueAriaLabel(filled, { timecode: 'T', placedNames: ['A2 Crunch'], conflict: true, clips: { x: {} } }),
		).toBe('Support Land cue at T, filled with A2 Crunch, agent-authored, muted, conflicts with another hero cue');
	});
});

describe('divider layout (the seam widens it)', () => {
	const base = {
		height: 400,
		dividerRatio: 0.5,
		videoTracks: [{ id: 'v1' }],
		audioTracks: [{ id: 'a1' }],
		heights: {},
		scrollYVideo: 0,
		scrollYAudio: 0,
	};
	it('defaults to 4 px; 18 px with the seam, and the audio region starts below it', () => {
		const plain = computeLayout(base);
		const seam = computeLayout({ ...base, dividerPx: SEAM_PX });
		expect(plain.dividerHeight).toBe(4);
		expect(seam.dividerHeight).toBe(18);
		expect(seam.dividerTop).toBe(191); // (400 − 18) / 2
		expect(seam.audio.top).toBe(209);
		expect(seam.audio.rows[0]!.y).toBe(209);
		expect(hitY(seam, 195)).toEqual({ kind: 'divider' });
		expect(hitY(seam, 209)).toMatchObject({ kind: 'track' });
		expect(hitY(plain, 200)).toEqual({ kind: 'divider' });
		expect(hitY(plain, 202)).toMatchObject({ kind: 'track' });
	});
});

describe('visibility', () => {
	it('the user choice wins; else on in the Sound Design workspace or with cues', () => {
		expect(cueSeamShown(undefined, { workspaceId: 'editing', hasCues: false })).toBe(false);
		expect(cueSeamShown(undefined, { workspaceId: 'sound-design', hasCues: false })).toBe(true);
		expect(cueSeamShown({}, { workspaceId: 'editing', hasCues: true })).toBe(true);
		expect(cueSeamShown({ cueSeam: 'off' }, { workspaceId: 'sound-design', hasCues: true })).toBe(false);
		expect(cueSeamShown({ cueSeam: 'on' }, { workspaceId: 'editing', hasCues: false })).toBe(true);
	});
});

describe('clip peaks', () => {
	const F = FLICKS_PER_SECOND / 30;
	const media = { library: { descriptors: { peakSec: 0.25 }, leadSilenceSec: 0.05 } } as never;
	const clip = (over: Record<string, unknown> = {}) =>
		({
			kind: 'audio',
			start: 100,
			duration: 60,
			sourceIn: 0,
			speed: { rate: 1, reverse: false },
			mediaId: 'm',
			...over,
		}) as never;

	it('the placement peak (an override) wins over the library descriptors', () => {
		expect(clipPeakFlicks(clip(), media)).toEqual({ flicks: 0.25 * FLICKS_PER_SECOND, override: false });
		const placed = clip({ sfx: { placement: { align: 'peak', peakFlicks: 12 * F, errorFlicks: 0 } } });
		expect(clipPeakFlicks(placed, media)).toEqual({ flicks: 12 * F, override: true });
		// a start-aligned placement does not name the peak: the descriptors do
		const start = clip({ sfx: { placement: { align: 'start', peakFlicks: 0, errorFlicks: 0 } } });
		expect(clipPeakFlicks(start, media)?.override).toBe(false);
		expect(clipPeakFlicks(clip({ kind: 'video' }), media)).toBeNull();
		expect(clipPeakFlicks(clip(), undefined)).toBeNull();
	});

	it('peak frame follows sourceIn and speed; reversed clips and peaks outside the clip give none', () => {
		expect(clipPeakFrame(clip(), media, R30)).toBeCloseTo(107.5, 9);
		expect(clipPeakFrame(clip({ sourceIn: 3 * F }), media, R30)).toBeCloseTo(104.5, 9);
		expect(clipPeakFrame(clip({ speed: { rate: 2, reverse: false } }), media, R30)).toBeCloseTo(103.75, 9);
		expect(clipPeakFrame(clip({ speed: { rate: 1, reverse: true } }), media, R30)).toBeNull();
		expect(clipPeakFrame(clip({ sourceIn: 10 * F }), media, R30)).toBeNull();
		expect(clipPeakFrame(clip({ duration: 5 }), media, R30)).toBeNull();
	});

	it('content time round trip and seconds into the sound', () => {
		const c = clip({ sourceIn: 2 * F });
		expect(contentFlicksAt(c, 110, R30)).toBe(12 * F);
		expect(contentFlicksAt(c, 1000, R30)).toBe(62 * F); // clamped to the clip end
		expect(peakSecondsIntoSound(0.25 * FLICKS_PER_SECOND, media)).toBeCloseTo(0.2, 9);
		expect(peakSecondsIntoSound(0, media)).toBe(0);
	});

	it('the handle hides below 24 × 32 px', () => {
		const c = clip();
		expect(peakHandleGeom(c, 107.5, { w: 600, height: 40, pxPerFrame: 10 })).toEqual({ x: 75, visible: true });
		expect(peakHandleGeom(c, 107.5, { w: 23, height: 40, pxPerFrame: 10 })?.visible).toBe(false);
		expect(peakHandleGeom(c, 107.5, { w: 600, height: 31, pxPerFrame: 10 })?.visible).toBe(false);
		expect(peakHandleGeom(c, null, { w: 600, height: 40, pxPerFrame: 10 })).toBeNull();
	});
});

describe('conversions', () => {
	const marker = (over: Partial<Marker>): Marker =>
		({
			id: 'm1',
			frame: 40,
			duration: 0,
			name: '',
			comment: '',
			color: 'green',
			type: 'comment',
			author: 'user',
			...over,
		}) as Marker;

	it('sfx markers give their types, weight and align; others keep their name as label', () => {
		const a = markerToCueInput(marker({ name: 'sfx: boom+swoosh', duration: 10 }));
		expect(a).toMatchObject({
			frame: 40,
			kind: 'manual',
			types: ['boom', 'whoosh'],
			weight: 'hero',
			align: 'peak',
			source: 'marker',
			anchor: null,
			window: { start: 40, end: 50 },
		});
		const b = markerToCueInput(marker({ name: 'Door slams' }));
		expect(b).toMatchObject({ label: 'Door slams', weight: 'support', source: 'marker' });
		expect(b.types).toBeUndefined();
	});

	it('cue → marker → cue keeps the types (parseSfxRequest reads the name back)', () => {
		const m = cueToMarker(cue('a', 12, { types: ['whoosh', 'swish'], reason: 'Push' }));
		expect(m).toEqual({ frame: 12, name: 'sfx: whoosh+swish', comment: 'Push', duration: 0 });
		expect(parseSfxRequest(m.name)?.types).toEqual(['whoosh', 'swish']);
		expect(cueToMarker(cue('b', 1, { label: 'Logo lands' })).name).toBe('Logo lands');
		expect(cueToMarker(cue('c', 1)).name).toBe('sfx: land');
	});

	it('Convert Markers to Cues takes sfx markers and the selected ones, in frame order', () => {
		const ms = [
			marker({ id: 'a', frame: 30, name: 'sfx: hit' }),
			marker({ id: 'b', frame: 10, name: 'plain' }),
			marker({ id: 'c', frame: 20, name: 'other' }),
		];
		expect(markersToConvert(ms, ['c']).map((m) => m.id)).toEqual(['c', 'a']);
		expect(markersToConvert(ms, []).map((m) => m.id)).toEqual(['a']);
	});
});

describe('snapping to cues and by peaks', () => {
	const seq = {
		clips: {},
		markers: [],
		inPoint: null,
		outPoint: null,
		workArea: null,
		soundDesign: { cues: { k1: cue('k1', 45), k2: cue('k2', 90) } },
	} as unknown as Sequence;

	it('cues are snap targets at marker priority; dragged cues are excluded; extra anchor targets win', () => {
		const t = collectSnapTargets(seq, { playhead: null });
		expect(t.filter((x) => x.kind === 'cue').map((x) => x.frame)).toEqual([45, 90]);
		expect(t.find((x) => x.kind === 'cue')!.priority).toBe(4);
		const ex = collectSnapTargets(seq, { excludeCues: new Set(['k1']) });
		expect(ex.some((x) => x.frame === 45)).toBe(false);
		const withAnchor = collectSnapTargets(seq, { extra: [{ frame: 45, kind: 'anchor', priority: 6 }] });
		expect(withAnchor.find((x) => x.frame === 45)!.kind).toBe('anchor');
		expect(findSnap(t, [47], 3)?.target.kind).toBe('cue');
	});

	it('a moving SFX clip snaps by its peak first, by its edges only when the peak finds nothing', () => {
		const targets = collectSnapTargets(seq, { playhead: null });
		// 2 px per frame: 4 frames of threshold. Clip [30, 60) with its peak at 37.4: +7 frames puts the peak's frame
		// on 44, which snaps to the cue at 45
		const byPeak = moveDelta({
			dxPx: 14,
			pxPerFrame: 2,
			starts: [30],
			ends: [60],
			peaks: [37.4],
			targets,
			snapping: true,
		});
		expect(byPeak.delta).toBe(8);
		expect(Math.floor(37.4 + byPeak.delta)).toBe(45);
		// without a peak the end edge (60 + 28 = 88) snaps to the cue at 90
		const byEdge = moveDelta({ dxPx: 56, pxPerFrame: 2, starts: [30], ends: [60], targets, snapping: true });
		expect(byEdge.delta).toBe(30);
		// the peak wins even when an edge would be nearer (end 91 is 1 frame from 90, the peak's frame 88 is 2)
		const peakFirst = moveDelta({
			dxPx: 62,
			pxPerFrame: 2,
			starts: [30],
			ends: [60],
			peaks: [57.5],
			targets,
			snapping: true,
		});
		expect(Math.floor(57.5 + peakFirst.delta)).toBe(90);
	});
});
