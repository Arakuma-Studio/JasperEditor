#!/usr/bin/env node
// Performance benchmarks (docs/performance.md). Sections, run one after another so they do not compete:
//   micro   — synthetic hot paths of the model, session, timeline and engine (packages/*/bench, apps/*/bench)
//   editor  — whole-editor playback in the built app (headless Chrome): Program-monitor frames shown / dropped and
//             measured fps per scenario (one 1080p clip; a 3-layer stack; a GPU-effect stack live, then from its
//             render previews), the UI frame rate and the render bar of each scenario
//   export  — export throughput through the engine: native H.264, ProRes, smart-rendered ProRes, preview renders
// Usage: pnpm perf [--sections micro,editor,export] [--label name] [--seconds 6]
//   The editor/export sections start the built stack (e2e/serve.mjs, needs `pnpm build`) on PERF_PORT (default
//   49465) unless BASE_URL points at a running one. Results: test-results/performance/<label>.{json,md}, with the
//   machine, its load average and the host load factor of scripts/perf/budget.ts. PERF=1 fails the run when a
//   documented budget is missed (else budgets scale with the measured load and misses are reported).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name, dflt) => {
	const a = process.argv.find((x) => x.startsWith(`--${name}=`));
	if (a) return a.slice(name.length + 3);
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : dflt;
};
const sections = (arg('sections', 'micro,editor,export') ?? '').split(',').filter(Boolean);
const label = arg('label', new Date().toISOString().replace(/[:.]/g, '-'));
const seconds = Number(arg('seconds', '6'));
const strict = process.env.PERF === '1';
const report = {
	label,
	at: new Date().toISOString(),
	machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, node: process.version },
	loadavg: loadavg().map((x) => Math.round(x * 10) / 10),
	strict,
	sections: {},
	budgets: [],
};

/** The documented budgets (docs/performance.md) checked here: name, measured value, budget, direction. */
function budget(name, value, base, { higherIsBetter = false, scale = true } = {}) {
	const factor = strict || !scale ? 1 : report.loadFactor;
	const limit = higherIsBetter ? base / factor : base * factor;
	const ok = higherIsBetter ? value >= limit : value <= limit;
	report.budgets.push({
		name,
		value: Math.round(value * 10) / 10,
		budget: base,
		enforced: Math.round(limit * 10) / 10,
		ok,
	});
	console.log(
		`${ok ? 'ok  ' : 'MISS'} ${name}: ${value.toFixed(1)} (budget ${base}${factor !== 1 ? `, ×${factor.toFixed(2)} load` : ''})`,
	);
}

// Host load factor (the same calibration as the test budgets).
{
	const out = spawnSync(
		process.execPath,
		['--import', 'tsx', '-e', "import('./scripts/perf/budget.ts').then((m) => console.log(m.loadFactor()))"],
		{ cwd: root, encoding: 'utf8' },
	);
	report.loadFactor = Number(out.stdout.trim()) || 1;
	console.log(`host load factor ${report.loadFactor.toFixed(2)} (load average ${report.loadavg.join(' ')})`);
}

// ------------------------------------------------------------------ micro
if (sections.includes('micro')) {
	const micro = [];
	for (const benchmark of [
		'packages/project/bench/render-snapshot.ts',
		'packages/project/bench/scene-props.ts',
		'packages/session/bench/selection.ts',
		'apps/web/bench/timeline-transitions.ts',
		'apps/engine/bench/cache-references.ts',
	]) {
		console.log(`\n${benchmark}`);
		const result = spawnSync(process.execPath, ['--import', 'tsx', benchmark], {
			cwd: root,
			encoding: 'utf8',
		});
		process.stdout.write(result.stdout ?? '');
		if (result.status !== 0) {
			process.stderr.write(result.stderr ?? '');
			process.exit(result.status ?? 1);
		}
		micro.push({ benchmark, output: (result.stdout ?? '').trim().split('\n').slice(-12) });
	}
	report.sections.micro = micro;
}

// ------------------------------------------------------------------ the built stack
let server = null;
let base = process.env.BASE_URL ?? null;
async function ensureServer() {
	if (base) return base;
	const port = process.env.PERF_PORT ?? '49465';
	if (
		!existsSync(join(root, 'apps/engine/dist/engine.mjs')) ||
		!existsSync(join(root, 'apps/web/dist/index.html'))
	)
		throw new Error('Run `pnpm build` first (the editor and export sections use the built stack)');
	server = spawn(process.execPath, [join(root, 'e2e/serve.mjs')], {
		cwd: root,
		env: { ...process.env, E2E_PORT: port },
		stdio: 'ignore',
	});
	base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${base}/health`)).ok) return base;
		} catch {
			// starting
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error('the engine did not start');
}
const api = async (path, body, method = body ? 'POST' : 'GET') => {
	const r = await fetch(`${base}${path}`, {
		method,
		headers: { 'content-type': 'application/json', 'x-jasper-api': '1' },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await r.text();
	if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
};
const fixture = (n) => join(root, 'fixtures/media', n);
const envelopeOf = (doc) => ({
	format: 'jasper-project',
	schemaVersion: doc.schemaVersion,
	savedAt: new Date().toISOString(),
	savedBy: { app: 'JasperEditor', version: '0.1.0', platform: 'perf' },
	revision: 1,
	document: doc,
});

async function waitJob(id) {
	for (;;) {
		const j = await api(`/api/jobs/${id}`);
		if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state)) return j;
		await new Promise((r) => setTimeout(r, 300));
	}
}

// ------------------------------------------------------------------ editor (playback)
async function editorSection() {
	const { chromium } = await import('@playwright/test');
	const executablePath = [
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
	].find((p) => existsSync(p));
	const browser = await chromium.launch({
		...(executablePath ? { executablePath } : {}),
		headless: true,
		args: ['--enable-features=CanvasDrawElement', '--autoplay-policy=no-user-gesture-required'],
	});
	const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
	await page.addInitScript(() => localStorage.setItem('jasper:agent-bridge', '1'));
	await page.goto(`${base}/`);
	await page.getByTestId('home-new').click();
	await page.getByTestId('new-project-name').fill(`perf-${label}`);
	await page.getByTestId('new-project-create').click();
	await page.getByTestId('timeline-track-area').waitFor({ timeout: 120_000 });
	await page.waitForFunction(() => !!window.jasper, null, { timeout: 60_000 });
	await page.getByTestId('project-panel').click({ position: { x: 40, y: 10 } });
	const chooser = page.waitForEvent('filechooser');
	await page.keyboard.press('Control+KeyI');
	await (await chooser).setFiles([fixture('clip-a.mp4'), fixture('clip-b.mp4')]);
	for (const n of ['clip-a.mp4', 'clip-b.mp4'])
		await page.getByTestId('project-row').filter({ hasText: n }).waitFor({ timeout: 120_000 });
	await page.waitForFunction(() => !!window.__jasperMonitor, null, { timeout: 240_000 });
	const tx = (commands) =>
		page.evaluate(
			(c) => window.jasper.transact({ protocol: 'jasper.tx/1', label: 'perf', commands: c }),
			commands,
		);
	const clear = async () => {
		const ids = await page.evaluate(() => {
			const s = window.__jasperMonitor.session;
			const doc = s.getCommitted();
			const seq = doc.sequences[s.getState().activeSequenceId];
			return Object.keys(seq.clips);
		});
		if (ids.length) await tx([{ type: 'clip.lift', clipIds: ids }]);
	};
	const play = async (name) => {
		await page.waitForTimeout(1500);
		const r = await page.evaluate(async (secs) => {
			const { session, driver } = window.__jasperMonitor;
			const t = session.transport;
			t.pause();
			t.seek(0);
			await new Promise((res) => setTimeout(res, 800));
			t.play(1);
			const frames0 = driver.stats.framesShown;
			const dropped0 = driver.stats.framesDropped;
			const t0 = performance.now();
			let raf = 0;
			const tick = () => {
				raf++;
				if (performance.now() - t0 < secs * 1000) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
			await new Promise((res) => setTimeout(res, secs * 1000));
			const dt = (performance.now() - t0) / 1000;
			const st = driver.stats;
			t.pause();
			return {
				shown: st.framesShown - frames0,
				dropped: st.framesDropped - dropped0,
				fps: (st.framesShown - frames0) / dt,
				uiFps: raf / dt,
				stallsRecovered: st.stallsRecovered,
				bufferingMs: Math.round(st.bufferingMs),
			};
		}, seconds);
		const bar = await page.evaluate(() =>
			[...document.querySelectorAll('[data-testid="timeline-render-bar"] [data-render-state]')].map((e) =>
				e.getAttribute('data-render-state'),
			),
		);
		const out = {
			scenario: name,
			...r,
			fps: Math.round(r.fps * 10) / 10,
			uiFps: Math.round(r.uiFps * 10) / 10,
			renderBar: bar,
		};
		console.log(
			`  ${name}: ${out.shown} shown, ${out.dropped} dropped, ${out.fps} fps, UI ${out.uiFps} fps, bar ${bar.join(',') || '(none)'}`,
		);
		return out;
	};
	const results = [];
	await tx([{ type: 'clip.place', source: { mediaByName: 'clip-a.mp4' }, at: 0 }]);
	results.push(await play('single 1080p H.264'));
	await clear();
	await tx([
		{ type: 'clip.place', source: { mediaByName: 'clip-a.mp4' }, at: 0, tracks: { video: 'V1' } },
		{ type: 'clip.place', source: { mediaByName: 'clip-b.mp4' }, at: 0, tracks: { video: 'V2' }, ref: '$b' },
		{ type: 'param.set', target: ['clip', '$b', 'transform', 'scale'], value: 60 },
		{ type: 'param.set', target: ['clip', '$b', 'opacity'], value: 80 },
		{ type: 'clip.place', source: { mediaByName: 'clip-a.mp4' }, at: 0, tracks: { video: 'V3' }, ref: '$c' },
		{ type: 'param.set', target: ['clip', '$c', 'transform', 'scale'], value: 35 },
	]);
	results.push(await play('stack of 3 (scaled, translucent)'));
	await clear();
	await tx([
		{ type: 'clip.place', source: { mediaByName: 'clip-a.mp4' }, at: 0, ref: '$a' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.gaussian-blur' },
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.black-white' },
	]);
	results.push(await play('GPU effects, live'));
	// Render Effects In to Out, then the same playback from the previews.
	const t0 = Date.now();
	// Render Effects In to Out through the engine (the same request the command sends), then wait for green.
	await page.evaluate(async () => {
		const s = window.__jasperMonitor.session;
		const doc = s.getCommitted();
		const sequenceId = s.getState().activeSequenceId;
		const envelope = {
			format: 'jasper-project',
			schemaVersion: doc.schemaVersion,
			savedAt: new Date().toISOString(),
			savedBy: { app: 'JasperEditor', version: '0.1.0', platform: 'perf' },
			revision: s.revision,
			document: doc,
		};
		const r = await fetch('/api/previews/render?wait=1', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-jasper-api': '1' },
			body: JSON.stringify({ envelope, sequenceId, mode: 'effects' }),
		});
		if (!r.ok) throw new Error(await r.text());
	});
	const rendered = await page
		.waitForFunction(
			() =>
				document.querySelectorAll('[data-testid="timeline-render-bar"] [data-render-state]').length > 0 &&
				[...document.querySelectorAll('[data-testid="timeline-render-bar"] [data-render-state]')].every(
					(e) => e.getAttribute('data-render-state') === 'green',
				),
			null,
			{ timeout: 600_000 },
		)
		.then(() => true)
		.catch(() => false);
	const renderSec = (Date.now() - t0) / 1000;
	console.log(`  previews rendered: ${rendered} in ${renderSec.toFixed(1)} s`);
	results.push({
		...(await play('GPU effects, from previews')),
		previewRenderSeconds: renderSec,
		previewsRendered: rendered,
	});
	await browser.close();
	report.sections.editor = results;
	const fps = 30;
	budget('single 1080p H.264 playback (fps)', results[0].fps, 0.9 * fps, { higherIsBetter: true });
	budget('previewed GPU-effect playback (fps)', results[3].fps, 0.9 * fps, { higherIsBetter: true });
	budget(
		'stalls recovered by the watchdog',
		results.reduce((n, r) => Math.max(n, r.stallsRecovered), 0),
		0,
		{ scale: false },
	);
}

// ------------------------------------------------------------------ export throughput
async function exportSection() {
	const proj = await api('/api/projects', { name: `perf-export-${label}`, preset: 'hd-1080p-30' });
	const projectId = proj.projectId ?? proj.project?.projectId;
	const reg = await api('/api/media/register', { projectId, paths: [fixture('clip-a.mp4')] });
	const media = reg.items[0];
	const docOf = async () => (await api('/api/agent/query', { projectId, query: 'doc.get', args: {} })).result;
	const tx = (commands) =>
		api('/api/agent/tx', { projectId, protocol: 'jasper.tx/1', label: 'perf', commands });
	const { mediaKey: _k, browserPlayable: _b, ...asset } = media;
	await tx([{ type: 'media.register', asset: { ...asset, derivation: null } }]);
	await tx([{ type: 'clip.place', source: { mediaByName: 'clip-a.mp4' }, at: 0 }]);
	const doc = await docOf();
	const seqId = Object.keys(doc.sequences)[0];
	const envelope = envelopeOf(doc);
	const video = (codec, extra = {}) => ({
		codec,
		width: 1920,
		height: 1080,
		frameRate: { num: 30, den: 1 },
		scaling: 'fit',
		quality: { mode: 'crf', value: 18 },
		encoderSpeed: 'fast',
		colorTags: 'rec709',
		...extra,
	});
	const runs = [
		{
			name: 'native H.264',
			settings: {
				container: 'mp4',
				video: video('h264'),
				audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
				smartRender: false,
			},
		},
		{
			name: 'native ProRes 422 HQ',
			settings: {
				container: 'mov',
				video: video('prores', { proresProfile: 'hq' }),
				audio: { codec: 'pcm', sampleRate: 48000, channels: 2 },
			},
		},
		{
			name: 'smart-rendered H.264',
			settings: {
				container: 'mp4',
				video: video('h264'),
				audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
				smartRender: true,
			},
		},
	];
	const results = [];
	for (const r of runs) {
		const settings = {
			sequenceId: seqId,
			range: { type: 'entire' },
			engine: 'auto',
			destination: { type: 'download' },
			...r.settings,
		};
		const job = await api('/api/exports', { envelope, sequenceId: seqId, settings });
		const done = await waitJob(job.id);
		const secs = (Date.parse(done.finishedAt) - Date.parse(done.startedAt)) / 1000;
		const frames = done.result?.frames ?? 0;
		const out = {
			name: r.name,
			state: done.state,
			path: done.result?.renderPath,
			frames,
			seconds: Math.round(secs * 10) / 10,
			fps: Math.round((frames / Math.max(1e-3, secs)) * 10) / 10,
		};
		console.log(
			`  ${r.name}: ${out.state} ${out.path ?? ''} ${frames} frames in ${out.seconds} s = ${out.fps} fps`,
		);
		results.push(out);
	}
	const pv = await api('/api/previews/render?wait=1', { envelope, sequenceId: seqId, mode: 'all' });
	if (pv?.result) {
		const secs = (Date.parse(pv.finishedAt) - Date.parse(pv.startedAt)) / 1000;
		results.push({
			name: 'render previews (I-frame H.264)',
			state: pv.state,
			frames: pv.result.frames,
			seconds: Math.round(secs * 10) / 10,
			fps: Math.round((pv.result.frames / Math.max(1e-3, secs)) * 10) / 10,
		});
		console.log(`  render previews: ${pv.result.frames} frames in ${secs.toFixed(1)} s`);
	}
	report.sections.export = results;
	const realtime = 30;
	budget('native H.264 export (fps)', results[0].fps, realtime, { higherIsBetter: true });
	if (results[2]?.path === 'copy')
		budget('smart-rendered H.264 export (fps)', results[2].fps, 4 * realtime, { higherIsBetter: true });
}

try {
	if (sections.includes('editor') || sections.includes('export')) {
		await ensureServer();
		console.log(`\nbuilt stack: ${base}`);
	}
	if (sections.includes('editor')) {
		console.log('\neditor playback');
		await editorSection();
	}
	if (sections.includes('export')) {
		console.log('\nexport throughput');
		await exportSection();
	}
} finally {
	if (server) server.kill('SIGTERM');
}

const dir = join(root, 'test-results', 'performance');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `${label}.json`), JSON.stringify(report, null, 1));
const md = [
	`# Performance run ${label}`,
	'',
	`${report.at} · ${report.machine.cpu} × ${report.machine.cores} · Node ${report.machine.node} · load ${report.loadavg.join(' ')} · load factor ${report.loadFactor.toFixed(2)}${strict ? ' · strict (PERF=1)' : ''}`,
	'',
	'| Budget | Measured | Budget | Enforced | OK |',
	'|---|---|---|---|---|',
	...report.budgets.map(
		(b) => `| ${b.name} | ${b.value} | ${b.budget} | ${b.enforced} | ${b.ok ? 'yes' : '**no**'} |`,
	),
	'',
];
writeFileSync(join(dir, `${label}.md`), md.join('\n'));
console.log(`\nreport: test-results/performance/${label}.{json,md}`);
if (strict && report.budgets.some((b) => !b.ok)) process.exit(1);
