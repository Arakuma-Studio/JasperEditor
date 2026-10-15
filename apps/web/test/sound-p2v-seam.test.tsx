// Phase 2 verification (spec 12 §2.7 "Cue Seam", "Peak handle", P2-R7): drags of the seam and of the peak handle
// never leave the session's gesture held (Esc cancels them, as every timeline drag; a seam or handle that goes away
// mid-drag cancels its gesture), Shift-click / Shift+Arrow select a cue even when clips were selected, and hit
// testing, culling, the render cap and keyboard navigation hold at the extreme zooms of a 1-hour sequence.
import type { AudioClip, ClipSfx, MediaAsset, Sequence, SoundCue } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerAllCommands } from '../src/commands/index.ts';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import { createTimelineUiStore } from '../src/panels/timeline/state/ui-store.ts';
import { CueSeam } from '../src/sound/cues/CueSeam.tsx';
import { cuesOf, hitCue, layoutCues, MAX_RENDERED_CUES, SEAM_PX } from '../src/sound/cues/model.ts';
import { PeakHandle } from '../src/sound/cues/PeakHandle.tsx';
import { makeSession, solid, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());

function seam(
	cues: Record<string, unknown>[],
	opts: { viewport?: { scrollFrame: number; pxPerFrame: number; width: number }; before?: unknown[] } = {},
) {
	const { session, seqId } = makeSession();
	const add = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [...(opts.before ?? []), { type: 'soundCue.add', cues }] as never[],
	});
	if (!add.ok) throw new Error(JSON.stringify(add.errors));
	const ids = (add.results.at(-1) as { cueIds: string[] }).cueIds;
	const viewport = opts.viewport ?? { scrollFrame: 0, pxPerFrame: 10, width: 1000 };
	const reveal = vi.fn();
	const seq = () => session.getCommitted().sequences[seqId] as Sequence;
	function Seam() {
		const drawn = (session.getState().transient ?? session.getState().document).sequences[seqId] as Sequence;
		return (
			<CueSeam
				session={session}
				seq={drawn}
				layout={computeLayout({
					height: 400,
					dividerRatio: 0.5,
					videoTracks: drawn.videoTracks,
					audioTracks: drawn.audioTracks,
					heights: {},
					scrollYVideo: 0,
					scrollYAudio: 0,
					dividerPx: SEAM_PX,
				})}
				viewport={viewport}
				media={{}}
				ui={createTimelineUiStore()}
				instanceId="t1"
				snapping={false}
				run={() => {}}
				openMenu={() => {}}
				toast={() => {}}
				reveal={reveal}
			/>
		);
	}
	const view = (
		<SessionProvider session={session}>
			<Seam />
		</SessionProvider>
	);
	const r = render(view);
	const off = session.store.subscribe(() => r.rerender(view));
	const lane = () => screen.getByTestId('cue-seam');
	const history = () => session.getState().history.entries.map((e) => e.label);
	const unmount = () => {
		off();
		r.unmount();
	};
	return { session, seqId, ids, seq, lane, history, reveal, unmount };
}

const pointer = (el: Element, type: string, x: number, extra: Record<string, unknown> = {}) =>
	fireEvent[type as 'pointerDown'](el, { clientX: x, clientY: 9, button: 0, pointerId: 1, ...extra });

describe('Cue Seam drags never hold the gesture', () => {
	it('Esc during a drag cancels it: the cue stays, no history, the selection is kept', () => {
		const t = seam([{ frame: 30, kind: 'land', weight: 'hero', source: 'user' }]);
		const n = t.history().length;
		pointer(t.lane(), 'pointerDown', 300);
		pointer(t.lane(), 'pointerMove', 400);
		expect(t.session.gestureActive).toBe(true);
		fireEvent.keyDown(t.lane(), { key: 'Escape', code: 'Escape' });
		expect(t.session.gestureActive).toBe(false);
		pointer(t.lane(), 'pointerUp', 400);
		expect(cuesOf(t.seq())[0]!.frame).toBe(30);
		expect(t.history()).toHaveLength(n);
		expect(t.session.getState().selection.cues).toEqual(t.ids);
	});

	it('the seam going away mid-drag (Timeline closed, workspace switched) cancels the gesture', () => {
		const t = seam([{ frame: 30, kind: 'land', weight: 'hero', source: 'user' }]);
		pointer(t.lane(), 'pointerDown', 300);
		pointer(t.lane(), 'pointerMove', 400);
		expect(t.session.gestureActive).toBe(true);
		t.unmount();
		expect(t.session.gestureActive).toBe(false);
		expect(cuesOf(t.seq())[0]!.frame).toBe(30);
	});
});

describe('Cue Seam selection is one domain', () => {
	it('Shift-click on a cue while clips are selected selects the cue (and the clips go)', () => {
		const t = seam([{ frame: 30, kind: 'land', weight: 'hero', source: 'user' }], {
			before: [solid(0, 90, 'V1')],
		});
		const clipId = Object.keys(t.seq().clips)[0]!;
		act(() => t.session.select('timeline', [clipId], 'replace'));
		pointer(t.lane(), 'pointerDown', 300, { shiftKey: true });
		pointer(t.lane(), 'pointerUp', 300, { shiftKey: true });
		expect(t.session.getState().selection.cues).toEqual(t.ids);
		expect(t.session.getState().selection.timeline.clips).toEqual([]);
	});

	it('Shift+Right extends to the next cue while clips are selected', () => {
		const t = seam(
			[
				{ frame: 30, kind: 'land', weight: 'hero', source: 'user' },
				{ frame: 60, kind: 'cut', weight: 'support', source: 'user' },
			],
			{ before: [solid(0, 90, 'V1')] },
		);
		const clipId = Object.keys(t.seq().clips)[0]!;
		act(() => t.session.select('timeline', [clipId], 'replace'));
		fireEvent.keyDown(t.lane(), { key: 'ArrowRight', code: 'ArrowRight', shiftKey: true });
		expect(t.session.getState().selection.cues).toEqual([t.ids[0]]);
		expect(t.session.getState().selection.timeline.clips).toEqual([]);
	});
});

describe('Cue Seam at the extremes', () => {
	const HOUR = 108_000; // 1 hour at 30 fps
	const many = (n: number): SoundCue[] =>
		Array.from({ length: n }, (_, i) => ({
			id: `cue_${String(i).padStart(16, '0')}`,
			frame: Math.round((i * (HOUR - 1)) / (n - 1)),
			kind: 'cut',
			weight: i % 10 === 0 ? 'hero' : 'support',
			source: 'derived',
		})) as never;
	const rate = { num: 30, den: 1 };

	it('fully zoomed out on a 1-hour sequence with 5 000 cues: the cap keeps selected and hero cues, thins the rest evenly', () => {
		const cues = many(5000);
		const v = { scrollFrame: 0, pxPerFrame: 1200 / HOUR, width: 1200 };
		const selected = new Set([cues[4321]!.id]);
		const geoms = layoutCues(cues, v, { rate, selected });
		expect(geoms.length).toBe(MAX_RENDERED_CUES);
		expect(geoms.some((g) => g.id === cues[4321]!.id)).toBe(true);
		expect(geoms.filter((g) => g.weight === 'hero')).toHaveLength(500);
		for (const g of geoms) expect(Number.isFinite(g.x)).toBe(true);
		// the support cues kept are spread over the whole hour (not only its beginning): each tenth keeps its share
		const support = geoms.filter((g) => g.weight === 'support');
		for (let k = 0; k < 10; k++) {
			const inTenth = support.filter((g) => g.frame >= (k * HOUR) / 10 && g.frame < ((k + 1) * HOUR) / 10);
			expect(inTenth.length, `tenth ${k}`).toBeGreaterThan(80);
		}
		// frame 0 and the last hero are drawn and hit at their x
		expect(hitCue(geoms, 0)).toBe(cues[0]!.id);
		const last = geoms.find((g) => g.id === cues[4990]!.id)!;
		expect(hitCue(geoms, last.x)).toBe(cues[4990]!.id);
	});

	it('maximum zoom-in scrolled to the end: only the cues in view; a cue past the end is culled, not drawn at NaN', () => {
		const cues = [
			...many(5000),
			{ id: 'cue_past', frame: HOUR + 500, kind: 'cut', weight: 'hero', source: 'user' },
		];
		const v = { scrollFrame: HOUR - 20, pxPerFrame: 48, width: 1200 };
		const geoms = layoutCues(cues as SoundCue[], v, { rate, selected: new Set() });
		expect(geoms.map((g) => g.id)).toEqual([cues[4999]!.id]);
		expect(geoms[0]!.x).toBe((HOUR - 1 - (HOUR - 20)) * 48);
		expect(hitCue(geoms, geoms[0]!.x + 3)).toBe(cues[4999]!.id);
	});

	it('a non-finite pointer x hits nothing (never the first cue)', () => {
		const geoms = layoutCues(
			many(10),
			{ scrollFrame: 0, pxPerFrame: 0.01, width: 1200 },
			{ rate, selected: new Set() },
		);
		expect(hitCue(geoms, Number.NaN)).toBeNull();
		expect(hitCue(geoms, Number.POSITIVE_INFINITY)).toBeNull();
	});

	it('End / Home move to the last / first cue and scroll it into view, horizontally scrolled', () => {
		const t = seam(
			[
				{ frame: 0, kind: 'cut', weight: 'support', source: 'user' },
				{ frame: 5000, kind: 'land', weight: 'hero', source: 'user' },
				{ frame: 9000, kind: 'cut', weight: 'support', source: 'user' },
			],
			{ viewport: { scrollFrame: 4900, pxPerFrame: 2, width: 1000 } },
		);
		fireEvent.keyDown(t.lane(), { key: 'End', code: 'End' });
		expect(t.session.getState().selection.cues).toEqual([t.ids[2]]);
		expect(t.reveal).toHaveBeenLastCalledWith(9000);
		fireEvent.keyDown(t.lane(), { key: 'Home', code: 'Home' });
		expect(t.session.getState().selection.cues).toEqual([t.ids[0]]);
		expect(t.reveal).toHaveBeenLastCalledWith(0);
		fireEvent.keyDown(t.lane(), { key: 'ArrowRight', code: 'ArrowRight' });
		expect(t.session.getState().selection.cues).toEqual([t.ids[1]]);
		expect(t.reveal).toHaveBeenLastCalledWith(5000);
		expect(t.lane().getAttribute('aria-activedescendant')).toBe(`cue-t1-${t.ids[1]}`);
	});
});

describe('Peak handle drags never hold the gesture', () => {
	function handle() {
		const { session, seqId } = makeSession();
		const apply = (commands: unknown[]) => {
			const r = session.apply({
				label: 's',
				origin: 'user',
				sequenceId: seqId,
				commands: commands as never[],
			});
			if (!r.ok) throw new Error(JSON.stringify(r.errors));
			return r;
		};
		const base = videoAsset(1, true);
		const asset = {
			...base,
			kind: 'audio',
			probe: { ...base.probe, streams: [base.probe.streams[1]!] },
			library: {
				soundId: 'snd_0123456789abcdef',
				title: 'Crunch',
				types: ['hit'],
				source: { type: 'starter' },
				license: 'CC0-1.0',
				author: 'Kenney',
				attribution: null,
				descriptors: {
					peakSec: 0.25,
					onsetSec: 0.2,
					headQuietSec: 0.2,
					durationSec: 1,
					octaveBandsDb: [-30, -25, -20, -18, -19, -24, -33],
					centroidHz: 1800,
					maxMomentaryLufs: -14,
				},
			},
		} as unknown as Omit<MediaAsset, 'id'>;
		const mediaId = (apply([{ type: 'media.register', asset }]).results[0] as { mediaId: string }).mediaId;
		const clipId = apply([
			{ type: 'clip.place', source: { mediaId }, at: 30, tracks: { audio: 'A1' }, video: false, ref: '$c' },
		]).refs.$c!;
		const clip = () =>
			session.getCommitted().sequences[seqId]!.clips[clipId] as AudioClip & { sfx?: ClipSfx };
		const r = render(
			<SessionProvider session={session}>
				<PeakHandle
					clip={clip()}
					x={0}
					w={clip().duration * 10}
					height={40}
					viewportWidth={1000}
					scrollFrame={0}
					pxPerFrame={10}
					rate={{ num: 30, den: 1 }}
					selected={false}
					trackLocked={false}
				/>
			</SessionProvider>,
		);
		const el = document.querySelector(`[data-peak-handle="${clipId}"]`) as HTMLElement;
		return { session, clip, el, unmount: () => r.unmount() };
	}

	it('Esc during a peak drag cancels it (the clip stays)', () => {
		const h = handle();
		fireEvent.pointerDown(h.el, { clientX: 100, button: 0, pointerId: 1 });
		fireEvent.pointerMove(h.el, { clientX: 220, pointerId: 1 });
		expect(h.session.gestureActive).toBe(true);
		fireEvent.keyDown(h.el, { key: 'Escape', code: 'Escape' });
		expect(h.session.gestureActive).toBe(false);
		fireEvent.pointerUp(h.el, { clientX: 220, pointerId: 1 });
		expect(h.clip().start).toBe(30);
	});

	it('the handle going away mid-drag (its clip scrolled out and culled) cancels the gesture', () => {
		const h = handle();
		fireEvent.pointerDown(h.el, { clientX: 100, button: 0, pointerId: 1 });
		fireEvent.pointerMove(h.el, { clientX: 220, pointerId: 1 });
		expect(h.session.gestureActive).toBe(true);
		h.unmount();
		expect(h.session.gestureActive).toBe(false);
		expect(h.clip().start).toBe(30);
	});
});

describe('Cue Seam: cues selected by commands while clips are selected', () => {
	it('selecting cues (Suggest Cues on the selected clips, Next Cue, agents) deselects the clips, not the new cues', () => {
		const t = seam(
			[
				{ frame: 30, kind: 'land', weight: 'hero', source: 'user' },
				{ frame: 60, kind: 'cut', weight: 'support', source: 'user' },
			],
			{ before: [solid(0, 90, 'V1')] },
		);
		const clipId = Object.keys(t.seq().clips)[0]!;
		act(() => t.session.select('timeline', [clipId], 'replace'));
		act(() => t.session.select('cues', t.ids, 'replace'));
		expect(t.session.getState().selection.cues).toEqual(t.ids);
		expect(t.session.getState().selection.timeline.clips).toEqual([]);
		// and selecting clips still deselects the cues
		act(() => t.session.select('timeline', [clipId], 'replace'));
		expect(t.session.getState().selection.cues).toEqual([]);
		expect(t.session.getState().selection.timeline.clips).toEqual([clipId]);
	});
});
