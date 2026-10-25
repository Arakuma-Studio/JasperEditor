#!/usr/bin/env node
// Subtitle export benchmark (spec 13 AS-076, docs/wp-notes/auto-subtitles.md "Subtitle-scale export"): builds a
// word-by-word subtitle project through the engine's agent API, exports it and samples the engine's process tree
// (peak RSS, CPU seconds) — the workloads of the textperf measurements (spec 13 §4), so before/after compare.
//
//   node scripts/perf/subtitles.mjs --case short|long9m --variant none|static|pop|pop-shake|pixelpop
//        [--warm] [--engine auto|native|remotion] [--out DIR] [--engine-url URL --token T]
//
// Without --engine-url it starts a non-dev engine of this checkout (own appdir, port 47929 or PORT) and stops it at
// the end. Cases: `short` 1080×1920 59.94, 50 s, 99 subtitles over a test-pattern video; `long9m` 1920×1080, 9 min,
// 1 080 subtitles. Variants: `pop` / `pop-shake` = textperf's (Motion scale 75 → 108 → 100 %, JetBrains Mono 130 px,
// 30 px outside stroke; S_Shake with default params on 22 %); `pixelpop` = the Pixel Pop recipe (spec 13 §0: Transform
// pop-in with a 360° shutter + S_Shake Wrap No on every subtitle, 98 px, 11.5 px stroke, soft shadow; JetBrains Mono
// stands in for the user's font). `--warm` exports a second time with the bake cache kept. Results: one JSON per
// run in --out (default test-results/subtitles), with the machine and its load before each export.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	if (i < 0) return d;
	const v = argv[i + 1];
	return v === undefined || v.startsWith('--') ? true : v;
};
const CASE = flag('case', 'short');
const VARIANT = flag('variant', 'pixelpop');
const ENGINE_MODE = flag('engine', 'auto');
const WARM = !!flag('warm', false);
const OUT = flag('out', join(root, 'test-results', 'subtitles'));
const TAG = flag('tag', `${CASE}-${VARIANT}-${ENGINE_MODE}`);
mkdirSync(OUT, { recursive: true });

const FPS = 60000 / 1001;
const CASES = {
	short: { w: 1080, h: 1920, seconds: 50, clips: 100, y: 0.5, bg: 'vertical-50s' },
	long9m: { w: 1920, h: 1080, seconds: 540, clips: 1080, y: 0.83, bg: 'wide-540s' },
};
const C = CASES[CASE];
if (!C) throw new Error(`unknown case ${CASE}`);
const totalFrames = Math.round(C.seconds * FPS);
const ffmpeg = (() => {
	const v = join(root, 'vendor', 'ffmpeg-lgpl', `${process.platform}-${process.arch}`, 'ffmpeg');
	return existsSync(v) ? v : 'ffmpeg';
})();

// ---- engine ---------------------------------------------------------------------------------------------------------
let ENGINE = flag('engine-url', null);
let TOKEN = flag('token', process.env.JASPER_LOCAL_TOKEN ?? null);
let engineProc = null;
const APPDIR = flag('appdir', join(tmpdir(), 'jasper-subtitle-bench'));
async function startEngine() {
	if (ENGINE) return;
	const port = Number(process.env.PORT ?? 47929);
	TOKEN = 'subtitle-bench-token-0123456789abcdef';
	ENGINE = `http://127.0.0.1:${port}`;
	mkdirSync(APPDIR, { recursive: true });
	engineProc = spawn(
		process.execPath,
		['--import', 'tsx', 'apps/engine/src/cli.ts', '--port', String(port), '--appdir', APPDIR],
		{ cwd: root, env: { ...process.env, JASPER_LOCAL_TOKEN: TOKEN }, stdio: ['ignore', 'ignore', 'inherit'] },
	);
	for (let i = 0; i < 600; i++) {
		try {
			const r = await fetch(`${ENGINE}/health`);
			if (r.ok) return;
		} catch {}
		await sleep(250);
	}
	throw new Error('the engine did not start');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
	const res = await fetch(ENGINE + path, {
		method,
		headers: { authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 2000)}`);
	return JSON.parse(text);
}
async function tx(projectId, commands, label = 'subtitle bench') {
	const out = await api('POST', '/api/agent/tx', {
		projectId,
		transaction: { protocol: 'jasper.tx/1', label, origin: { agent: 'subtitle-bench', runId: TAG }, commands },
	});
	if (!out.result?.ok) throw new Error(`tx "${label}" failed: ${JSON.stringify(out.result).slice(0, 3000)}`);
	return out.result;
}
async function waitJob(id, onPoll) {
	for (;;) {
		const j = await api('GET', `/api/jobs/${id}`);
		const job = j.job ?? j;
		onPoll?.(job);
		if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state)) return job;
		await sleep(500);
	}
}

// ---- /proc sampling of the engine's process tree -----------------------------------------------------------------
function tree(rootPid) {
	const stats = new Map();
	for (const n of readdirSync('/proc')) {
		if (!/^\d+$/.test(n)) continue;
		try {
			const s = readFileSync(`/proc/${n}/stat`, 'utf8');
			const r = s.slice(s.lastIndexOf(')') + 2).split(' ');
			stats.set(Number(n), {
				ppid: Number(r[1]),
				cpu: Number(r[11]) + Number(r[12]) + Number(r[13]) + Number(r[14]),
				rss: Number(r[21]) * 4096,
				comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')),
			});
		} catch {}
	}
	const kids = new Map();
	for (const [p, s] of stats) kids.set(s.ppid, [...(kids.get(s.ppid) ?? []), p]);
	const out = [];
	const stack = [rootPid];
	while (stack.length) {
		const p = stack.pop();
		const s = stats.get(p);
		if (!s) continue;
		out.push(s);
		stack.push(...(kids.get(p) ?? []));
	}
	return out;
}
function sampler(rootPid) {
	let peak = 0;
	const byComm = new Map();
	const cpu = (t) => t.reduce((a, p) => a + p.cpu, 0);
	const c0 = cpu(tree(rootPid));
	const h = setInterval(() => {
		const t = tree(rootPid);
		peak = Math.max(peak, t.reduce((a, p) => a + p.rss, 0));
		const m = new Map();
		for (const p of t) m.set(p.comm, (m.get(p.comm) ?? 0) + p.rss);
		for (const [k, v] of m) byComm.set(k, Math.max(byComm.get(k) ?? 0, v));
	}, 250);
	return () => {
		clearInterval(h);
		return {
			cpuSec: (cpu(tree(rootPid)) - c0) / 100,
			peakRssMB: Math.round(peak / 1e6),
			peakRssByCommMB: Object.fromEntries(
				[...byComm].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, Math.round(v / 1e6)]),
			),
		};
	};
}
function enginePid() {
	if (engineProc) return engineProc.pid;
	const port = new URL(ENGINE).port;
	const out = execFileSync('bash', ['-c', `ss -ltnp 'sport = :${port}' | grep -o 'pid=[0-9]*' | head -1`]).toString();
	return Number(out.replace('pid=', '').trim());
}

// ---- workload ---------------------------------------------------------------------------------------------------------
let seed = 1;
const rnd = () => {
	seed ^= seed << 13;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	return ((seed >>> 0) % 1_000_000) / 1_000_000;
};
const WORDS = (
	'hoy vamos a hacer un juego en solo siete dias y si no lo consigo me rapo la cabeza mira este nivel ' +
	'que locura el jefe final tiene mil vidas pero yo tengo un plan secreto increible nadie lo esperaba ' +
	'jugadores bug enemigo pixel arte musica epico rapido fuego salto doble espada magia tesoro'
).split(' ');
/** Back-to-back subtitles of 0.3–0.8 s and 1–4 words (deterministic), scaled to fill the case. */
function schedule() {
	const raw = Array.from({ length: C.clips }, () => 0.3 + rnd() * 0.5);
	const k = Math.min(1, C.seconds / raw.reduce((a, b) => a + b, 0));
	const out = [];
	let f = 0;
	for (let i = 0; i < C.clips; i++) {
		const d = Math.max(12, Math.round(raw[i] * k * FPS));
		if (f + d > totalFrames) break;
		const n = 1 + Math.floor(rnd() * 4);
		const text = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ').toUpperCase();
		out.push({ start: f, duration: d, text, shake: rnd() < 0.2 });
		f += d;
	}
	return out;
}
const hex = (h, a = 1) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255).concat(a);
function clipCommands(it, i, fontId) {
	const ref = `$t${i}`;
	const pixel = VARIANT === 'pixelpop';
	const style = pixel
		? {
				fontId,
				weight: 800,
				sizePx: 98,
				lineHeight: 1.1,
				fill: [1, 1, 1, 1],
				strokes: [{ color: hex('#AE00FF'), widthPx: 11.5, position: 'outside' }],
				shadow: { color: hex('#221D58', 0.8), angleDeg: 0, distancePx: 0, blurPx: 24 },
			}
		: {
				fontId,
				weight: 800,
				sizePx: 130,
				fill: [1, 1, 1, 1],
				strokes: [{ color: [0.45, 0.1, 0.75, 1], widthPx: 30, position: 'outside' }],
				shadow: { color: [0, 0, 0, 0.8], angleDeg: 135, distancePx: 12, blurPx: 8 },
			};
	const cmds = [
		{
			type: 'clip.addText',
			at: it.start,
			duration: it.duration,
			track: 'V2',
			ref,
			content: { text: it.text, style },
			...(pixel ? { box: { width: Math.round(0.75 * C.w), height: 160, autoSize: 'none' } } : {}),
			transform: { position: [C.w / 2, Math.round(C.y * C.h)] },
		},
	];
	const key = (target, sec, value) => ({ type: 'keyframe.add', target, at: { frames: Math.round(sec * FPS) }, value });
	if (VARIANT === 'pop' || VARIANT === 'pop-shake')
		for (const [f, v] of [
			[0, 75],
			[3, 108],
			[6, 100],
		])
			cmds.push({ type: 'keyframe.add', target: ['clip', ref, 'transform', 'scale'], at: { frames: f }, value: v });
	if (VARIANT === 'pop-shake' && it.shake)
		cmds.push({ type: 'effect.add', target: { clipId: ref }, effectId: 'jasper.s.shake', params: { amplitude: 1.5, frequency: 10 } });
	if (pixel) {
		const tf = `$tf${i}`;
		cmds.push(
			{
				type: 'effect.add',
				target: { clipId: ref },
				effectId: 'jasper.transform',
				params: { useCompShutterAngle: false, shutterAngle: 360 },
				ref: tf,
			},
			key(['effect', tf, 'scaleHeight'], 0, 75),
			key(['effect', tf, 'scaleHeight'], 0.1, 108),
			key(['effect', tf, 'scaleHeight'], 0.167, 100),
			key(['effect', tf, 'opacity'], 0, 0),
			key(['effect', tf, 'opacity'], 0.05, 100),
			{
				type: 'effect.add',
				target: { clipId: ref },
				effectId: 'jasper.s.shake',
				params: {
					amplitude: 0.6,
					frequency: 1,
					wrapX: 'no',
					wrapY: 'no',
					xRandAmp: 0.889,
					yRandAmp: 0.444,
					tiltRandAmp: 1,
				},
			},
		);
	}
	return cmds;
}

function backgroundMedia() {
	const dir = join(OUT, 'media');
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `bg-${C.bg}.mp4`);
	if (existsSync(file)) return file;
	const r = spawnSync(ffmpeg, [
		...['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${C.w}x${C.h}:r=60000/1001:d=${C.seconds}`],
		...['-f', 'lavfi', '-i', `sine=f=440:sample_rate=48000:d=${C.seconds}`],
		...['-c:v', 'libopenh264', '-b:v', '8M', '-c:a', 'aac', '-shortest', file],
	]);
	if (r.status !== 0) throw new Error(r.stderr.toString());
	return file;
}

// ---- run ---------------------------------------------------------------------------------------------------------------
await startEngine();
const report = {
	tag: TAG,
	case: CASE,
	variant: VARIANT,
	engineMode: ENGINE_MODE,
	commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout.toString().trim(),
	machine: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 1e9) },
	settings: { ...C, fps: FPS, totalFrames },
	startedAt: new Date().toISOString(),
};
const save = () => writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify(report, null, 2));
try {
	const bg = backgroundMedia();
	const { projectId } = await api('POST', '/api/projects', { name: `subtitle bench ${TAG}`, preset: 'hd-1080p-59.94' });
	let env = (await api('GET', `/api/projects/${projectId}`)).envelope;
	const seqId = Object.keys(env.document.sequences)[0];
	if (C.w !== 1920 || C.h !== 1080)
		await tx(projectId, [{ type: 'sequence.updateSettings', sequenceId: seqId, settings: { width: C.w, height: C.h } }]);
	const imp = JSON.parse(
		execFileSync(
			process.execPath,
			['--import', 'tsx', 'apps/mcp/src/jasper.ts', '--engine-url', ENGINE, '--token', TOKEN, '--project', projectId, '--json', 'import', bg],
			{ cwd: root },
		).toString(),
	);
	await tx(projectId, [{ type: 'clip.place', source: { mediaId: imp.imported[0].mediaId }, at: 0, tracks: { video: 'V1', audio: 'A1' } }]);
	const fontId = (await tx(projectId, [{ type: 'font.add', family: 'JetBrains Mono', ref: '$font' }])).refs.$font;
	const items = VARIANT === 'none' ? [] : schedule();
	let batch = [];
	for (const [i, it] of items.entries()) {
		const cmds = clipCommands(it, i, fontId);
		if (batch.length + cmds.length > 4000) {
			await tx(projectId, batch);
			batch = [];
		}
		batch.push(...cmds);
	}
	if (batch.length) await tx(projectId, batch);
	report.subtitles = items.length;
	env = (await api('GET', `/api/projects/${projectId}`)).envelope;
	const settings = {
		sequenceId: seqId,
		range: { type: 'entire' },
		container: 'mp4',
		video: {
			codec: 'h264',
			width: C.w,
			height: C.h,
			frameRate: { num: 60000, den: 1001 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 20 },
			encoderSpeed: 'balanced',
		},
		audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
		engine: ENGINE_MODE,
	};
	const plan = await api('POST', '/api/exports/plan', { envelope: env, sequenceId: seqId, settings });
	report.plan = { path: plan.path, blockers: plan.blockers.slice(0, 5), estimate: plan.estimate };
	rmSync(join(APPDIR, 'cache', 'layers'), { recursive: true, force: true });
	report.exports = [];
	for (let pass = 0; pass < (WARM ? 2 : 1); pass++) {
		const run = { pass: pass === 0 ? 'cold' : 'warm', loadBefore: loadavg().map((x) => Math.round(x * 100) / 100) };
		const stop = sampler(enginePid());
		const stages = [];
		const t0 = performance.now();
		const start = await api('POST', '/api/exports', { envelope: env, sequenceId: seqId, settings });
		let last = '';
		const job = await waitJob(start.id ?? start.jobId, (j) => {
			const st = (j.stage ?? '').replace(/\d+/g, '#');
			if (st !== last) stages.push({ t: Math.round(performance.now() - t0) / 1000, stage: j.stage });
			last = st;
		});
		run.wallSec = Math.round((performance.now() - t0) / 100) / 10;
		Object.assign(run, stop());
		run.state = job.state;
		run.error = job.error;
		run.renderPath = job.result?.renderPath;
		run.frames = job.result?.frames;
		run.stages = stages;
		report.exports.push(run);
		save();
		console.log(JSON.stringify({ tag: TAG, ...run, stages: undefined }));
	}
} finally {
	report.finishedAt = new Date().toISOString();
	save();
	engineProc?.kill('SIGTERM');
}
