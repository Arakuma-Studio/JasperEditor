import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
	type APIRequestContext,
	expect,
	type LaunchOptions,
	type Locator,
	type Page,
} from '@playwright/test';
import type { JasperAgentApi } from '../apps/web/src/agent-bridge/types.ts';
import { EventEnvelopeSchema } from '../packages/api/src/events.ts';
import { type ExportResult, ExportResultSchema } from '../packages/api/src/exports.ts';
import {
	type EngineJob,
	EngineJobSchema,
	JobListResponseSchema,
	TERMINAL_JOB_STATES,
} from '../packages/api/src/jobs.ts';
import type { CommandInput, MediaAsset, TransactionResult } from '../packages/project/src/index.ts';

declare global {
	interface Window {
		jasper?: JasperAgentApi;
	}
}

/**
 * `launchOptions` for a spec that needs browser flags: the flags with the run's browser. A spec's `launchOptions`
 * replaces the config's whole object, so this keeps JASPER_BROWSER_EXECUTABLE (playwright.config.ts) when it is set.
 */
export function browserLaunch(args: string[]): LaunchOptions {
	const executablePath = process.env.JASPER_BROWSER_EXECUTABLE || undefined;
	return { ...(executablePath ? { executablePath } : {}), args };
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

type HistoryEntry = { label: string; applied: boolean };

/** Engine info written by e2e/serve.mjs (port + temp appdir). */
export function serverInfo(): { port: number; appdir: string } {
	return JSON.parse(readFileSync(join(ROOT, 'test-results', 'e2e-server.json'), 'utf8'));
}

/** The starter kit is indexed by the throwaway engine on start; wait for it. */
export async function libraryReady(request: APIRequestContext) {
	await expect
		.poll(
			async () => {
				const r = await request.get('/api/sounds/status');
				if (!r.ok()) return 0;
				const s = (await r.json()) as { sounds: number; indexing: unknown; needsIndex: boolean };
				return s.indexing || s.needsIndex ? 0 : s.sounds;
			},
			{ timeout: 360_000, intervals: [1000] },
		)
		.toBeGreaterThan(20);
}

/** Locate the source window in a mix by its largest normalised cross-correlation. */
export function locate(
	mix: Float32Array,
	ref: Float32Array,
	w0: number,
	w1: number,
	guess: number,
	span: number,
) {
	let best = { lag: Number.NaN, r: -2 };
	let rr = 0;
	for (let i = w0; i < w1; i++) rr += ref[i]! * ref[i]!;
	for (let lag = guess - span; lag <= guess + span; lag++) {
		let xy = 0;
		let xx = 0;
		for (let i = w0; i < w1; i++) {
			const x = mix[lag + i] ?? 0;
			xy += x * ref[i]!;
			xx += x * x;
		}
		const r = xx > 0 && rr > 0 ? xy / Math.sqrt(xx * rr) : -1;
		if (r > best.r) best = { lag, r };
	}
	return best;
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
	tracks?: { id: string; label: string }[];
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
	opts: { steps?: number } = {},
): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	const steps = opts.steps ?? 12;
	for (let i = 1; i <= steps; i++) {
		await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
	}
	await page.mouse.up();
}

/** Focuses the timeline panel without clicking a clip (click on its empty ruler-free header strip). */
export async function focusTimeline(page: Page): Promise<void> {
	await page.getByTestId('timeline-timecode').click();
	await page.keyboard.press('Escape');
}

/** Luminance standard deviation of the Program output, read from its canvases/videos in the page. */
export async function programPixels(page: Page): Promise<{ std: number }> {
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
		for (const s of sources) {
			try {
				g.drawImage(s, 0, 0, w, h);
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
		return { std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
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
	format: { duration: string };
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
	const { port } = serverInfo();
	const { cookies } = await request.storageState();
	const cookie = cookies
		.filter((c) => c.domain === '127.0.0.1' && c.name.endsWith(`_${port}`))
		.map((c) => `${c.name}=${c.value}`)
		.join('; ');
	// Subscribe before the snapshot: a job that finishes during either request is still observed.
	const events = await fetch(`http://127.0.0.1:${port}/events?since=0`, {
		headers: { cookie },
		signal: AbortSignal.timeout(timeoutMs),
	});
	expect(events.ok).toBe(true);
	if (!events.body) throw new Error('Engine event stream has no body');
	const input = Readable.fromWeb(events.body as Parameters<typeof Readable.fromWeb>[0]);
	const lines = createInterface({ input });
	const receipts = lines[Symbol.asyncIterator]();
	try {
		const res = await request.get(`/api/jobs/${jobId}`);
		expect(res.ok()).toBe(true);
		const current = EngineJobSchema.parse(await res.json());
		if (TERMINAL_JOB_STATES.has(current.state)) return current;
		for await (const line of receipts) {
			const event = EventEnvelopeSchema.parse(JSON.parse(line));
			if (event.type !== 'job.finished') continue;
			const job = EngineJobSchema.parse(event.payload);
			if (job.id === jobId && TERMINAL_JOB_STATES.has(job.state)) return job;
		}
		throw new Error(`Engine event stream closed before job ${jobId} finished`);
	} finally {
		lines.close();
		input.destroy();
	}
}

type ExportOutcome = {
	file: string;
	job: EngineJob & { result: ExportResult };
};

/** No visible toast or notice overlaps `target` (a dialog's or Export mode's action). */
export async function expectNotCoveredByToasts(page: Page, target: Locator): Promise<void> {
	const box = await target.boundingBox();
	expect(box).not.toBeNull();
	// One snapshot of every toast and notice: one that expires between two reads must not leave a read waiting for
	// it (a per-toast `innerText()` after its `boundingBox()` waited for a dismissed toast until the test timed out).
	const shown = await page.locator('[data-testid="toast"], [data-testid="notice"]').evaluateAll((els) =>
		els.map((e) => {
			const r = e.getBoundingClientRect();
			return { x: r.x, y: r.y, width: r.width, height: r.height, text: (e as HTMLElement).innerText };
		}),
	);
	for (const r of shown) {
		if (r.width <= 0 || r.height <= 0) continue;
		const overlaps =
			r.x < box!.x + box!.width &&
			r.x + r.width > box!.x &&
			r.y < box!.y + box!.height &&
			r.y + r.height > box!.y;
		expect(overlaps, `${r.text} covers the action`).toBe(false);
	}
}

export async function exportViaUi(
	page: Page,
	request: APIRequestContext,
	opts: {
		engine: 'auto' | 'native' | 'remotion';
		fileName: string;
		expectPath: RegExp;
		outDir: string;
		jobTimeoutMs?: number;
		/** Screenshot of Export mode just before Export is clicked (with whatever toasts are showing). */
		screenshot?: string;
	},
): Promise<ExportOutcome> {
	await focusTimeline(page);
	await page.keyboard.press('Control+KeyM');
	await expect(page.getByTestId('export-mode')).toBeVisible();
	await page.getByTestId('export-engine').selectOption(opts.engine);
	await page.getByTestId('export-filename').fill(opts.fileName);
	const planPath = page.getByTestId('plan-path');
	await expect(planPath).toContainText(opts.expectPath, { timeout: 30_000 });
	const before = new Set(
		JobListResponseSchema.parse(await (await request.get('/api/jobs')).json()).jobs.map((j) => j.id),
	);
	// Toasts and sticky notices (a previous "Export finished · Download") never cover the footer's actions.
	const start = page.getByTestId('export-start');
	await expect(start).toBeEnabled();
	await expectNotCoveredByToasts(page, start);
	if (opts.screenshot) await page.screenshot({ path: opts.screenshot });
	await start.click({ timeout: 10_000 });
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
