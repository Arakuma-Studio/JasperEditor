// Editor UI performance scenarios (workstream ui-perf, docs/performance.md §5): scripted gestures in the built app
// (headless Chrome), measured where they run. Shared by `pnpm perf --sections ui` (scripts/perf/ui-run.ts), the
// Playwright spec e2e/ui-perf.spec.ts and the profiler (scripts/perf/ui-profile.ts).
//
// Measuring. Every scenario runs between two `console.timeStamp` marks inside a Chrome trace (CDP `Tracing`). From the
// trace: the renderer main thread's top-level tasks (`RunTask`) and its frames (`BeginMainThreadFrame`); the work of
// a frame is the main-thread time spent in tasks between its begin and the next one (a task longer than a frame makes
// its frame that long). Reported: frames, p50 / p95 / mean / max work per frame, busy fraction, wall time, and the
// frame rate (frames / wall). An in-page requestAnimationFrame loop keeps frames coming while a scenario runs (the
// idle page would otherwise not produce any), so "frames" counts what the page managed to produce.
import type { CDPSession, Page } from '@playwright/test';

export type FrameStats = {
	/** Frames begun on the main thread in the window. */
	frames: number;
	wallMs: number;
	fps: number;
	/** Main-thread work per frame (ms). */
	p50: number;
	p95: number;
	mean: number;
	max: number;
	/** Main-thread busy time over the window (0–1). */
	busy: number;
};

type TraceEvent = {
	name: string;
	cat: string;
	ph: string;
	ts: number;
	dur?: number;
	pid: number;
	tid: number;
	args?: { name?: string; data?: { message?: string } };
};

const CATEGORIES = [
	'devtools.timeline',
	'disabled-by-default-devtools.timeline',
	'disabled-by-default-devtools.timeline.frame',
	'toplevel',
	'blink.console',
	// Extra categories for investigations (e.g. `v8,disabled-by-default-v8.compile`).
	...(process.env.UIPERF_TRACE_CATEGORIES ?? '').split(',').filter(Boolean),
];

export class Tracer {
	private events: TraceEvent[] = [];
	private cdp: CDPSession | null = null;
	constructor(private readonly page: Page) {}

	async start(): Promise<void> {
		this.cdp = await this.page.context().newCDPSession(this.page);
		this.events = [];
		this.cdp.on('Tracing.dataCollected', (e: { value: TraceEvent[] }) => {
			for (const ev of e.value) this.events.push(ev);
		});
		await this.cdp.send('Tracing.start', {
			transferMode: 'ReportEvents',
			traceConfig: { includedCategories: CATEGORIES, recordMode: 'recordContinuously' },
		});
	}

	async stop(): Promise<TraceEvent[]> {
		const cdp = this.cdp;
		if (!cdp) return [];
		const done = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()));
		await cdp.send('Tracing.end');
		await done;
		await cdp.detach().catch(() => undefined);
		this.cdp = null;
		return this.events;
	}
}

const quantile = (xs: number[], q: number) => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Frame statistics of the window between the `uiperf:<id>:start` and `uiperf:<id>:end` marks. */
export function frameStats(events: TraceEvent[], id: string): FrameStats {
	const mark = (what: string) =>
		events.find((e) => e.name === 'TimeStamp' && (e.args?.data?.message ?? '') === `uiperf:${id}:${what}`);
	const a = mark('start');
	const b = mark('end');
	if (!a || !b) throw new Error(`trace has no marks for ${id}`);
	const { pid, tid } = a;
	const t0 = a.ts;
	const t1 = b.ts;
	const tasks = events
		.filter(
			(e) =>
				e.pid === pid &&
				e.tid === tid &&
				e.ph === 'X' &&
				(e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') &&
				e.ts + (e.dur ?? 0) > t0 &&
				e.ts < t1,
		)
		.sort((x, y) => x.ts - y.ts);
	// Top-level only (RunTask may nest under ThreadControllerImpl::RunTask in some builds).
	const top: { s: number; e: number }[] = [];
	for (const t of tasks) {
		const s = Math.max(t0, t.ts);
		const e = Math.min(t1, t.ts + (t.dur ?? 0));
		const last = top[top.length - 1];
		if (last && s < last.e) last.e = Math.max(last.e, e);
		else if (e > s) top.push({ s, e });
	}
	const begins = events
		.filter(
			(e) => e.pid === pid && e.tid === tid && e.name === 'BeginMainThreadFrame' && e.ts >= t0 && e.ts <= t1,
		)
		.map((e) => e.ts)
		.sort((x, y) => x - y);
	const edges = [t0, ...begins.filter((t) => t > t0), t1];
	const work: number[] = [];
	let k = 0;
	for (let i = 0; i + 1 < edges.length; i++) {
		const lo = edges[i]!;
		const hi = edges[i + 1]!;
		let busy = 0;
		while (k < top.length && top[k]!.e <= lo) k++;
		for (let j = k; j < top.length && top[j]!.s < hi; j++)
			busy += Math.min(hi, top[j]!.e) - Math.max(lo, top[j]!.s);
		// A task running across the boundary keeps the next frame from beginning: it belongs to this frame.
		work.push(busy / 1000);
	}
	const total = top.reduce((n, t) => n + (t.e - t.s), 0) / 1000;
	const wallMs = (t1 - t0) / 1000;
	const frames = begins.length;
	return {
		frames,
		wallMs: r1(wallMs),
		fps: r1(frames / (wallMs / 1000)),
		p50: r1(quantile(work, 0.5)),
		p95: r1(quantile(work, 0.95)),
		mean: r1(work.length ? total / work.length : 0),
		max: r1(Math.max(0, ...work)),
		busy: Math.round((total / Math.max(1e-9, wallMs)) * 100) / 100,
	};
}

/** A scenario's window: its id, plus hooks run right before and after it (the profiler starts and stops there). */
export type Window = { id: string; before?(): Promise<void>; after?(): Promise<void> };

/** Runs `fn` between the scenario marks with an rAF loop keeping frames coming. */
export async function marked<T>(page: Page, w: Window, fn: () => Promise<T>): Promise<T> {
	const id = w.id;
	await w.before?.();
	await page.evaluate((m) => {
		const w = window as unknown as { __uiperfRaf?: boolean };
		w.__uiperfRaf = true;
		const tick = () => {
			if (w.__uiperfRaf) requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
		console.timeStamp(m);
	}, `uiperf:${id}:start`);
	try {
		return await fn();
	} finally {
		await page.evaluate(async (m) => {
			// Let the last frame of the scenario finish before closing the window.
			await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
			console.timeStamp(m);
			(window as unknown as { __uiperfRaf?: boolean }).__uiperfRaf = false;
		}, `uiperf:${id}:end`);
		await w.after?.();
	}
}

// ------------------------------------------------------------------ the app

type Envelope = { document: { projectId: string; name: string } } & Record<string, unknown>;

/** Creates a project on the engine from an envelope (PUT over a fresh project) and returns its id. */
export async function uploadProject(base: string, envelope: Envelope): Promise<string> {
	const call = async (path: string, init: RequestInit = {}) => {
		const r = await fetch(`${base}${path}`, {
			...init,
			headers: { 'content-type': 'application/json', 'x-jasper-api': '1', ...(init.headers ?? {}) },
		});
		const text = await r.text();
		if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${r.status} ${text.slice(0, 300)}`);
		return text ? JSON.parse(text) : null;
	};
	const created = await call('/api/projects', {
		method: 'POST',
		body: JSON.stringify({ name: envelope.document.name, preset: 'hd-1080p-30' }),
	});
	const projectId: string = created.projectId;
	const fresh = await call(`/api/projects/${encodeURIComponent(projectId)}`);
	const env = {
		...envelope,
		revision: fresh.revision + 1,
		document: { ...envelope.document, projectId },
	};
	await call(`/api/projects/${encodeURIComponent(projectId)}`, {
		method: 'PUT',
		headers: { 'if-match': String(fresh.revision) },
		body: JSON.stringify(env),
	});
	return projectId;
}

/** Opens a project in the editor and waits until the timeline and the agent bridge are up. */
export async function openProject(page: Page, base: string, projectId: string): Promise<number> {
	await page.addInitScript(() => window.localStorage.setItem('jasper:agent-bridge', '1'));
	// tsx (esbuild keepNames) wraps named functions of the evaluated callbacks in `__name(…)`.
	await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });
	const t0 = Date.now();
	await page.goto(`${base}/project/${encodeURIComponent(projectId)}`);
	await page.getByTestId('timeline-track-area').waitFor({ timeout: 120_000 });
	await page.waitForFunction(() => !!(window as { jasper?: unknown }).jasper, null, { timeout: 120_000 });
	await page.waitForFunction(() => !!(window as { __jasperMonitor?: unknown }).__jasperMonitor, null, {
		timeout: 120_000,
	});
	return Date.now() - t0;
}

/** Waits for a quiet page: two frames, then `ms`. */
export async function settle(page: Page, ms = 300): Promise<void> {
	await page.evaluate(
		(t) =>
			new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, t)))),
		ms,
	);
}

type Box = { x: number; y: number; width: number; height: number };
async function box(page: Page, selector: string): Promise<Box> {
	const b = await page.locator(selector).first().boundingBox();
	if (!b) throw new Error(`no box for ${selector}`);
	return b;
}

/** Visible V1 clips (left to right), at most `max`, at least 16 px wide and left of `maxX`. */
async function visibleClips(page: Page, track: string, max: number, maxX: number) {
	return page.evaluate(
		([t, m, mx]) => {
			const out: { id: string; x: number; y: number; w: number; h: number }[] = [];
			const row = document.querySelector(`[data-testid="timeline-track-area"] [data-track-id="${t}"]`);
			if (!row) return out;
			for (const el of Array.from(row.querySelectorAll<HTMLElement>('[data-clip-id]'))) {
				const r = el.getBoundingClientRect();
				if (r.width < 16 || r.left < 0 || r.right > mx) continue;
				out.push({ id: el.dataset.clipId!, x: r.left, y: r.top, w: r.width, h: r.height });
			}
			out.sort((a, b) => a.x - b.x);
			return out.slice(0, m);
		},
		[track, max, maxX] as const,
	);
}

async function trackId(page: Page, label: string): Promise<string> {
	return page.evaluate((l) => {
		const s = (
			window as unknown as {
				__jasperMonitor: {
					session: {
						getCommitted(): { sequences: Record<string, { videoTracks: { id: string }[] }> };
						getState(): { activeSequenceId: string };
					};
				};
			}
		).__jasperMonitor.session;
		const seq = s.getCommitted().sequences[s.getState().activeSequenceId]!;
		return seq.videoTracks[Number(l.slice(1)) - 1]!.id;
	}, label);
}

export type DragResult = FrameStats & {
	clips: number;
	dragWallMs: number;
	committed: boolean;
	/** Gesture frames the Program monitor drew / skipped during the drag, and the cost of one (ms). */
	programFrames?: number;
	programSkipped?: number;
	programCostMs?: number;
};

/**
 * The perf-core drag: zoom out once (−), Shift-click up to `pick` visible V1 clips, drag them 270 px right in `steps`
 * pointer moves 16 ms apart (e2e/support.ts pointerDrag), wait for the commit.
 */
export async function dragScenario(
	page: Page,
	tracer: Window,
	opts: { pick?: number; steps?: number } = {},
): Promise<Omit<DragResult, keyof FrameStats>> {
	const steps = opts.steps ?? 30;
	await page.getByTestId('timeline-timecode').click();
	await page.keyboard.press('Escape');
	await page.keyboard.press('Minus');
	await settle(page, 500);
	const v1 = await trackId(page, 'V1');
	const clips = await visibleClips(page, v1, opts.pick ?? 11, 1150);
	if (clips.length < 4) throw new Error(`only ${clips.length} clips visible on V1`);
	await page.keyboard.down('Shift');
	for (const c of clips) await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
	await page.keyboard.up('Shift');
	await settle(page, 300);
	const history = () =>
		page.evaluate(
			() =>
				(
					window as unknown as { __jasperMonitor: { session: { getState(): { revision: number } } } }
				).__jasperMonitor.session.getState().revision,
		);
	const rev0 = await history();
	const frames = () =>
		page.evaluate(() => {
			const g = (
				window as unknown as {
					__jasperMonitor: {
						gestureFrames?: { stats(): { published: number; skipped: number; costMs: number } };
					};
				}
			).__jasperMonitor.gestureFrames;
			return g ? g.stats() : null;
		});
	const g0 = await frames();
	const from = { x: clips[0]!.x + 10, y: clips[0]!.y + clips[0]!.h / 2 };
	let dragWallMs = 0;
	await marked(page, tracer, async () => {
		const t0 = Date.now();
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		for (let i = 1; i <= steps; i++) {
			await page.mouse.move(from.x + (270 * i) / steps, from.y);
			await page.waitForTimeout(16);
		}
		await page.mouse.up();
		dragWallMs = Date.now() - t0;
	});
	const committed = await page
		.waitForFunction(
			(r) =>
				(
					window as unknown as { __jasperMonitor: { session: { getState(): { revision: number } } } }
				).__jasperMonitor.session.getState().revision > r,
			rev0,
			{ timeout: 30_000 },
		)
		.then(() => true)
		.catch(() => false);
	const g1 = await frames();
	return {
		clips: clips.length,
		dragWallMs,
		committed,
		...(g0 && g1
			? {
					programFrames: g1.published - g0.published,
					programSkipped: g1.skipped - g0.skipped,
					programCostMs: Math.round(g1.costMs * 10) / 10,
				}
			: {}),
	};
}

/** Trims the out point of a visible V2 clip left and right in `steps` moves. */
export async function trimScenario(page: Page, tracer: Window, steps = 30): Promise<void> {
	const v2 = await trackId(page, 'V2');
	const clips = await visibleClips(page, v2, 3, 1150);
	const c = clips[1] ?? clips[0];
	if (!c) throw new Error('no V2 clip visible');
	await page.keyboard.press('Escape');
	const y = c.y + c.h / 2;
	const x = c.x + c.w - 2;
	await marked(page, tracer, async () => {
		await page.mouse.move(x, y);
		await page.mouse.down();
		for (let i = 1; i <= steps; i++) {
			const dx = -Math.round(Math.sin((i / steps) * Math.PI) * Math.min(40, c.w / 2));
			await page.mouse.move(x + dx, y);
			await page.waitForTimeout(16);
		}
		await page.mouse.up();
	});
}

/**
 * Scrolls the timeline horizontally (`mode: 'scroll'`) or zooms in and out around the pointer (`'zoom'`) with one wheel
 * event per animation frame for `ms`, dispatched in the page (what a trackpad does), and returns how many frames the
 * page produced.
 */
export async function wheelScenario(
	page: Page,
	tracer: Window,
	mode: 'scroll' | 'zoom',
	ms = 3000,
): Promise<void> {
	await marked(page, tracer, async () => {
		await page.evaluate(
			([m, dur]) =>
				new Promise<void>((resolve) => {
					const el = document.querySelector<HTMLElement>('[data-testid="timeline-clip-area"]')!;
					const r = el.getBoundingClientRect();
					const t0 = performance.now();
					let i = 0;
					const tick = () => {
						const t = performance.now() - t0;
						if (t >= dur) return resolve();
						i++;
						// Scroll: 2 s right, then back. Zoom: in for 12 frames, out for 12 (Alt+wheel zooms, TL-111).
						const sign = m === 'scroll' ? (t < dur / 2 ? 1 : -1) : Math.floor(i / 12) % 2 ? 1 : -1;
						el.dispatchEvent(
							new WheelEvent('wheel', {
								deltaY: m === 'scroll' ? 0 : sign * 40,
								deltaX: m === 'scroll' ? sign * 60 : 0,
								altKey: m === 'zoom',
								clientX: r.left + r.width / 2,
								clientY: r.top + 20,
								bubbles: true,
								cancelable: true,
							}),
						);
						requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
				}),
			[mode, ms] as const,
		);
	});
}

/** Drags the playhead across the ruler in `steps` moves (scrub). */
export async function scrubScenario(page: Page, tracer: Window, steps = 40): Promise<void> {
	const ruler = await box(page, '[data-testid="timeline-ruler"]');
	const y = ruler.y + ruler.height / 2;
	await marked(page, tracer, async () => {
		await page.mouse.move(ruler.x + 20, y);
		await page.mouse.down();
		for (let i = 1; i <= steps; i++) {
			await page.mouse.move(ruler.x + 20 + ((ruler.width - 60) * i) / steps, y);
			await page.waitForTimeout(16);
		}
		await page.mouse.up();
	});
}

/** Clicks `n` clips one after another (plain clicks: each replaces the selection), then Shift-adds them. */
export async function selectionScenario(page: Page, tracer: Window, n = 20): Promise<void> {
	const ids = [await trackId(page, 'V1'), await trackId(page, 'V3')];
	const clips = [
		...(await visibleClips(page, ids[0]!, n / 2, 1500)),
		...(await visibleClips(page, ids[1]!, n / 2, 1500)),
	];
	await marked(page, tracer, async () => {
		for (const c of clips) {
			await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
			await page.waitForTimeout(16);
		}
		await page.keyboard.down('Shift');
		for (const c of clips) {
			await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
			await page.waitForTimeout(16);
		}
		await page.keyboard.up('Shift');
	});
}

/** Scrolls a scroll container (selector) by `px` per frame for `ms`, down then up. */
export async function scrollContainerScenario(
	page: Page,
	tracer: Window,
	selector: string,
	ms = 3000,
	px = 60,
): Promise<number> {
	let moved = 0;
	await marked(page, tracer, async () => {
		moved = await page.evaluate(
			([sel, dur, step]) =>
				new Promise<number>((resolve) => {
					const el = document.querySelector<HTMLElement>(sel)!;
					const t0 = performance.now();
					let max = 0;
					const tick = () => {
						const t = performance.now() - t0;
						if (t >= dur) return resolve(max);
						el.scrollTop += t < dur / 2 ? step : -step;
						max = Math.max(max, el.scrollTop);
						requestAnimationFrame(tick);
					};
					requestAnimationFrame(tick);
				}),
			[selector, ms, px] as const,
		);
	});
	return moved;
}

/** Selects the first clip and opens the Effect Controls panel (Shift+5), then scrubs the playhead over the clip. */
export async function effectControlsScenario(page: Page, tracer: Window, steps = 40): Promise<void> {
	const v1 = await trackId(page, 'V1');
	const [c] = await visibleClips(page, v1, 1, 1500);
	if (!c) throw new Error('no clip');
	await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2);
	await page.keyboard.press('Shift+Digit5');
	await page.locator('[data-testid="effect-controls-panel"]').first().waitFor({ timeout: 30_000 });
	await settle(page, 500);
	const ruler = await box(page, '[data-testid="timeline-ruler"]');
	const y = ruler.y + ruler.height / 2;
	await marked(page, tracer, async () => {
		await page.mouse.move(ruler.x + 20, y);
		await page.mouse.down();
		for (let i = 1; i <= steps; i++) {
			await page.mouse.move(ruler.x + 20 + ((Math.min(c.w, ruler.width) - 40) * i) / steps, y);
			await page.waitForTimeout(16);
		}
		await page.mouse.up();
	});
}

/** Starts a CPU profile (V8 sampling) of the page. */
export async function startProfile(page: Page): Promise<CDPSession> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
	await cdp.send('Profiler.start');
	return cdp;
}

export type CpuProfile = {
	nodes: {
		id: number;
		callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
		children?: number[];
	}[];
	samples: number[];
	timeDeltas: number[];
	startTime: number;
	endTime: number;
};

export async function stopProfile(cdp: CDPSession): Promise<CpuProfile> {
	const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: CpuProfile };
	await cdp.detach().catch(() => undefined);
	return profile;
}
