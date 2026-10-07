// MCP scenario QA (docs/wp-notes/mcp-cli.md §6): realistic edits made only through jasper-mcp over MCP
// JSON-RPC against a real engine, asserting on rendered pixels and written files. Opt-in: `pnpm qa:mcp`
// (MCP_QA=1) or with the other render suites (REMOTION_E2E=1); titles need the Remotion renderer (Chrome).
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	centroid,
	coverage,
	ffprobe,
	type Img,
	luma,
	meanColor,
	meanDiff,
	meanLuma,
	type Px,
	QA_ENABLED,
	Qa,
	videoFrame,
} from './harness.ts';

const PORT = Number(process.env.MCP_QA_PORT ?? 49025);

const red = (p: Px) => p[0] > 200 && p[1] < 60 && p[2] < 60;
const blue = (p: Px) => p[2] > 200 && p[0] < 60 && p[1] < 60;
const white = (p: Px) => p[0] > 200 && p[1] > 200 && p[2] > 200;
const grey = (p: Px) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) < 10;

describe.runIf(QA_ENABLED)('MCP scenario QA (real engine, MCP over stdio)', () => {
	const qa = new Qa('scenarios', PORT);
	let media: Record<string, string> = {};

	beforeAll(async () => {
		await qa.start();
	}, 240_000);
	afterAll(async () => {
		await qa.stop();
	}, 60_000);

	/** A fresh 720p30 project with the solid-colour and test-pattern fixtures imported. */
	async function fresh(name: string) {
		await qa.project(name);
		media = await qa.importMedia('xfade-red.mp4', 'xfade-blue.mp4', 'clip-a.mp4');
	}
	const v1 = async () => (await qa.clips()).filter((c) => c.track === 'V1');

	it('rough cut: place, split, ripple-delete and stack shots; every cut shows the right picture', async () => {
		await fresh('QA rough cut');
		const add = (m: string, at: number, seconds: number, extra: Record<string, unknown> = {}) =>
			qa.tool('add_clip', { projectId: qa.projectId, media: m, at, sourceOut: seconds, ...extra });
		await add(media['xfade-red.mp4']!, 0, 2);
		await add(media['xfade-blue.mp4']!, 60, 2);
		await add(media['clip-a.mp4']!, 120, 2);
		expect((await v1()).map((c) => [c.start, c.end])).toEqual([
			[0, 60],
			[60, 120],
			[120, 180],
		]);
		const [r0, b0, a0] = [await qa.frame(15), await qa.frame(75), await qa.frame(135)];
		expect(coverage(r0, red)).toBeGreaterThan(0.97);
		expect(coverage(b0, blue)).toBeGreaterThan(0.97);
		expect(meanDiff(a0, r0)).toBeGreaterThan(40);
		expect(meanDiff(a0, b0)).toBeGreaterThan(40);
		// Cut the red shot at 1 s and ripple-delete its tail: blue now starts at 30.
		await qa.tool('split_at', { projectId: qa.projectId, at: { seconds: 1 }, tracks: ['V1', 'A1'] });
		const tail = (await qa.clips()).filter((c) => c.start === 30 && c.end === 60);
		expect(tail.length).toBe(2);
		await qa.tool('delete_clips', { projectId: qa.projectId, clipIds: tail.map((c) => c.id), ripple: true });
		expect((await v1()).map((c) => [c.start, c.end])).toEqual([
			[0, 30],
			[30, 90],
			[90, 150],
		]);
		expect(coverage(await qa.frame(45), blue)).toBeGreaterThan(0.97);
		// The test pattern goes on V2 over the red shot: V2 is drawn on top.
		const pattern = (await v1()).find((c) => c.start === 90)!;
		await qa.tool('move_clip', { projectId: qa.projectId, clipIds: [pattern.id], to: 0, deltaTracks: 1 });
		const top = await qa.frame(15);
		expect(meanDiff(top, r0)).toBeGreaterThan(40);
		expect(meanDiff(top, a0)).toBeLessThan(meanDiff(top, r0) / 2);
		const table = await qa.tryTool('get_timeline', { projectId: qa.projectId });
		expect(JSON.stringify(table.content)).toContain('clip-a.mp4');
	}, 300_000);

	it('colour grade: exposure brightens, saturation 0 makes grey, get_grade reads it back', async () => {
		await fresh('QA grade');
		const c = await qa.tool<{ clips: { id: string; track: string }[] }>('add_clip', {
			projectId: qa.projectId,
			media: media['clip-a.mp4'],
			at: 0,
			sourceOut: 2,
		});
		const clipId = c.clips.find((x) => x.track === 'V1')!.id;
		const before = await qa.frame(15);
		await qa.tool('grade_clip', { projectId: qa.projectId, clipId, basic: { exposure: 1 } });
		const brighter = await qa.frame(15);
		expect(meanLuma(brighter)).toBeGreaterThan(meanLuma(before) + 12);
		await qa.tool('grade_clip', { projectId: qa.projectId, clipId, basic: { exposure: 0, saturation: 0 } });
		const mono = await qa.frame(15);
		expect(coverage(before, grey)).toBeLessThan(0.6);
		expect(coverage(mono, grey)).toBeGreaterThan(0.95);
		const g = await qa.tool<{ instances: { basic: Record<string, number> }[] } & Record<string, unknown>>(
			'get_grade',
			{
				projectId: qa.projectId,
				clipId,
			},
		);
		expect(JSON.stringify(g)).toMatch(/"saturation":0/);
		// The property read reports the same value as keyed and as rendered.
		const props = await qa.tool<{ properties: { key: string; value: unknown; evaluated: unknown }[] }>(
			'get_clip_properties',
			{ projectId: qa.projectId, clipId, at: 15 },
		);
		const sat = props.properties.find((p) => p.key.endsWith('.saturation'))!;
		expect(sat).toMatchObject({ value: 0, evaluated: 0 });
	}, 300_000);

	it('titles: a white title is drawn where it is placed and follows its position', async () => {
		await fresh('QA titles');
		await qa.tool('add_clip', {
			projectId: qa.projectId,
			media: media['xfade-blue.mp4'],
			at: 0,
			sourceOut: 2,
		});
		const t = await qa.tool<{ clips: { id: string }[] }>('add_text', {
			projectId: qa.projectId,
			text: 'QA TITLE',
			at: 0,
			duration: { seconds: 2 },
			sizePx: 110,
			position: [640, 200],
		});
		const titleId = t.clips[0]!.id;
		const a = await qa.frame(15);
		const ca = centroid(a, white);
		expect(coverage(a, white)).toBeGreaterThan(0.004);
		expect(ca).not.toBeNull();
		// 640-px render of a 1280-px sequence: x ≈ 320, y ≈ 100.
		expect(Math.abs(ca!.x - 320)).toBeLessThan(25);
		expect(Math.abs(ca!.y - 100)).toBeLessThan(25);
		await qa.tx('Move title', [
			{ type: 'param.set', target: ['clip', titleId, 'transform', 'position'], value: [640, 520] },
		]);
		const cb = centroid(await qa.frame(15), white)!;
		expect(Math.abs(cb.y - ca!.y - 160)).toBeLessThan(12);
		expect(Math.abs(cb.x - ca!.x)).toBeLessThan(6);
	}, 300_000);

	it('transitions: a cross dissolve mixes red into blue across the cut', async () => {
		await fresh('QA transitions');
		const r = await qa.tool<{ clips: { id: string; track: string }[] }>('add_clip', {
			projectId: qa.projectId,
			media: media['xfade-red.mp4'],
			at: 0,
			sourceIn: 1,
			sourceOut: 3,
		});
		await qa.tool('add_clip', {
			projectId: qa.projectId,
			media: media['xfade-blue.mp4'],
			at: 60,
			sourceIn: 1,
			sourceOut: 3,
		});
		const redId = r.clips.find((c) => c.track === 'V1')!.id;
		await qa.tool('add_transition', {
			projectId: qa.projectId,
			type: 'cross-dissolve',
			durationFrames: 20,
			clipId: redId,
			edge: 'out',
			alignment: 'center',
		});
		expect(coverage(await qa.frame(45), red)).toBeGreaterThan(0.97);
		expect(coverage(await qa.frame(75), blue)).toBeGreaterThan(0.97);
		const [mr, mg, mb] = meanColor(await qa.frame(60));
		expect(mr).toBeGreaterThan(80);
		expect(mr).toBeLessThan(180);
		expect(mb).toBeGreaterThan(80);
		expect(mb).toBeLessThan(180);
		expect(mg).toBeLessThan(40);
		// Earlier in the dissolve there is more red than blue.
		const [er, , eb] = meanColor(await qa.frame(53));
		expect(er).toBeGreaterThan(eb);
	}, 300_000);

	it('keyframes: opacity fades the title in, position keys move it, evaluated matches the render', async () => {
		await fresh('QA keyframes');
		await qa.tool('add_clip', {
			projectId: qa.projectId,
			media: media['xfade-blue.mp4'],
			at: 0,
			sourceOut: 2,
		});
		const t = await qa.tool<{ clips: { id: string }[] }>('add_text', {
			projectId: qa.projectId,
			text: 'KEYS',
			at: 0,
			duration: { seconds: 2 },
			sizePx: 120,
		});
		const id = t.clips[0]!.id;
		await qa.tx('Animate title', [
			{
				type: 'keyframe.add',
				target: ['clip', id, 'opacity'],
				at: { sequenceFrame: 0 },
				value: 0,
				interpolation: 'linear',
			},
			{
				type: 'keyframe.add',
				target: ['clip', id, 'opacity'],
				at: { sequenceFrame: 30 },
				value: 100,
				interpolation: 'linear',
			},
			{
				type: 'keyframe.add',
				target: ['clip', id, 'transform', 'position'],
				at: { sequenceFrame: 30 },
				value: [300, 360],
				interpolation: 'linear',
			},
			{
				type: 'keyframe.add',
				target: ['clip', id, 'transform', 'position'],
				at: { sequenceFrame: 50 },
				value: [980, 360],
				interpolation: 'linear',
			},
		]);
		const titleLuma = (img: Img) => {
			const c = centroid(img, (p) => p[0] > 60 && p[1] > 60);
			return c;
		};
		expect(coverage(await qa.frame(0), (p) => p[0] > 60)).toBeLessThan(0.0005);
		const half = await qa.frame(15);
		const full = await qa.frame(30);
		const textPx = (img: Img) => coverage(img, (p) => luma(p) > 60);
		expect(textPx(half)).toBeGreaterThan(0.002);
		const bright = (img: Img) => {
			let max = 0;
			for (let i = 0; i < img.data.length; i += 4) max = Math.max(max, img.data[i]!);
			return max;
		};
		expect(bright(half)).toBeLessThan(bright(full) - 60);
		expect(bright(full)).toBeGreaterThan(230);
		// Position: linear 300 → 980 between frames 30 and 50; frame 40 is half way (640).
		const c30 = titleLuma(full)!;
		const c40 = titleLuma(await qa.frame(40))!;
		const c50 = titleLuma(await qa.frame(50))!;
		expect(Math.abs(c30.x - 150)).toBeLessThan(25);
		expect(Math.abs(c50.x - 490)).toBeLessThan(25);
		expect(Math.abs(c40.x - (c30.x + c50.x) / 2)).toBeLessThan(6);
		const props = await qa.tool<{
			properties: { key: string; value: number[]; evaluated: number[]; keyframes?: unknown[] }[];
		}>('get_clip_properties', {
			projectId: qa.projectId,
			clipId: id,
			at: 40,
			keys: ['transform.position', 'opacity'],
		});
		const pos = props.properties.find((p) => p.key === 'transform.position')!;
		expect(pos.value).toEqual([640, 360]);
		expect(pos.evaluated).toEqual([640, 360]);
		expect(pos.keyframes).toHaveLength(2);
		expect(props.properties.find((p) => p.key === 'opacity')).toMatchObject({ value: 100, evaluated: 100 });
	}, 300_000);

	it('export and re-import: the file has every frame and plays back like the timeline', async () => {
		await fresh('QA export');
		await qa.tool('add_clip', {
			projectId: qa.projectId,
			media: media['xfade-red.mp4'],
			at: 0,
			sourceOut: 1,
		});
		await qa.tool('add_clip', { projectId: qa.projectId, media: media['clip-a.mp4'], at: 30, sourceOut: 1 });
		const out = qa.path('qa-export.mp4');
		const job = await qa.tool<{ state: string; result: { path: string; frames: number } }>('start_export', {
			projectId: qa.projectId,
			outputPath: out,
			wait: true,
		});
		expect(job.state).toBe('succeeded');
		expect(job.result.path).toBe(out);
		const info = ffprobe(out);
		expect(info).toMatchObject({ width: 1280, height: 720, frames: 60 });
		const timeline = [await qa.frame(15), await qa.frame(45)];
		const file = [videoFrame(out, 0.5, 640, qa.dir), videoFrame(out, 1.5, 640, qa.dir)];
		expect(meanDiff(timeline[0]!, file[0]!)).toBeLessThan(6);
		expect(meanDiff(timeline[1]!, file[1]!)).toBeLessThan(8);
		// Re-import into another project: the export is media like any other.
		const first = qa.projectId;
		await qa.project('QA re-import');
		const m = await qa.importMedia(out);
		await qa.tool('add_clip', { projectId: qa.projectId, media: m['qa-export.mp4'], at: 0 });
		expect((await v1()).map((c) => [c.start, c.end])).toEqual([[0, 60]]);
		expect(meanDiff(await qa.frame(15), timeline[0]!)).toBeLessThan(8);
		expect(meanDiff(await qa.frame(45), timeline[1]!)).toBeLessThan(10);
		qa.projectId = first;
	}, 600_000);

	it('cancelling a waiting export over MCP cancels the engine job and leaves no file', async () => {
		await fresh('QA cancel');
		for (let i = 0; i < 4; i++)
			await qa.tool('add_clip', {
				projectId: qa.projectId,
				media: media['clip-a.mp4'],
				at: i * 300,
				sourceOut: 10,
			});
		const out = qa.path('cancelled.mp4');
		const ac = new AbortController();
		const progress: number[] = [];
		const call = qa.callRaw(
			'start_export',
			{ projectId: qa.projectId, outputPath: out, wait: true, preset: 'high-quality-h264' },
			{
				signal: ac.signal,
				onprogress: (p) => {
					progress.push(p.progress);
					if (p.progress > 0.02) ac.abort('stop');
				},
			},
		);
		await expect(call).rejects.toThrow();
		expect(progress.length).toBeGreaterThan(0);
		// The engine reports the export cancelled and its partial output is gone.
		await expect
			.poll(
				async () =>
					(await qa.engineJson<{ jobs: { kind: string; state: string }[] }>('/api/jobs')).jobs.find(
						(j) => j.kind === 'export',
					)?.state,
				{
					timeout: 15_000,
				},
			)
			.toBe('cancelled');
		expect(existsSync(out)).toBe(false);
	}, 300_000);
});
