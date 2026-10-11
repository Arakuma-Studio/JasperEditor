// Editor UI performance at scale (docs/performance.md §5): `pnpm perf --sections ui` runs this file.
// Each scenario opens a generated project in the built app (headless Chrome), runs a scripted gesture inside a Chrome
// trace and reports the main-thread work per frame (p50 / p95 / mean), the frame rate and wall time
// (scripts/perf/ui-scenarios.ts). Results are printed as one JSON line per scenario prefixed `UIPERF ` (the
// performance runner collects them) and checked against the budgets below, scaled by the host load factor like every
// timing budget (scripts/perf/budget.ts; exact with PERF=1).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { measureOpen } from './open-phases.ts';
import { uiFixtureEnvelope } from './ui-fixtures.ts';
import {
	dragScenario,
	effectControlsScenario,
	type FrameStats,
	frameStats,
	openProject,
	scrollContainerScenario,
	scrubScenario,
	selectionScenario,
	settle,
	Tracer,
	trimScenario,
	uploadProject,
	wheelScenario,
} from './ui-scenarios.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** The fixture envelope, cached under test-results/performance/fixtures (keyed by the generator's source). */
export async function cachedFixture(spec: string) {
	const key = createHash('sha1')
		.update(readFileSync(join(root, 'scripts/perf/ui-fixtures.ts')))
		.update(readFileSync(join(root, 'packages/project/src/schema/document.ts')))
		.update(spec)
		.digest('hex')
		.slice(0, 12);
	const dir = join(root, 'test-results/performance/fixtures');
	const file = join(dir, `${spec.replace(/[^a-z0-9]+/gi, '-')}-${key}.json`);
	if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
	const env = uiFixtureEnvelope(spec);
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify(env));
	return JSON.parse(JSON.stringify(env));
}

export type UiScenarioResult = FrameStats & {
	scenario: string;
	fixture: string;
	openMs?: number;
	/** polish: until every medium of the project has left "resolving" (ms from navigation start). */
	openMediaMs?: number;
	openBestMs?: number;
	/** Media status requests the open made (two batches for 2 000 media, not 2 000). */
	statusRequests?: number;
	/** Renderer main-thread time by kind of work while opening (ms). */
	work?: Record<string, number>;
	dragWallMs?: number;
	clips?: number;
	committed?: boolean;
};

/** The documented UI budgets (docs/performance.md §1). `kind: 'max'` = value ≤ budget, `'min'` = value ≥ budget. */
export const UI_BUDGETS: {
	scenario: string;
	metric: keyof UiScenarioResult;
	budget: number;
	kind: 'max' | 'min';
	what: string;
}[] = [
	{ scenario: 'drag 11 of 1 000', metric: 'mean', budget: 16, kind: 'max', what: 'mean work per frame (ms)' },
	{ scenario: 'drag 11 of 1 000', metric: 'dragWallMs', budget: 1500, kind: 'max', what: 'wall time (ms)' },
	{ scenario: 'scroll 5 000', metric: 'fps', budget: 50, kind: 'min', what: 'frame rate' },
	{ scenario: 'zoom 5 000', metric: 'fps', budget: 50, kind: 'min', what: 'frame rate' },
	{
		scenario: 'open 2 000 items',
		metric: 'openMediaMs',
		budget: 2000,
		kind: 'max',
		what: 'open to an interactive editor with every medium resolved (ms)',
	},
	{
		scenario: 'project panel 2 000 items scroll',
		metric: 'fps',
		budget: 50,
		kind: 'min',
		what: 'frame rate',
	},
];

type Ctx = { browser: Browser; base: string };

async function session(ctx: Ctx, fixture: string): Promise<{ page: Page; openMs: number }> {
	const projectId = await uploadProject(ctx.base, await cachedFixture(fixture));
	const page = await ctx.browser.newPage({ viewport: { width: 1600, height: 960 } });
	const openMs = await openProject(page, ctx.base, projectId);
	await settle(page, 1500);
	return { page, openMs };
}

async function traced(
	page: Page,
	name: string,
	fixture: string,
	fn: (t: { id: string }) => Promise<Partial<UiScenarioResult>> | Promise<void>,
): Promise<UiScenarioResult> {
	const tracer = new Tracer(page);
	await tracer.start();
	const id = name.replace(/[^a-z0-9]+/gi, '-');
	const extra = await fn({ id });
	const stats = frameStats(await tracer.stop(), id);
	return { scenario: name, fixture, ...stats, ...(extra ?? {}) };
}

/** Runs every UI scenario; `only` filters by scenario name prefix. */
export async function runUiScenarios(ctx: Ctx, only: string[] = []): Promise<UiScenarioResult[]> {
	const want = (name: string) => only.length === 0 || only.some((o) => name.startsWith(o));
	const out: UiScenarioResult[] = [];
	const log = (r: UiScenarioResult) => {
		out.push(r);
		console.log(`UIPERF ${JSON.stringify(r)}`);
	};
	if (want('drag') || want('trim') || want('scrub') || want('select')) {
		const { page, openMs } = await session(ctx, 'timeline:1000');
		if (want('drag'))
			log({
				...(await traced(page, 'drag 11 of 1 000', 'timeline:1000', (t) => dragScenario(page, t))),
				openMs,
			});
		await settle(page, 500);
		if (want('trim')) log(await traced(page, 'trim on 1 000', 'timeline:1000', (t) => trimScenario(page, t)));
		await settle(page, 500);
		if (want('scrub'))
			log(await traced(page, 'scrub on 1 000', 'timeline:1000', (t) => scrubScenario(page, t)));
		await settle(page, 500);
		if (want('select'))
			log(await traced(page, 'select on 1 000', 'timeline:1000', (t) => selectionScenario(page, t)));
		await page.close();
	}
	if (want('scroll') || want('zoom')) {
		const { page, openMs } = await session(ctx, 'timeline:5000');
		await page.getByTestId('timeline-timecode').click();
		await page.keyboard.press('Escape');
		await page.keyboard.press('Minus');
		await settle(page, 500);
		if (want('scroll'))
			log({
				...(await traced(page, 'scroll 5 000', 'timeline:5000', (t) => wheelScenario(page, t, 'scroll'))),
				openMs,
			});
		await settle(page, 500);
		if (want('zoom'))
			log(await traced(page, 'zoom 5 000', 'timeline:5000', (t) => wheelScenario(page, t, 'zoom')));
		await page.close();
	}
	if (want('effect')) {
		const { page } = await session(ctx, 'keyframes:200');
		log(
			await traced(page, 'effect controls 200 keyframes scrub', 'keyframes:200', (t) =>
				effectControlsScenario(page, t),
			),
		);
		await page.close();
	}
	// polish (docs/performance.md §6): opening a 2 000-item project — to an interactive editor with every medium
	// resolved. Three cold opens; the median counts (the phases of the best run are reported with it).
	if (want('open')) {
		const projectId = await uploadProject(ctx.base, await cachedFixture('items:2000'));
		const runs = [];
		for (let i = 0; i < 3; i++) runs.push(await measureOpen(ctx.browser, ctx.base, projectId, 'items:2000'));
		runs.sort((a, b) => a.media - b.media);
		const mid = runs[1]!;
		log({
			scenario: 'open 2 000 items',
			fixture: 'items:2000',
			frames: 0,
			wallMs: mid.media,
			fps: 0,
			p50: 0,
			p95: 0,
			mean: 0,
			max: mid.longestTask,
			busy: 0,
			openMs: mid.shell,
			openMediaMs: mid.media,
			openBestMs: runs[0]!.media,
			statusRequests: (mid.requests['media status (batch)'] ?? 0) + (mid.requests['media status'] ?? 0),
			work: mid.work,
		});
	}
	if (want('project')) {
		const { page, openMs } = await session(ctx, 'items:2000');
		log({
			...(await traced(page, 'project panel 2 000 items scroll', 'items:2000', async (t) => {
				await scrollContainerScenario(page, t, '[data-testid="project-body"]');
			})),
			openMs,
		});
		await page.close();
	}
	return out;
}

/**
 * Budget verdicts for `results` at load factor `factor` (1 = exact). The browser runs in other processes, so pass the
 * squared host factor (scripts/perf/budget.ts `parallel`).
 */
export function checkUiBudgets(results: UiScenarioResult[], factor: number) {
	return UI_BUDGETS.flatMap((b) => {
		const r = results.find((x) => x.scenario === b.scenario);
		const v = r?.[b.metric];
		if (typeof v !== 'number') return [];
		const limit = b.kind === 'max' ? b.budget * factor : b.budget / factor;
		return [
			{
				name: `${b.scenario}: ${b.what}`,
				value: v,
				budget: b.budget,
				enforced: Math.round(limit * 10) / 10,
				ok: b.kind === 'max' ? v <= limit : v >= limit,
			},
		];
	});
}

if (process.argv[1] && /ui-run\.ts$/.test(process.argv[1])) {
	const { chromium } = await import('@playwright/test');
	const base = process.env.BASE_URL;
	if (!base) {
		console.error('BASE_URL of a running built stack is required (scripts/performance.mjs starts one)');
		process.exit(2);
	}
	const browser = await chromium.launch({
		headless: true,
		...(existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {}),
		args: ['--enable-features=CanvasDrawElement', '--autoplay-policy=no-user-gesture-required'],
	});
	try {
		await runUiScenarios({ browser, base }, process.argv.slice(2));
		for (const b of UI_BUDGETS) console.log(`UIBUDGET ${JSON.stringify(b)}`);
	} finally {
		await browser.close();
	}
}
