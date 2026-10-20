import { EngineClient } from '@jasper/engine-client';
import { activeRemap, type Sequence, type TimedClip, type VideoClip } from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { keyframeMenu } from '../src/edit-ux/menus.ts';
import { sceneTargets } from '../src/time/scenes.ts';
import { isBandShown, setBandShown } from '../src/time/store.ts';
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

describe('Show Clip Keyframes ▸ Time Remapping ▸ Speed (edit-ux keyframe menu)', () => {
	it('shows the speed band and hides the property lane; another property hides the band', async () => {
		const h = harness();
		const v = h.movie();
		// The band set is UI state shared by the module (clip ids repeat across harnesses).
		setBandShown([v], false);
		const seq = h.seq() as Sequence;
		const menu = keyframeMenu(h.session, seq, seq.clips[v]!);
		const tr = (menu as { items: { label?: string; items?: { label: string; run(): void }[] }[] }).items.find(
			(i) => i.label === 'Time Remapping',
		)!;
		tr.items![0]!.run();
		expect(isBandShown(v)).toBe(true);
		expect(h.session.getState().views[seq.id]?.keyframeDisplay?.[v]).toBe('none');
		const again = keyframeMenu(h.session, h.seq() as Sequence, h.seq().clips[v]!);
		const opacity = (again as { items: { label?: string; items?: { run(): void }[] }[] }).items.find(
			(i) => i.label === 'Opacity',
		)!;
		opacity.items![0]!.run();
		expect(isBandShown(v)).toBe(false);
	});
});
