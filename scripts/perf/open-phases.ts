// Where the time of opening a project goes (workstream polish, docs/performance.md §6): opens a generated project in
// the built app (headless Chrome) inside a Chrome trace and reports the phases of the open and the renderer main
// thread's work by kind.
//
//   pnpm exec tsx scripts/perf/open-phases.ts [fixture=items:2000] [--runs 3] [--warm] [--compare key=value] [--json]
//     --warm: the runs share one browser context (HTTP cache warm, as when the editor is opened again)
//     Starts the built stack (e2e/serve.mjs, needs `pnpm build`) on PERF_PORT (default 49465) unless BASE_URL is set.
//
// Phases (ms from navigation start): `document` (index.html answered), `project` (GET /api/projects/:id finished: the
// engine read the file), `shell` (the timeline is on screen and the agent bridge is up: the editor is interactive),
// `media` (every medium left "resolving": the Project panel shows its real state).
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import { cachedFixture } from './ui-run.ts';
import { Tracer, uploadProject } from './ui-scenarios.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

export type OpenPhases = {
	fixture: string;
	/** Bytes of the project file the engine sent. */
	projectBytes: number;
	document: number;
	project: number;
	shell: number;
	media: number;
	/** Requests the page made while opening, by kind. */
	requests: Record<string, number>;
	/** Renderer main-thread time by kind of work until `media` (ms; scripting includes compilation and GC). */
	work: Record<string, number>;
	longestTask: number;
};

type TraceEvent = {
	name: string;
	cat: string;
	ph: string;
	ts: number;
	dur?: number;
	pid: number;
	tid: number;
};

const KIND: Record<string, string> = {
	EvaluateScript: 'scripting',
	'v8.compile': 'scripting',
	'v8.compileModule': 'scripting',
	'v8.evaluateModule': 'scripting',
	FunctionCall: 'scripting',
	EventDispatch: 'scripting',
	TimerFire: 'scripting',
	FireAnimationFrame: 'scripting',
	RunMicrotasks: 'scripting',
	XHRReadyStateChange: 'scripting',
	MinorGC: 'gc',
	MajorGC: 'gc',
	Layout: 'layout',
	UpdateLayoutTree: 'style',
	RecalculateStyles: 'style',
	ParseHTML: 'parse',
	ParseAuthorStyleSheet: 'parse',
	Paint: 'paint',
	PrePaint: 'paint',
	Layerize: 'paint',
	Commit: 'paint',
	UpdateLayer: 'paint',
};

/** Self time by kind on the renderer main thread (nested events are charged to the innermost known kind). */
function workByKind(
	events: TraceEvent[],
	from: number,
	to: number,
): { work: Record<string, number>; longest: number } {
	const main = new Map<string, number>();
	for (const e of events)
		if (e.name === 'BeginMainThreadFrame' || e.name === 'Layout')
			main.set(`${e.pid}:${e.tid}`, (main.get(`${e.pid}:${e.tid}`) ?? 0) + 1);
	const thread = [...main].sort((a, b) => b[1] - a[1])[0]?.[0];
	const own = events
		.filter(
			(e) => e.ph === 'X' && `${e.pid}:${e.tid}` === thread && e.ts >= from && e.ts <= to && (e.dur ?? 0) > 0,
		)
		.sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
	const work: Record<string, number> = {};
	let longest = 0;
	const stack: { end: number; kind: string | null; self: number }[] = [];
	const close = (until: number) => {
		while (stack.length && stack[stack.length - 1]!.end <= until) {
			const top = stack.pop()!;
			if (top.kind) work[top.kind] = (work[top.kind] ?? 0) + top.self / 1000;
		}
	};
	for (const e of own) {
		close(e.ts);
		const dur = e.dur ?? 0;
		if (e.name === 'RunTask') longest = Math.max(longest, dur / 1000);
		const kind = KIND[e.name] ?? (e.name === 'RunTask' ? 'other' : null);
		// a known kind takes its time from the nearest ancestor that is charged
		if (kind) {
			for (let i = stack.length - 1; i >= 0; i--)
				if (stack[i]!.kind) {
					stack[i]!.self -= dur;
					break;
				}
		}
		stack.push({ end: e.ts + dur, kind: kind ?? null, self: kind ? dur : 0 });
	}
	close(Number.POSITIVE_INFINITY);
	for (const k of Object.keys(work)) work[k] = Math.round(work[k]!);
	return { work, longest: Math.round(longest) };
}

/** Opens `projectId` on a fresh page and measures the phases. */
export async function measureOpen(
	browser: Browser,
	base: string,
	projectId: string,
	fixture: string,
	opts: { trace?: boolean; localStorage?: Record<string, string>; context?: BrowserContext } = {},
): Promise<OpenPhases> {
	// A fresh context has an empty HTTP cache (a first visit); a shared one keeps it (reopening the editor).
	const page: Page = opts.context
		? await opts.context.newPage()
		: await browser.newPage({ viewport: { width: 1600, height: 960 } });
	try {
		await page.addInitScript((extra) => {
			window.localStorage.setItem('jasper:agent-bridge', '1');
			for (const [k, v] of Object.entries(extra)) window.localStorage.setItem(k, v);
		}, opts.localStorage ?? {});
		await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });
		const requests: Record<string, number> = {};
		let projectBytes = 0;
		let projectDone = 0;
		let documentDone = 0;
		const kindOf = (url: string) => {
			const p = new URL(url).pathname;
			if (p.startsWith('/api/projects/'))
				return p.split('/').length > 4 ? `project ${p.split('/')[4]}` : 'project';
			if (p.startsWith('/api/media/status')) return 'media status (batch)';
			if (p.startsWith('/api/media/')) return 'media status';
			if (p.startsWith('/media/')) return 'media files';
			if (p.startsWith('/api/')) return `api ${p.split('/')[2]}`;
			if (p.startsWith('/assets/')) return 'assets';
			return 'other';
		};
		let t0 = 0;
		page.on('request', (r) => {
			const k = kindOf(r.url());
			requests[k] = (requests[k] ?? 0) + 1;
		});
		const done = (url: string) => {
			const p = new URL(url).pathname;
			if (!documentDone && p.startsWith('/project/')) documentDone = Date.now() - t0;
			if (!projectDone && p === `/api/projects/${projectId}`) projectDone = Date.now() - t0;
		};
		page.on('requestfinished', (r) => {
			done(r.url());
			if (new URL(r.url()).pathname === `/api/projects/${projectId}`)
				void r
					.sizes()
					.then((s) => {
						projectBytes = s.responseBodySize;
					})
					.catch(() => undefined);
		});
		page.on('requestfailed', (r) => done(r.url()));

		const tracer = opts.trace === false ? null : new Tracer(page);
		await tracer?.start();
		t0 = Date.now();
		await page.goto(`${base}/project/${encodeURIComponent(projectId)}`);
		const problems: string[] = [];
		page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
		page.on('console', (m) => {
			if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 300)}`);
		});
		try {
			await page.getByTestId('timeline-track-area').waitFor({ timeout: 60_000 });
		} catch (e) {
			const text = await page.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '');
			throw new Error(
				`the editor did not open: ${(e as Error).message.split('\n')[0]}\npage: ${text}\n${problems.join('\n')}`,
			);
		}
		await page.waitForFunction(() => !!(window as { jasper?: unknown }).jasper, null, { timeout: 120_000 });
		const shell = Date.now() - t0;
		await page.waitForFunction(
			() => {
				const j = (
					window as unknown as {
						__jasperMonitor?: {
							session: {
								getState(): { media: Record<string, { availability: string }> };
								getCommitted(): { media: Record<string, unknown> };
							};
						};
					}
				).__jasperMonitor?.session;
				if (!j) return false;
				const want = Object.keys(j.getCommitted().media).length;
				const have = Object.values(j.getState().media);
				return have.length >= want && have.every((m) => m.availability !== 'resolving');
			},
			null,
			{ timeout: 120_000, polling: 25 },
		);
		const media = Date.now() - t0;
		let work: Record<string, number> = {};
		let longestTask = 0;
		if (tracer) {
			const events = (await tracer.stop()) as unknown as TraceEvent[];
			const nav = events.find((e) => e.name === 'navigationStart' || e.name === 'NavigationStart');
			let start = nav?.ts ?? Number.POSITIVE_INFINITY;
			if (!nav) for (const e of events) if (e.ts > 0 && e.ts < start) start = e.ts;
			const r = workByKind(events, start, start + media * 1000);
			work = r.work;
			longestTask = r.longest;
		}
		return {
			fixture,
			projectBytes,
			document: documentDone,
			project: projectDone,
			shell,
			media,
			requests,
			work,
			longestTask,
		};
	} finally {
		await page.close();
	}
}

async function startServer(): Promise<{ base: string; child: ChildProcess | null }> {
	if (process.env.BASE_URL) return { base: process.env.BASE_URL, child: null };
	const port = process.env.PERF_PORT ?? '49465';
	const child = spawn(process.execPath, [join(root, 'e2e/serve.mjs')], {
		cwd: root,
		env: { ...process.env, E2E_PORT: port },
		stdio: 'ignore',
	});
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 240; i++) {
		try {
			if ((await fetch(`${base}/health`)).ok) return { base, child };
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	child.kill();
	throw new Error('the built stack did not start (run `pnpm build` first)');
}

if (process.argv[1] && /open-phases\.ts$/.test(process.argv[1])) {
	const args = process.argv.slice(2);
	const fixture = args.find((a) => !a.startsWith('--') && Number.isNaN(Number(a))) ?? 'items:2000';
	const runs = Number(args[args.indexOf('--runs') + 1]) || 3;
	const { base, child } = await startServer();
	// A SIGPIPE / SIGTERM (output piped to `head`) must not leave the server behind.
	const stop = () => child?.kill('SIGTERM');
	process.on('exit', stop);
	for (const sig of ['SIGINT', 'SIGTERM', 'SIGPIPE', 'SIGHUP'] as const)
		process.on(sig, () => process.exit(1));
	process.stdout.on('error', () => process.exit(1));
	try {
		const projectId = await uploadProject(base, await cachedFixture(fixture));
		const browser = await chromium.launch({
			headless: true,
			...(existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {}),
			args: ['--enable-features=CanvasDrawElement', '--autoplay-policy=no-user-gesture-required'],
		});
		try {
			// `--compare key=value`: alternates runs without and with that localStorage entry (same host load for both),
			// for A/B checks of a switch read from localStorage.
			const cmp = args[args.indexOf('--compare') + 1];
			const variants: { name: string; localStorage?: Record<string, string> }[] =
				args.includes('--compare') && cmp?.includes('=')
					? [
							{ name: 'default' },
							{
								name: cmp,
								localStorage: { [cmp.slice(0, cmp.indexOf('='))]: cmp.slice(cmp.indexOf('=') + 1) },
							},
						]
					: [{ name: 'default' }];
			// `--warm`: every run shares one browser context, so all but the first have the bundle in the HTTP cache.
			const context = args.includes('--warm')
				? await browser.newContext({ viewport: { width: 1600, height: 960 } })
				: undefined;
			if (context) await measureOpen(browser, base, projectId, fixture, { context, trace: false });
			const all = new Map<string, OpenPhases[]>();
			for (let i = 0; i < runs; i++) {
				// alternate which variant goes first (the first open after another page closed is not the slower one)
				for (const v of i % 2 ? [...variants].reverse() : variants) {
					const r = await measureOpen(browser, base, projectId, fixture, {
						localStorage: v.localStorage,
						...(context ? { context } : {}),
					});
					all.set(v.name, [...(all.get(v.name) ?? []), r]);
					if (args.includes('--json')) console.log(`OPEN ${JSON.stringify({ variant: v.name, ...r })}`);
					else {
						console.log(
							`run ${i + 1} [${v.name}]: document ${r.document} ms · project ${r.project} ms (${(r.projectBytes / 1e6).toFixed(1)} MB) · shell ${r.shell} ms · media ${r.media} ms · longest task ${r.longestTask} ms`,
						);
						console.log(`  requests ${JSON.stringify(r.requests)}`);
						console.log(`  main thread ${JSON.stringify(r.work)}`);
					}
				}
			}
			const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
			for (const [name, rs] of all)
				console.log(
					`median [${name}]: shell ${median(rs.map((r) => r.shell))} ms · media ${median(rs.map((r) => r.media))} ms (best ${Math.min(...rs.map((r) => r.media))} ms, ${rs.length} runs)`,
				);
		} finally {
			await browser.close();
		}
	} finally {
		stop();
	}
}
