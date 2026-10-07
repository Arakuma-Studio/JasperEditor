// edit-ux: keyframe lanes / rubber bands on timeline clips — model (value ↔ y incl. the volume scale, band, keys,
// roving dots, expressions, fades) and the lane component's gestures (drag the band, Ctrl-click / Pen add, drag a
// key, fade handles, Pen marquee, Delete), each one History entry.
import { EngineClient } from '@jasper/engine-client';
import type { Clip } from '@jasper/project';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { KeyframeLane } from '../src/panels/timeline/components/KeyframeLane.tsx';
import {
	fadeCommands,
	fadeLengths,
	laneKeyFor,
	laneModel,
	laneOptions,
	laneSpec,
	VOLUME_BAND_MAX_DB,
	valueToY,
	yToValue,
} from '../src/panels/timeline/model/keyframe-lane.ts';
import { setupTimeline, solid, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
afterEach(() => cleanup());
const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

function withClips() {
	const t = setupTimeline({ pxPerFrame: 2 });
	const r = t.apply([{ type: 'media.register', asset: videoAsset(20) }]);
	const mediaId = (r.results[0] as { mediaId: string }).mediaId;
	t.apply([
		{
			type: 'clip.place',
			source: { mediaId },
			at: 0,
			sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
		},
		solid(0, 100, 'V2'),
	]);
	const video = t.clipsOn('V1')[0]!;
	const audio = t.clipsOn('A1')[0]!;
	const sol = t.clipsOn('V2')[0]!;
	return { ...t, video, audio, sol };
}

describe('lane model', () => {
	it('defaults: Opacity on video, Level on audio; per-clip and per-track choices', () => {
		const { video, audio } = withClips();
		expect(laneKeyFor({}, video)).toBe('opacity');
		expect(laneKeyFor({}, audio)).toBe('volumeDb');
		expect(laneKeyFor({ [video.trackId]: 'none' }, video)).toBeNull();
		expect(laneKeyFor({ [video.trackId]: 'none', [video.id]: 'transform.scale' }, video)).toBe(
			'transform.scale',
		);
	});

	it('volume uses an amplitude scale: −∞ at the bottom, +6 dB at the top, 0 dB at ≈71 %', () => {
		const { audio, session } = withClips();
		const spec = laneSpec(audio, 'volumeDb', session.ctx.registries)!;
		expect(valueToY(spec, VOLUME_BAND_MAX_DB, 100)).toBe(0);
		expect(valueToY(spec, -96, 100)).toBe(100);
		expect(valueToY(spec, 0, 100)).toBeCloseTo(100 - 70.79, 1);
		for (const db of [-20, -6, 0, 3]) expect(yToValue(spec, valueToY(spec, db, 100), 100)).toBeCloseTo(db, 1);
		const op = laneSpec(audio, 'opacity', session.ctx.registries);
		expect(op).toBeNull();
	});

	it('band, keys, roving dots, expressions and options include effects', () => {
		const { video, session, seqId, apply } = withClips();
		apply([
			{ type: 'keyframe.add', target: ['clip', video.id, 'opacity'], at: { sequenceFrame: 10 }, value: 100 },
			{ type: 'keyframe.add', target: ['clip', video.id, 'opacity'], at: { sequenceFrame: 20 }, value: 50 },
			{ type: 'keyframe.add', target: ['clip', video.id, 'opacity'], at: { sequenceFrame: 40 }, value: 0 },
			{ type: 'effect.add', target: { clipId: video.id }, effectId: 'jasper.gaussian-blur' },
		]);
		const doc = session.getCommitted();
		const seq = doc.sequences[seqId]!;
		const clip = seq.clips[video.id] as Clip;
		const spec = laneSpec(clip, 'opacity', session.ctx.registries)!;
		const m = laneModel(doc, seq, clip, spec, 100, 2);
		expect(m.keys.map((k) => [k.frame, k.x, k.y])).toEqual([
			[10, 20, 0],
			[20, 40, 50],
			[40, 80, 100],
		]);
		expect(m.band[0]).toEqual([0, 0]);
		const kfs = (clip as { opacity: { keyframes: { id: string }[] } }).opacity.keyframes;
		apply([{ type: 'keyframe.setRoving', keyframeIds: [kfs[1]!.id], roving: true }]);
		const m2 = laneModel(
			session.getCommitted(),
			seq,
			session.getCommitted().sequences[seqId]!.clips[video.id] as Clip,
			spec,
			100,
			2,
		);
		expect(m2.keys.map((k) => k.roving)).toEqual([false, true, false]);
		const opts = laneOptions(clip, session.ctx.registries);
		expect(opts.map((o) => o.key)).toEqual(expect.arrayContaining(['opacity', 'transform.scale']));
		expect(opts.some((o) => o.key.startsWith('effects.') && o.key.endsWith('.radius'))).toBe(true);
	});

	it('fades: a floor key at the edge and a full-level key; lengths are read back; 0 removes', () => {
		const { video, session, seqId, apply } = withClips();
		const seq = () => session.getCommitted().sequences[seqId]!;
		const clip = () => seq().clips[video.id] as Clip;
		const spec = laneSpec(clip(), 'opacity', session.ctx.registries)!;
		const model = () => laneModel(session.getCommitted(), seq(), clip(), spec, 100, 2);
		apply(fadeCommands(model(), clip(), 'in', 15));
		expect(fadeLengths(model(), clip())).toEqual({ in: 15, out: 0 });
		apply(fadeCommands(model(), clip(), 'out', 30));
		expect(fadeLengths(model(), clip())).toEqual({ in: 15, out: 30 });
		apply(fadeCommands(model(), clip(), 'in', 5));
		expect(fadeLengths(model(), clip()).in).toBe(5);
		apply(fadeCommands(model(), clip(), 'in', 0));
		expect(fadeLengths(model(), clip()).in).toBe(0);
		expect(model().keys.map((k) => k.value)).toEqual([100, 0]);
	});
});

function renderLane(
	t: ReturnType<typeof withClips>,
	clip: Clip,
	key: string,
	tool: 'selection' | 'pen' = 'selection',
) {
	const seq = t.session.getDrawn().sequences[t.seqId]!;
	const sel = t.session.getState().selection.keyframes;
	return render(
		<SessionProvider session={t.session}>
			<KeyframeLane
				session={t.session}
				seq={seq}
				clip={seq.clips[clip.id] as Clip}
				laneKey={key}
				x={0}
				top={0}
				height={100}
				pxPerFrame={2}
				viewportWidth={1000}
				tool={tool}
				locked={false}
				selectedKeys={new Set(sel?.keyframeIds ?? [])}
				mac={false}
			/>
		</SessionProvider>,
	);
}

describe('lane gestures', () => {
	it('dragging the band of a static property sets its value in one History entry', () => {
		const t = withClips();
		const { container } = renderLane(t, t.video, 'opacity');
		const band = container.querySelector(`[data-testid="lane-band-${t.video.id}"]`)!;
		const n = t.history().length;
		act(() => {
			fireEvent.pointerDown(band, { button: 0, clientX: 50, clientY: 0, pointerId: 1 });
			fireEvent.pointerMove(band, { clientX: 50, clientY: 25, pointerId: 1 });
			fireEvent.pointerMove(band, { clientX: 50, clientY: 50, pointerId: 1 });
			fireEvent.pointerUp(band, { clientX: 50, clientY: 50, pointerId: 1 });
		});
		const c = t.seq().clips[t.video.id] as { opacity: { value: number; keyframes: unknown[] } };
		expect(c.opacity.value).toBe(50);
		expect(c.opacity.keyframes).toHaveLength(0);
		expect(t.history().length).toBe(n + 1);
	});

	it('Ctrl-click adds a keyframe on the band; Pen click too; Delete removes selected keys', async () => {
		const t = withClips();
		let r = renderLane(t, t.video, 'opacity');
		let band = r.container.querySelector(`[data-testid="lane-band-${t.video.id}"]`)!;
		act(() => {
			fireEvent.pointerDown(band, { button: 0, clientX: 40, clientY: 0, ctrlKey: true, pointerId: 1 });
		});
		const kfs = () =>
			(t.seq().clips[t.video.id] as { opacity: { keyframes: { time: number; value: number }[] } }).opacity
				.keyframes;
		expect(kfs()).toHaveLength(1);
		expect(kfs()[0]!.value).toBe(100);
		expect(t.session.getState().selection.keyframes?.keyframeIds).toHaveLength(1);
		r.unmount();
		r = renderLane(t, t.video, 'opacity', 'pen');
		band = r.container.querySelector(`[data-testid="lane-band-${t.video.id}"]`)!;
		act(() => {
			fireEvent.pointerDown(band, { button: 0, clientX: 100, clientY: 0, pointerId: 1 });
		});
		expect(kfs()).toHaveLength(2);
		const ctx = createCommandContext({
			engine,
			session: t.session,
			focus: { panel: 'timeline', instanceId: 't' },
		});
		await runCommand('timeline.clear', ctx);
		expect(kfs()).toHaveLength(1);
		expect(t.seq().clips[t.video.id]).toBeTruthy();
	});

	it('dragging a keyframe moves it in time and value; the fade handle makes a fade', () => {
		const t = withClips();
		t.apply([
			{
				type: 'keyframe.add',
				target: ['clip', t.video.id, 'opacity'],
				at: { sequenceFrame: 10 },
				value: 100,
			},
			{
				type: 'keyframe.add',
				target: ['clip', t.video.id, 'opacity'],
				at: { sequenceFrame: 30 },
				value: 100,
			},
		]);
		let r = renderLane(t, t.video, 'opacity');
		const key = r.container.querySelector('[data-keyframe-id]')!;
		act(() => {
			fireEvent.pointerDown(key, { button: 0, clientX: 20, clientY: 0, pointerId: 1 });
			fireEvent.pointerMove(key, { clientX: 30, clientY: 20, pointerId: 1 });
			fireEvent.pointerUp(key, { clientX: 30, clientY: 20, pointerId: 1 });
		});
		const kfs = () =>
			(t.seq().clips[t.video.id] as { opacity: { keyframes: { time: number; value: number }[] } }).opacity
				.keyframes;
		expect(kfs()[0]!.value).toBe(80);
		const F = 705_600_000 / 30;
		expect(Math.round(kfs()[0]!.time / F)).toBe(15);
		r.unmount();
		r = renderLane(t, t.video, 'opacity');
		const handle = r.container.querySelector(`[data-testid="lane-fade-out-${t.video.id}"]`)!;
		const n = t.history().length;
		act(() => {
			fireEvent.pointerDown(handle, { button: 0, clientX: 240, clientY: 2, pointerId: 1 });
			fireEvent.pointerMove(handle, { clientX: 220, clientY: 2, pointerId: 1 });
			fireEvent.pointerUp(handle, { clientX: 220, clientY: 2, pointerId: 1 });
		});
		expect(t.history().length).toBe(n + 1);
		expect(t.history().at(-1)).toBe('Fade Out');
		expect(kfs().at(-1)!.value).toBe(0);
	});

	it('Pen marquee selects keyframes', () => {
		const t = withClips();
		t.apply([
			{
				type: 'keyframe.add',
				target: ['clip', t.video.id, 'opacity'],
				at: { sequenceFrame: 10 },
				value: 100,
			},
			{ type: 'keyframe.add', target: ['clip', t.video.id, 'opacity'], at: { sequenceFrame: 50 }, value: 50 },
		]);
		const r = renderLane(t, t.video, 'opacity', 'pen');
		const lane = r.container.querySelector(`[data-keyframe-lane="${t.video.id}"]`)!;
		act(() => {
			fireEvent.pointerDown(lane, { button: 0, clientX: 5, clientY: 80, pointerId: 1 });
			fireEvent.pointerMove(lane, { clientX: 60, clientY: -10, pointerId: 1 });
			fireEvent.pointerUp(lane, { clientX: 60, clientY: -10, pointerId: 1 });
		});
		expect(t.session.getState().selection.keyframes?.keyframeIds).toHaveLength(1);
	});
});
