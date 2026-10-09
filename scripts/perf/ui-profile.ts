// Profiles one editor UI scenario in the built app (workstream ui-perf, docs/performance.md §5): frame statistics from a
// Chrome trace plus a V8 CPU profile mapped through the web build's source maps (self and inclusive time per function
// and per source file).
//
//   pnpm exec tsx scripts/perf/ui-profile.ts <fixture> <scenario> [--top 40] [--save dir]
//     fixture   timeline:1000 | timeline:5000 | keyframes:200 | items:2000 | scale   (scripts/perf/ui-fixtures.ts)
//     scenario  drag | trim | scroll | zoom | scrub | select | effect-controls | project-scroll | open
//   Starts the built stack (e2e/serve.mjs, needs `pnpm build`) on PERF_PORT (default 49465) unless BASE_URL is set.
//   `--save dir` writes the raw .cpuprofile and trace .json (open them in Chrome DevTools ▸ Performance).
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cachedFixture } from './ui-run.ts';
import {
	type CpuProfile,
	dragScenario,
	effectControlsScenario,
	frameStats,
	openProject,
	scrollContainerScenario,
	scrubScenario,
	selectionScenario,
	settle,
	startProfile,
	stopProfile,
	Tracer,
	trimScenario,
	uploadProject,
	wheelScenario,
} from './ui-scenarios.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1]! : dflt;
};
const [fixture = 'timeline:1000', scenario = 'drag'] = args.filter(
	(a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'),
);
const top = Number(opt('top', '40'));
const from = opt('from', '');
const noCpu = args.includes('--no-cpu');
const save = opt('save', '');

const require = createRequire(join(root, 'node_modules/.pnpm/node_modules/'));
const { SourceMapConsumer } = require('source-map-js') as typeof import('source-map-js');

async function startServer(): Promise<{ base: string; child: ChildProcess | null }> {
	if (process.env.BASE_URL) return { base: process.env.BASE_URL, child: null };
	const port = process.env.PERF_PORT ?? '49465';
	const child = spawn(process.execPath, [join(root, 'e2e/serve.mjs')], {
		cwd: root,
		env: { ...process.env, E2E_PORT: port },
		stdio: 'ignore',
	});
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${base}/health`)).ok) return { base, child };
		} catch {
			// starting
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	child.kill();
	throw new Error('the engine did not start');
}

// ------------------------------------------------------------------ profile → functions
type Mapped = { key: string; file: string };
const consumers = new Map<string, InstanceType<typeof SourceMapConsumer> | null>();
function mapFrame(cf: CpuProfile['nodes'][number]['callFrame']): Mapped {
	const m = /\/assets\/([^/?#]+\.js)/.exec(cf.url);
	if (!m) {
		const name = cf.functionName || '(anonymous)';
		return { key: cf.url ? `${name} ${cf.url.split('/').pop()}` : name, file: cf.url ? 'other' : name };
	}
	let c = consumers.get(m[1]!);
	if (c === undefined) {
		const mapFile = join(root, 'apps/web/dist/assets', `${m[1]}.map`);
		c = existsSync(mapFile) ? new SourceMapConsumer(JSON.parse(readFileSync(mapFile, 'utf8'))) : null;
		consumers.set(m[1]!, c);
	}
	if (!c) return { key: `${cf.functionName} ${m[1]}`, file: m[1]! };
	const pos = c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber });
	const src = (pos.source ?? m[1]!).replace(
		/^.*?(node_modules\/\.pnpm\/[^/]+\/node_modules\/|\.\.\/\.\.\/)/,
		'',
	);
	return { key: `${cf.functionName || pos.name || '(anon)'} ${src}:${pos.line}`, file: src };
}

function summarize(profile: CpuProfile) {
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const self = new Map<number, number>();
	for (let i = 0; i < profile.samples.length; i++) {
		const id = profile.samples[i]!;
		self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
	}
	const mapped = new Map<number, Mapped>();
	for (const n of profile.nodes) mapped.set(n.id, mapFrame(n.callFrame));
	const selfBy = new Map<string, number>();
	const fileBy = new Map<string, number>();
	for (const [id, ms] of self) {
		const m = mapped.get(id)!;
		selfBy.set(m.key, (selfBy.get(m.key) ?? 0) + ms);
		fileBy.set(m.file, (fileBy.get(m.file) ?? 0) + ms);
	}
	// Inclusive: every sample counts once for each distinct function on its stack.
	const parent = new Map<number, number>();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const incl = new Map<string, number>();
	for (const [id, ms] of self) {
		const seen = new Set<string>();
		for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
			const k = mapped.get(cur)!.key;
			if (seen.has(k)) continue;
			seen.add(k);
			incl.set(k, (incl.get(k) ?? 0) + ms);
		}
	}
	void byId;
	const total = [...self.values()].reduce((a, b) => a + b, 0);
	const idle = selfBy.get('(idle)') ?? 0;
	const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
	const firstParty = new Map([...incl].filter(([k]) => / (src|\.\.\/\.\.\/packages)\//.test(k)));
	return {
		total,
		idle,
		self: sorted(selfBy),
		files: sorted(fileBy),
		incl: sorted(incl),
		firstParty: sorted(firstParty),
	};
}

function report(profile: CpuProfile) {
	const s = summarize(profile);
	console.log(`\nCPU profile: ${s.total.toFixed(0)} ms sampled, idle ${s.idle.toFixed(0)} ms`);
	console.log('\nself time by file');
	for (const [k, ms] of s.files) console.log(`${ms.toFixed(1).padStart(9)} ms  ${k}`);
	console.log('\nself time by function');
	for (const [k, ms] of s.self) console.log(`${ms.toFixed(1).padStart(9)} ms  ${k}`);
	console.log('\ninclusive time by function');
	for (const [k, ms] of s.incl) console.log(`${ms.toFixed(1).padStart(9)} ms  ${k}`);
	console.log('\ninclusive time by first-party function');
	for (const [k, ms] of s.firstParty) console.log(`${ms.toFixed(1).padStart(9)} ms  ${k}`);
}

if (from) {
	report(JSON.parse(readFileSync(from, 'utf8')) as CpuProfile);
	process.exit(0);
}

// ------------------------------------------------------------------ run
const { base, child } = await startServer();
try {
	const envelope = await cachedFixture(
		scenario === 'project-scroll' && fixture.startsWith('timeline') ? 'items:2000' : fixture,
	);
	const projectId = await uploadProject(base, envelope);
	const browser = await chromium.launch({
		headless: true,
		...(existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {}),
		args: ['--enable-features=CanvasDrawElement', '--autoplay-policy=no-user-gesture-required'],
	});
	const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
	const tracer = new Tracer(page);
	if (scenario === 'open') await tracer.start();
	const cdpOpen = scenario === 'open' ? await startProfile(page) : null;
	const openMs = await openProject(page, base, projectId);
	console.log(`opened in ${openMs} ms`);
	// Investigation: UIPERF_CLOSE=properties,program closes those panels first (what they cost during the scenario).
	for (const kind of (process.env.UIPERF_CLOSE ?? '').split(',').filter(Boolean))
		await page.evaluate((k) => {
			const el = document.querySelector(`[data-panel-body][data-slot="${k}"]`);
			const id = el?.getAttribute('data-panel-instance') ?? el?.getAttribute('data-instance-id');
			const shell = (window as unknown as { __jasperShell?: { dock: { close(id?: string): void } } })
				.__jasperShell;
			if (id && shell) shell.dock.close(id);
		}, kind);
	await settle(page, 1500);
	const id = scenario;
	let profile: CpuProfile;
	if (scenario === 'open') {
		profile = await stopProfile(cdpOpen!);
	} else {
		await tracer.start();
		// The CPU profile covers the scenario's window only (its setup clicks stay out); `--no-cpu` measures the frames
		// without the sampling profiler's overhead.
		let cdp: Awaited<ReturnType<typeof startProfile>> | null = null;
		const t = {
			id,
			before: async () => {
				if (!noCpu) cdp = await startProfile(page);
			},
			after: async () => {
				if (cdp) windowProfile = await stopProfile(cdp);
				cdp = null;
			},
		};
		let windowProfile: CpuProfile | null = null;
		let extra: unknown = null;
		switch (scenario) {
			case 'drag':
				extra = await dragScenario(page, t);
				break;
			case 'trim':
				await trimScenario(page, t);
				break;
			case 'scroll':
			case 'zoom':
				await wheelScenario(page, t, scenario);
				break;
			case 'scrub':
				await scrubScenario(page, t);
				break;
			case 'select':
				await selectionScenario(page, t);
				break;
			case 'effect-controls':
				await effectControlsScenario(page, t);
				break;
			case 'project-scroll':
				extra = await scrollContainerScenario(page, t, '[data-testid="project-body"]');
				break;
			default:
				throw new Error(`unknown scenario ${scenario}`);
		}
		profile = (windowProfile as CpuProfile | null) ?? {
			nodes: [],
			samples: [],
			timeDeltas: [],
			startTime: 0,
			endTime: 0,
		};
		const events = await tracer.stop();
		console.log(JSON.stringify({ scenario, fixture, ...frameStats(events, id), extra }));
		if (save) {
			mkdirSync(save, { recursive: true });
			writeFileSync(join(save, `${scenario}.trace.json`), JSON.stringify({ traceEvents: events }));
		}
	}
	if (save) {
		mkdirSync(save, { recursive: true });
		writeFileSync(join(save, `${scenario}.cpuprofile`), JSON.stringify(profile));
	}
	report(profile);
	await browser.close();
} finally {
	child?.kill('SIGTERM');
}
