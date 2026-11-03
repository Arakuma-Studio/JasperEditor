// Spec 19 G4, §14: from a brief to a checked title in at most five calls, with a real engine and real rendering. Opt-in with
// the other render suites (`pnpm qa:mcp`, REMOTION_E2E=1): the first render bundles the compositions, and looks need Chrome
// with WebGL2 (JASPER_BROWSER_EXECUTABLE). MCP_QA_KEEP=1 keeps the sheets in test-results/mcp-qa/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../../src/png.ts';
import { QA_ENABLED, Qa, ROOT } from './harness.ts';

const PORT = Number(process.env.MCP_QA_TITLES_PORT ?? 49026);
const LONG = { timeoutSeconds: 900 };

const RECIPE = {
	palette: { face: [0.98, 0.82, 0.25, 1], keyline: [0.08, 0.1, 0.35, 1], shadow: [0, 0, 0, 1] },
	layers: [
		{ type: 'shadow', params: { distance: 4, blur: 6, angle: 60 } },
		{ type: 'rim', name: 'Outer', params: { width: 8 } },
		{ type: 'face' },
	],
};
/** A white face and nothing else: on a white picture it cannot be read. */
const BARE = { palette: { face: [1, 1, 1, 1] }, layers: [{ type: 'face' }] };

// biome-ignore lint/suspicious/noExplicitAny: tool results are JSON read loosely by the assertions
type Json = Record<string, any>;
const textOf = (r: CallToolResult) => (r.content.find((c) => c.type === 'text') as { text: string }).text;
const rowOf = (rows: Json[], id: string) => rows.find((r) => r.id === id)!;

describe.runIf(QA_ENABLED)('titles (real engine, real rendering, MCP over stdio)', () => {
	const qa = new Qa('titles', PORT);
	let calls = 0;
	const call = async (name: string, args: Record<string, unknown>) => {
		calls++;
		const r = await qa.tryTool(name, args);
		if (r.isError) throw new Error(`${name}: ${textOf(r)}\n${qa.logs.join('').slice(-3000)}`);
		return { r, json: JSON.parse(textOf(r)) as Json };
	};
	const keep = (name: string, r: CallToolResult) => {
		const img = r.content.find((c) => c.type === 'image') as { data: string } | undefined;
		if (!img) return null;
		const png = Buffer.from(img.data, 'base64');
		if (process.env.MCP_QA_KEEP) {
			const dir = join(ROOT, 'test-results', 'mcp-qa');
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `titles-${name}.png`), png);
		}
		return decodePng(png);
	};

	beforeAll(async () => {
		await qa.start();
		// The first browser render bundles the compositions, which stalls the engine: get it out of the way of the timings.
		await qa.project('QA warm-up');
		await qa.tx('Title', [
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'WARM' }, ref: '$t' },
			{ type: 'look.apply', clipIds: ['$t'], look: { name: 'Warm', recipe: RECIPE }, seed: 1 },
		]);
		for (let i = 0; i < 12; i++) {
			const r = await qa.tryTool('render_frame', { projectId: qa.projectId, at: 10, width: 320 });
			if (!r.isError) return;
		}
		throw new Error(`no render after 12 tries: ${qa.logs.join('').slice(-2000)}`);
	}, 1_500_000);
	afterAll(async () => {
		await qa.stop();
	}, 60_000);

	it('brief → checked title on real footage in at most five calls', async () => {
		await qa.project('QA title');
		const media = await qa.importMedia('clip-a.mp4');
		await qa.tool('add_clip', { projectId: qa.projectId, media: media['clip-a.mp4'], at: 0, sourceOut: 4 });
		await qa.tool('set_brief', { projectId: qa.projectId, text: 'A launch teaser', platform: 'youtube' });
		const before = await qa.frame(45);

		calls = 0;
		await call('enable_toolsets', { names: ['titles'] });
		const found = await call('title_look_find', { query: 'bold', ...LONG });
		const look = found.json.rows[0]?.lookId ? { lookId: found.json.rows[0].lookId } : { recipe: RECIPE };
		const made = await call('title_propose', {
			projectId: qa.projectId,
			text: 'LAUNCH DAY',
			at: 0,
			...look,
			energy: 'medium',
			mode: 'apply',
			...LONG,
		});
		expect(made.json.timedOut).toBe(false);
		const clipId = made.json.clipIds[0];
		const check = await call('title_check', { projectId: qa.projectId, clipId, ...LONG });
		expect(calls).toBeLessThanOrEqual(5);

		// The sheet is the real picture: 640 px, intro, hold and outro over the footage.
		const sheet = keep('brief', made.r)!;
		expect(sheet.width).toBeLessThanOrEqual(640);
		expect(made.json.cells).toHaveLength(3);

		// Real measurements: a centred title, its alpha bounds inside the safe areas, contrast from the footage behind it.
		const rows = check.json.rows as Json[];
		const safe = rowOf(rows, 'safe-area');
		expect(safe.status).toBe('pass');
		const { x0, x1, y0, y1 } = safe.measured.bounds;
		expect(Math.abs((x0 + x1) / 2 - 640)).toBeLessThan(40);
		expect(Math.abs((y0 + y1) / 2 - 360)).toBeLessThan(40);
		expect(x1 - x0).toBeGreaterThan(200);
		expect(rowOf(rows, 'off-frame').status).toBe('pass');
		const contrast = rowOf(rows, 'contrast');
		expect(contrast.measured.ratio).toBeGreaterThan(1);
		expect(contrast.measured.frames.length).toBeGreaterThanOrEqual(1);
		expect(contrast.measured.background).toMatch(/^#[0-9a-f]{6}$/);
		expect(rowOf(rows, 'font-available').status).toBe('pass');
		expect(rowOf(rows, 'min-size').status).toBe('pass');
		expect(rowOf(rows, 'read-time').status).toBe('pass');
		expect(['native', 'hybrid', 'remotion']).toContain(rowOf(rows, 'export-path').measured.path);
		expect(check.json.revision).toBe(made.json.revision);
		expect(check.json.notChecked.join(' ')).toMatch(/Taste/);

		// The title is on the real timeline, and it changed the picture.
		const after = await qa.frame(45);
		const diff = after.data.reduce((n, v, i) => n + Math.abs(v - before.data[i]!), 0) / after.data.length;
		expect(diff).toBeGreaterThan(0.5);

		// Headless: revert takes it out again.
		await qa.tool('apply_commands', made.json.revert.arguments);
		const gone = await qa.frame(45);
		const left = gone.data.reduce((n, v, i) => n + Math.abs(v - before.data[i]!), 0) / gone.data.length;
		expect(left).toBeLessThan(0.05);
	}, 1_500_000);

	it('a title lost in the picture fails on measured contrast, and its fix passes when rendered again', async () => {
		await qa.project('QA contrast');
		await qa.tx('Footage', [
			{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V1', color: [1, 1, 1, 1] },
		]);
		const made = await call('title_propose', {
			projectId: qa.projectId,
			text: 'WHITE ON WHITE',
			at: 0,
			recipe: BARE,
			mode: 'apply',
			...LONG,
		});
		const clipId = made.json.clipIds[0];
		const first = rowOf(made.json.check.rows, 'contrast');
		expect(first.status).toBe('fail');
		expect(first.measured.ratio).toBeLessThan(1.2);
		expect(made.json.check.verified).toBe(false);
		await qa.tool('apply_commands', { projectId: qa.projectId, label: 'Fix', commands: first.fix.commands });
		const again = await call('title_check', { projectId: qa.projectId, clipId, ...LONG });
		const row = rowOf(again.json.rows, 'contrast');
		expect(row.status).not.toBe('fail');
		expect(row.measured.ratio).toBeGreaterThan(3);
	}, 1_500_000);

	it('a title off the frame fails on its real bounds, and the move puts it inside', async () => {
		await qa.project('QA frame');
		await qa.tx('Footage', [
			{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V1', color: [0.1, 0.1, 0.3, 1] },
		]);
		const made = await call('title_propose', {
			projectId: qa.projectId,
			text: 'OFF THE EDGE',
			at: 0,
			recipe: RECIPE,
			position: [60, 360],
			mode: 'apply',
			...LONG,
		});
		const rows = made.json.check.rows as Json[];
		expect(rowOf(rows, 'off-frame')).toMatchObject({ status: 'fail', measured: { inkTouches: ['left'] } });
		const safe = rowOf(rows, 'safe-area');
		expect(safe.status).toBe('fail');
		await qa.tool('apply_commands', { projectId: qa.projectId, label: 'Fix', commands: safe.fix.commands });
		const again = await call('title_check', {
			projectId: qa.projectId,
			clipId: made.json.clipIds[0],
			...LONG,
		});
		expect(rowOf(again.json.rows, 'off-frame').status).toBe('pass');
		expect(rowOf(again.json.rows, 'safe-area').status).not.toBe('fail');
	}, 1_500_000);

	it('a headless propose says what to do, and a cancelled sheet leaves nothing behind', async () => {
		await qa.project('QA headless');
		await qa.tx('Footage', [
			{ type: 'clip.addSolid', at: 0, duration: 150, track: 'V1', color: [0, 0, 0, 1] },
		]);
		const e = await qa.toolError('title_propose', {
			projectId: qa.projectId,
			text: 'x',
			at: 0,
			recipe: RECIPE,
		});
		expect(e.code).toBe('E_NO_EDITOR');
		expect(e.hint).toContain('open_project_in_editor');

		const queued = await call('render_frames', {
			projectId: qa.projectId,
			count: 12,
			width: 160,
			overlay: 'safe-area',
			wait: false,
		});
		const jobId = queued.json.jobId;
		await qa.tool('cancel_job', { jobId });
		const job = await qa.tryTool('wait_for_job', { jobId, timeoutSeconds: 60 });
		expect(JSON.parse(textOf(job)).error.code).toBe('JOB_CANCELLED');
	}, 300_000);
});
