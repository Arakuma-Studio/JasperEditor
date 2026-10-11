#!/usr/bin/env node
// fframes capability routing (ARCHITECTURE §15 item 9): the same sequence with a lower-third@1 clip
// plans `native` when jasper-mg is available and `remotion` (with a blocker that says why) when the binary is
// missing. Runs two *built* engines side by side (ports DESKTOP_SMOKE_PORT-style: MG_CHECK_PORT, +1).
//
//   node e2e/mg-fallback-check.mjs      # after `pnpm build && pnpm mg:build`
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = Number(process.env.MG_CHECK_PORT ?? 48150);
const children = [];
const temps = [];
process.on('exit', () => {
	for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// This harness supplies both the engine token and editor key, as the desktop shell does.
const TOKEN = randomBytes(24).toString('base64url');
const EDITOR_KEY = randomBytes(24).toString('base64url');
const AUTH_ENV = { JASPER_LOCAL_TOKEN: TOKEN, JASPER_EDITOR_KEY: EDITOR_KEY };
const AUTH_HEADERS = { authorization: `Bearer ${TOKEN}`, cookie: `jasper_editor=${EDITOR_KEY}` };

function fail(msg) {
	console.error(`[mg-fallback] FAIL: ${msg}`);
	process.exit(1);
}

async function engine(port, extraEnv) {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-mgcheck-'));
	temps.push(appdir);
	const child = spawn(process.execPath, [join(root, 'apps/engine/dist/engine.mjs'), '--port', String(port)], {
		env: { ...process.env, JASPER_APPDIR: appdir, ...AUTH_ENV, ...extraEnv },
		stdio: ['ignore', 'ignore', 'inherit'],
	});
	children.push(child);
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${url}/health`)).ok) return url;
		} catch {
			// starting
		}
		await new Promise((r) => setTimeout(r, 250));
	}
	fail(`engine on ${port} did not start`);
}

async function call(url, method, path, body) {
	const res = await fetch(`${url}${path}`, {
		method,
		headers: { ...AUTH_HEADERS, ...(body ? { 'content-type': 'application/json' } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json();
	if (!res.ok) fail(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
	return json;
}

async function planFor(url) {
	const caps = await call(url, 'GET', '/api/capabilities');
	const { projectId } = await call(url, 'POST', '/api/projects', {
		name: 'MG check',
		preset: 'hd-1080p-29.97',
	});
	const tx = await call(url, 'POST', '/api/agent/tx', {
		projectId,
		transaction: {
			protocol: 'jasper.tx/1',
			label: 'Lower third',
			origin: { agent: 'mg-check' },
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: 150,
					track: 'V1',
					template: { id: 'lower-third', version: 1 },
				},
			],
		},
	});
	if (!tx.result.ok) fail(`tx rejected: ${JSON.stringify(tx.result.errors)}`);
	const { envelope } = await call(url, 'GET', `/api/projects/${projectId}`);
	const doc = envelope.document;
	const sequenceId = Object.keys(doc.sequences)[0];
	const plan = await call(url, 'POST', '/api/exports/plan', {
		envelope,
		sequenceId,
		settings: {
			sequenceId,
			range: { type: 'entire' },
			container: 'mp4',
			engine: 'auto',
			destination: { type: 'download' },
		},
	});
	return { fframes: caps.render.fframes, reason: caps.render.fframesReason, plan };
}

const ready = await planFor(await engine(base, {}));
const missing = await planFor(await engine(base + 1, { JASPER_MG: join(tmpdir(), 'no-such-jasper-mg') }));
console.log(`[mg-fallback] with jasper-mg: fframes=${ready.fframes}, plan=${ready.plan.path}`);
console.log(
	`[mg-fallback] binary missing: fframes=${missing.fframes} (${missing.reason}), plan=${missing.plan.path}; blockers: ${missing.plan.blockers.map((b) => b.reason).join(' | ')}`,
);
if (ready.fframes !== 'ready' || ready.plan.path !== 'native')
	fail('expected fframes ready → native (run `pnpm mg:build`)');
if (missing.fframes !== 'unavailable' || missing.plan.path !== 'remotion')
	fail('expected unavailable → remotion');
if (!missing.plan.blockers.some((b) => /fframes/.test(b.reason)))
	fail('the remotion plan does not explain why');
const artifactDir = join(root, 'test-results');
mkdirSync(artifactDir, { recursive: true });
writeFileSync(join(artifactDir, 'e2e-mg-fallback.json'), JSON.stringify({ ready, missing }, null, 2));
console.log('[mg-fallback] PASS');
process.exit(0);
