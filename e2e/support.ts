// Shared helpers for the E2E specs (WP-3I). The in-page agent API (`window.jasper`, ARCHITECTURE §11) is
// enabled with `localStorage['jasper:agent-bridge'] = '1'` and used for *assertions* (document state,
// history); every edit in the smoke flow goes through the real UI (pointer, keyboard, menus, DnD).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type APIRequestContext, expect, type Locator, type Page } from '@playwright/test';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = join(ROOT, 'fixtures', 'media');

export type ClipRow = {
	id: string;
	kind: string;
	name: string;
	track: string;
	start: number;
	end: number;
	duration: number;
	linked: string[];
};

export type HistoryEntry = { label: string; origin: unknown; applied: boolean };

/** Engine info written by e2e/serve.mjs (port + temp appdir). */
export function serverInfo(): { port: number; appdir: string } {
	return JSON.parse(readFileSync(join(ROOT, 'test-results', 'e2e-server.json'), 'utf8'));
}

/** Collects page errors and failed engine requests so a spec can assert there were none. */
export function watchPage(page: Page): { errors: string[] } {
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(`console: ${m.text()}`);
	});
	return { errors };
}

export async function enableAgentBridge(page: Page): Promise<void> {
	await page.addInitScript(() => window.localStorage.setItem('jasper:agent-bridge', '1'));
}

/** Runs an agent query in the page (S01 §21.2). */
export async function query<T = unknown>(
	page: Page,
	name: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	return (await page.evaluate(
		([n, a]) => {
			const api = (window as unknown as { jasper?: { query(n: string, a: unknown): Promise<unknown> } })
				.jasper;
			if (!api) throw new Error('window.jasper is not installed');
			return api.query(n, a);
		},
		[name, args] as const,
	)) as T;
}

export async function clips(page: Page, tracks?: string[]): Promise<ClipRow[]> {
	const r = await query<{ clips: ClipRow[] }>(page, 'sequence.clipsInRange', {
		from: 0,
		to: 10_000_000,
		...(tracks ? { tracks } : {}),
	});
	return [...r.clips].sort((a, b) => a.track.localeCompare(b.track) || a.start - b.start);
}

export async function history(page: Page): Promise<{ entries: HistoryEntry[]; position: number }> {
	return query(page, 'history.list');
}

/** Labels of the applied (not undone) history entries. */
export async function appliedLabels(page: Page): Promise<string[]> {
	const h = await history(page);
	return h.entries.filter((e) => e.applied).map((e) => e.label);
}

export async function playheadFrame(page: Page): Promise<number> {
	return (await query<{ frame: number }>(page, 'playhead.get')).frame;
}

export async function sequenceSummary(page: Page): Promise<{
	id: string;
	settings: { width: number; height: number; frameRate: { num: number; den: number } };
	duration: number;
	durationFrames?: number;
	markers: { name?: string; frame?: number; start?: number }[];
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
	await expect.poll(() => page.evaluate(() => !!(window as { jasper?: unknown }).jasper)).toBe(true);
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

export function timelineArea(page: Page): Locator {
	return page.getByTestId('timeline-track-area');
}

export function trackRow(page: Page, trackId: string): Locator {
	return page.locator(`[data-testid="timeline-track-area"] [data-track-id="${trackId}"]`).first();
}

export function clipElement(page: Page, clipId: string): Locator {
	return page.locator(`[data-testid="timeline-track-area"] [data-clip-id="${clipId}"]`).first();
}

/** Box of a clip body in the timeline. */
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

export type ProbeResult = {
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

/** Waits for an engine job to finish (GET /api/jobs/:id). */
export async function waitForJob(
	request: APIRequestContext,
	jobId: string,
	timeoutMs = 240_000,
): Promise<{ state: string; result?: Record<string, unknown>; error?: unknown }> {
	const t0 = Date.now();
	for (;;) {
		const res = await request.get(`/api/jobs/${jobId}`);
		expect(res.ok()).toBe(true);
		const body = await res.json();
		const job = body.job ?? body;
		if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state)) return job;
		if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} still ${job.state} after ${timeoutMs} ms`);
		await new Promise((r) => setTimeout(r, 500));
	}
}
