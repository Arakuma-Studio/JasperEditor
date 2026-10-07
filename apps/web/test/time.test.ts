// Workstream `time` UI: the speed band geometry and the Time Remapping / Time Interpolation / Scene Edit Detection
// commands against a real session.
import { EngineClient } from '@jasper/engine-client';
import { activeRemap, RATES, type TimedClip, type VideoClip } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { bandArea, bandKeys, bandSegments, keyAt, speedLabel, speedToY, yToSpeed } from '../src/time/band.ts';
import { sceneTargets } from '../src/time/scenes.ts';
import { isBandShown } from '../src/time/store.ts';
import { setupTimeline, videoAsset } from './timeline-helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

beforeAll(() => registerAllCommands());

function harness() {
	const t = setupTimeline({});
	const toasts: ToastRequest[] = [];
	const dialogs: { kind: string; props: unknown }[] = [];
	const ctx: CommandCtx = createCommandContext({
		engine,
		session: t.session,
		focus: { panel: 'timeline', instanceId: 'x' },
		toast: (r) => toasts.push(r),
		openDialog: (kind, props) => dialogs.push({ kind, props }),
	});
	const run = async (id: string, args?: unknown) => {
		const r = await runCommand(id, ctx, args);
		expect(r.ran, `${id}: ${r.reason}`).toBe(true);
	};
	const movie = () => {
		const r = t.apply([{ type: 'media.register', asset: videoAsset(20) }]);
		const mediaId = (r.results[0] as { mediaId: string }).mediaId;
		const p = t.apply([
			{
				type: 'clip.place',
				source: { mediaId },
				at: 0,
				tracks: { video: 'V1' },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
			},
		]);
		const ids = (p.results[0] as { clipIds: string[] }).clipIds;
		return ids.find((id) => t.seq().clips[id]!.kind === 'video')!;
	};
	return { ...t, ctx, run, toasts, dialogs, movie };
}

describe('speed band geometry', () => {
	const a = bandArea(60);
	it('maps 100 % to the middle, log scale, freeze at the bottom', () => {
		expect(speedToY(1, a)).toBeCloseTo((a.top + a.bottom) / 2);
		expect(speedToY(8, a)).toBeCloseTo(a.top);
		expect(speedToY(0.125, a)).toBeCloseTo(a.bottom);
		expect(speedToY(0, a)).toBe(a.bottom);
		expect(speedToY(-2, a)).toBe(speedToY(2, a));
		for (const s of [0.25, 0.5, 1, 1.5, 3]) expect(yToSpeed(speedToY(s, a), a)).toBeCloseTo(s, 6);
		expect(yToSpeed(speedToY(0.52, a), a, 5)).toBeCloseTo(0.5);
		expect(speedLabel(-1)).toBe('-100.00%');
	});

	it('segments and keys of a remapped clip in body px', () => {
		const F = 705_600_000 / 30;
		const clip = {
			kind: 'video',
			start: 10,
			duration: 60,
			sourceIn: 0,
			speed: { rate: 1, reverse: false },
			timeRemap: {
				enabled: true,
				keyframes: [{ id: 'k1', time: 20 * F, source: 20 * F, ramp: 2 * F }],
				speedAfter: 0.5,
			},
		} as unknown as TimedClip;
		const segs = bandSegments(clip, RATES.r30, 2, a);
		expect(segs.map((s) => [s.kind, s.speed, Math.round(s.x0), Math.round(s.x1)])).toEqual([
			['forward', 1, 0, 40],
			['forward', 0.5, 40, 120],
		]);
		const keys = bandKeys(clip, RATES.r30, 2);
		expect(keys[0]).toMatchObject({ x: 40, xIn: 36, xOut: 44 });
		expect(keyAt(keys, 37)?.id).toBe('k1');
		expect(keyAt(keys, 60)).toBeNull();
	});
});

describe('time commands', () => {
	it('shows the band, adds a speed keyframe at the playhead, sets interpolation, removes the remap', async () => {
		const h = harness();
		const v = h.movie();
		h.session.select('timeline', [v], 'replace');
		await h.run('timeline.showSpeedKeyframes');
		expect(isBandShown(v)).toBe(true);
		h.session.transport.seek(30);
		await h.run('timeline.toggleSpeedKeyframe');
		const c = h.seq().clips[v] as VideoClip;
		expect(activeRemap(c as TimedClip)?.keyframes).toHaveLength(1);
		await h.run('timeline.toggleSpeedKeyframe');
		expect(activeRemap(h.seq().clips[v] as TimedClip)?.keyframes).toHaveLength(0);
		await h.run('timeline.timeInterpolation.opticalFlow');
		expect((h.seq().clips[v] as VideoClip).timeInterpolation).toBe('optical-flow');
		await h.run('timeline.removeTimeRemapping');
		expect((h.seq().clips[v] as VideoClip).timeRemap).toBeUndefined();
		// One History entry per command: undo brings the remap back.
		expect(h.session.undo().label).toBe('Remove Time Remapping');
		expect(activeRemap(h.seq().clips[v] as TimedClip)).not.toBeNull();
	});

	it('Scene Edit Detection opens its dialog for the selected video clips with their media ranges', async () => {
		const h = harness();
		const v = h.movie();
		h.session.select('timeline', [v], 'replace');
		await h.run('timeline.sceneEditDetection');
		expect(h.dialogs[0]?.kind).toBe('time.sceneEditDetection');
		const t = sceneTargets(h.session, h.seq().id, [v]);
		expect(t).toHaveLength(1);
		expect(t[0]!.startSec).toBe(0);
		expect(t[0]!.endSec).toBeCloseTo(4, 1);
	});
});
