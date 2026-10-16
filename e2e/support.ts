import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect, type Locator, type Page } from '@playwright/test';
import type { JasperAgentApi } from '../apps/web/src/agent-bridge/types.ts';
import { type ExportResult, ExportResultSchema } from '../packages/api/src/exports.ts';
import {
	type EngineJob,
	EngineJobSchema,
	JobListResponseSchema,
	TERMINAL_JOB_STATES,
} from '../packages/api/src/jobs.ts';
import type { CommandInput, MediaAsset, Origin, TransactionResult } from '../packages/project/src/index.ts';

declare global {
	interface Window {
		jasper?: JasperAgentApi;
	}
}

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = join(ROOT, 'fixtures', 'media');

type ClipRow = {
	id: string;
	kind: string;
	name: string;
	track: string;
	start: number;
	end: number;
	duration: number;
	linked: string[];
};

type HistoryEntry = { label: string; origin: Origin; applied: boolean };

/** Engine info written by e2e/serve.mjs (port + temp appdir). */
export function serverInfo(): { port: number; appdir: string } {
	return JSON.parse(readFileSync(join(ROOT, 'test-results', 'e2e-server.json'), 'utf8'));
}

export async function enableAgentBridge(page: Page): Promise<void> {
	await page.addInitScript(() => window.localStorage.setItem('jasper:agent-bridge', '1'));
}

export async function query<T = unknown>(
	page: Page,
	name: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	return (await page.evaluate(
		([n, a]) => {
			const api = window.jasper;
			if (!api) throw new Error('window.jasper is not installed');
			return api.query(n, a);
		},
		[name, args] as const,
	)) as T;
}

export async function transact(page: Page, commands: CommandInput[]): Promise<TransactionResult> {
	return page.evaluate(
		(cmds) => window.jasper!.transact({ protocol: 'jasper.tx/1', label: 'E2E setup', commands: cmds }),
		commands,
	);
}

export function expectTransaction(
	result: TransactionResult,
): asserts result is Extract<TransactionResult, { ok: true }> {
	expect(result.ok, JSON.stringify(result)).toBe(true);
}

export async function clips(page: Page, tracks?: string[]): Promise<ClipRow[]> {
	const r = await query<{ clips: ClipRow[] }>(page, 'sequence.clipsInRange', {
		from: 0,
		to: 10_000_000,
		...(tracks ? { tracks } : {}),
	});
	return [...r.clips].sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start);
}

/** Labels of the applied (not undone) history entries. */
export async function appliedLabels(page: Page): Promise<string[]> {
	const h = await query<{ entries: HistoryEntry[] }>(page, 'history.list');
	return h.entries.filter((e) => e.applied).map((e) => e.label);
}

export async function playheadFrame(page: Page): Promise<number> {
	return (await query<{ frame: number }>(page, 'playhead.get')).frame;
}

export async function sequenceSummary(page: Page): Promise<{
	sequenceId: string;
	settings: { width: number; height: number; frameRate: { num: number; den: number } };
	duration: { frames: number; timecode: string; seconds: number };
	markers: { name?: string; frame?: number; start?: number }[];
	tracks?: { id: string; label: string; kind: string; clipCount: number }[];
}> {
	return query(page, 'sequence.summary');
}

/** Creates a project from Home with the default 1080p 29.97 preset and waits for the editor. */
export async function createProject(page: Page, name: string): Promise<string> {
	await page.goto('/');
	await expect(page.getByTestId('home')).toBeVisible();
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill(name);
	await page.getByTestId('new-project-create').click();
	await expect(page.getByTestId('editor-shell')).toBeVisible();
	await expect(page.getByTestId('timeline-track-area')).toBeVisible();
	await expect.poll(() => page.evaluate(() => !!window.jasper)).toBe(true);
	const m = /\/project\/([^/?#]+)/.exec(page.url());
	if (!m) throw new Error(`Unexpected editor URL ${page.url()}`);
	return decodeURIComponent(m[1]!);
}

/** File ▸ Import (Ctrl+I) through the browser file chooser (web upload path). */
export async function importFiles(page: Page, names: string[]): Promise<void> {
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles(names.map((n) => join(FIXTURES, n)));
	for (const n of names) {
		await expect(page.getByTestId('project-row').filter({ hasText: n })).toBeVisible({ timeout: 60_000 });
	}
}

export async function mediaIdForFile(page: Page, name: string): Promise<string> {
	const media = await query<Record<string, MediaAsset>>(page, 'doc.get', { path: ['media'] });
	const matches = Object.values(media).filter((asset) => asset.originalName === name);
	expect(matches, `Expected one imported media asset named ${name}`).toHaveLength(1);
	return matches[0]!.id;
}

export function timelineArea(page: Page): Locator {
	return page.getByTestId('timeline-track-area');
}

export function trackRow(page: Page, trackId: string): Locator {
	return page.locator(`[data-testid="timeline-track-area"] [data-track-id="${trackId}"]`).first();
}

export function clipElement(page: Page, clipId: string): Locator {
	return page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${clipId}"]`).first();
}

export async function clipBox(
	page: Page,
	clipId: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
	const box = await clipElement(page, clipId).boundingBox();
	if (!box) throw new Error(`clip ${clipId} is not visible in the timeline`);
	return box;
}

/** Pointer drag with intermediate moves (the timeline coalesces pointer moves per frame). */
export async function pointerDrag(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number },
	opts: { modifiers?: ('Control' | 'Shift' | 'Alt')[]; steps?: number } = {},
): Promise<void> {
	for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	const steps = opts.steps ?? 12;
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
		await page.waitForTimeout(16);
	}
	await page.mouse.up();
	for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
}

/** Focuses the timeline panel without clicking a clip (click on its empty ruler-free header strip). */
export async function focusTimeline(page: Page): Promise<void> {
	await page.getByTestId('timeline-timecode').click();
	await page.keyboard.press('Escape');
}

/** Mean luminance and variance of the Program monitor output, read from its canvases/videos in the page. */
export async function programPixels(page: Page): Promise<{ layers: number; mean: number; std: number }> {
	return page.getByTestId('program-player-wrapper').evaluate((root) => {
		const w = 192;
		const h = 108;
		const c = document.createElement('canvas');
		c.width = w;
		c.height = h;
		const g = c.getContext('2d', { willReadFrequently: true })!;
		g.fillStyle = '#000';
		g.fillRect(0, 0, w, h);
		const sources = [...root.querySelectorAll('canvas, video, img')] as (
			| HTMLCanvasElement
			| HTMLVideoElement
			| HTMLImageElement
		)[];
		let layers = 0;
		for (const s of sources) {
			try {
				g.drawImage(s, 0, 0, w, h);
				layers++;
			} catch {
				// not drawable yet
			}
		}
		const d = g.getImageData(0, 0, w, h).data;
		let sum = 0;
		let sq = 0;
		const n = w * h;
		for (let i = 0; i < d.length; i += 4) {
			const y = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
			sum += y;
			sq += y * y;
		}
		const mean = sum / n;
		return { layers, mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
	});
}

type ProbeResult = {
	streams: {
		codec_type: string;
		codec_name: string;
		nb_read_frames?: string;
		width?: number;
		height?: number;
		r_frame_rate?: string;
	}[];
	format: { duration: string; format_name: string };
};

/** ffprobe with an exact frame count of the first video stream. */
export function ffprobe(file: string): ProbeResult {
	const out = execFileSync(
		process.env.JASPER_FFPROBE ?? 'ffprobe',
		['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file],
		{ encoding: 'utf8' },
	);
	return JSON.parse(out) as ProbeResult;
}

export async function waitForJob(
	request: APIRequestContext,
	jobId: string,
	timeoutMs = 240_000,
): Promise<EngineJob> {
	const t0 = Date.now();
	let resets = 0;
	for (;;) {
		let res: Awaited<ReturnType<APIRequestContext['get']>>;
		try {
			res = await request.get(`/api/jobs/${jobId}`);
		} catch (e) {
			// a kept-alive socket the loaded engine closed under the poll: ask again (a few times), never hide a failure
			if (resets++ < 5 && /ECONNRESET|socket hang up/i.test(String((e as Error).message))) {
				await new Promise((r) => setTimeout(r, 500));
				continue;
			}
			throw e;
		}
		expect(res.ok()).toBe(true);
		const job = EngineJobSchema.parse(await res.json());
		if (TERMINAL_JOB_STATES.has(job.state)) return job;
		if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} still ${job.state} after ${timeoutMs} ms`);
		await new Promise((r) => setTimeout(r, 500));
	}
}

type ExportOutcome = {
	file: string;
	job: EngineJob & { result: ExportResult };
};

export async function exportViaUi(
	page: Page,
	request: APIRequestContext,
	opts: {
		engine: 'auto' | 'native' | 'remotion';
		fileName: string;
		expectPath: RegExp;
		outDir: string;
		/** The plan's blocker list must explain the path choice (S04:RP-010). */
		expectBlocker?: RegExp;
		jobTimeoutMs?: number;
	},
): Promise<ExportOutcome> {
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	await page.getByTestId('export-engine').selectOption(opts.engine);
	await page.getByTestId('export-filename').fill(opts.fileName);
	const planPath = page.getByTestId('plan-path');
	await expect(planPath).toContainText(opts.expectPath, { timeout: 30_000 });
	if (opts.expectBlocker) await expect(page.getByTestId('plan-blockers')).toContainText(opts.expectBlocker);
	const before = new Set(
		JobListResponseSchema.parse(await (await request.get('/api/jobs')).json()).jobs.map((j) => j.id),
	);
	// A sticky notice from the previous export ("Export finished · Download") must not cover the footer.
	await expect(page.getByTestId('export-start')).toBeEnabled();
	await page.getByTestId('export-start').click({ timeout: 10_000 });
	await expect(page.getByTestId('export-mode')).toBeHidden();
	let jobId = '';
	await expect
		.poll(async () => {
			const { jobs } = JobListResponseSchema.parse(await (await request.get('/api/jobs')).json());
			jobId = jobs.find((j) => j.kind === 'export' && !before.has(j.id))?.id ?? '';
			return jobId;
		})
		.not.toBe('');
	const job = await waitForJob(request, jobId, opts.jobTimeoutMs);
	expect(job.state, JSON.stringify(job.error ?? null)).toBe('succeeded');
	const jobsPanel = page.getByTestId('jobs-panel');
	await expect(jobsPanel).toBeVisible();
	const row = jobsPanel.locator(`[data-testid="job-row"][data-job-id="${jobId}"]`);
	await expect(row).toHaveAttribute('data-status', /succeeded|done|finished/i, { timeout: 30_000 });
	const download = page.waitForEvent('download');
	await row.getByTestId('job-download').click();
	const d = await download;
	const file = join(opts.outDir, opts.fileName);
	await d.saveAs(file);
	return { file, job: { ...job, result: ExportResultSchema.parse(job.result) } };
}

/** Mean luma (0–255) of a region (fractions of the frame) of the frame at `timeSec`, decoded with ffmpeg. */
export function regionLuma(
	file: string,
	timeSec: number,
	region: { x: number; y: number; w: number; h: number },
): number {
	const crop = `crop=iw*${region.w}:ih*${region.h}:iw*${region.x}:ih*${region.y}`;
	const raw = execFileSync(
		process.env.JASPER_FFMPEG ?? 'ffmpeg',
		[
			'-v',
			'error',
			'-ss',
			String(timeSec),
			'-i',
			file,
			'-frames:v',
			'1',
			'-vf',
			`${crop},scale=64:32,format=gray`,
			'-f',
			'rawvideo',
			'pipe:1',
		],
		{ maxBuffer: 1 << 20 },
	);
	let sum = 0;
	for (const b of raw) sum += b;
	return raw.length ? sum / raw.length : 0;
}
