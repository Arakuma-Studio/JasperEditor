#!/usr/bin/env node
// Measures the takes and the sourcing flags (spec 12 P6-E9; wp-note "Phase 6 → WP-E5") on real recordings with the
// engine's own index: starts an engine from the source tree on a fresh appdir, optionally adds folders (indexed in
// place, declared CC0) and installs catalogue packs (downloads from their upstream sites at the engine's polite pacing:
// network), indexes, then reports per source: files, recordings with takes, takes offered / cut, judge reasons and the
// files whose type the judge rejected, before (the recording) and after (its best take). Stops the engine.
//
//   node scripts/sounds/measure-takes.mjs --appdir /tmp/x [--port 52301] [--folders /a,/b] [--packs id1,id2]
//        [--out report.json]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port ?? 52301);
const APPDIR = args.appdir;
if (!APPDIR) throw new Error('--appdir is required');
mkdirSync(APPDIR, { recursive: true });
const token = randomBytes(16).toString('hex');
const editorKey = randomBytes(16).toString('hex');
const base = `http://127.0.0.1:${PORT}`;
const headers = { authorization: `Bearer ${token}`, cookie: `jasper_editor=${editorKey}`, 'content-type': 'application/json' };

const engine = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'apps/engine/src/cli.ts'), '--port', String(PORT), '--appdir', APPDIR], {
	cwd: ROOT,
	env: { ...process.env, JASPER_LOCAL_TOKEN: token, JASPER_EDITOR_KEY: editorKey, JASPER_SOUND_AUTO_INDEX: '0' },
	stdio: ['ignore', 'ignore', 'inherit'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body) {
	const r = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
	const text = await r.text();
	if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}
async function waitJob(id) {
	for (;;) {
		const j = await api('GET', `/api/jobs/${id}`);
		if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state)) {
			if (j.state !== 'succeeded') throw new Error(`job ${id} ${j.state}: ${JSON.stringify(j.error)}`);
			return j;
		}
		await sleep(500);
	}
}

const t0 = Date.now();
try {
	for (let i = 0; ; i++) {
		try {
			if ((await fetch(`${base}/health`)).ok) break;
		} catch {}
		if (i > 600) throw new Error('the engine did not start');
		await sleep(200);
	}
	const folders = (args.folders ?? '').split(',').filter(Boolean);
	if (folders.length) {
		const r = await api('PUT', '/api/sounds/roots', {
			roots: folders.map((path) => ({ path, license: 'CC0-1.0', label: path.split('/').pop() })),
		});
		if (r.job) await waitJob(r.job.id);
	}
	for (const id of (args.packs ?? '').split(',').filter(Boolean)) {
		const job = await api('POST', `/api/sounds/packs/${id}/install`);
		const done = await waitJob(job.id);
		if (done.result?.indexJobId) await waitJob(done.result.indexJobId);
		console.error(`installed ${id}: ${done.result?.sounds} files`);
	}
	const idx = await api('POST', '/api/sounds/index', {});
	const indexed = await waitJob(idx.id);
	const lib = JSON.parse(readFileSync(join(APPDIR, 'sounds', 'library.json'), 'utf8'));
	const sounds = Object.values(lib.sounds);
	const groupOf = (e) =>
		e.source.type === 'pack' ? `pack:${e.source.packId}` : e.source.type === 'folder' ? `folder:${e.source.rootId}` : e.source.type;
	const groups = new Map();
	for (const e of sounds) {
		const g = groupOf(e);
		if (!groups.has(g)) groups.set(g, { files: 0, withTakes: 0, offered: 0, cut: 0, reasons: {}, rejected: [], examples: [] });
		const s = groups.get(g);
		s.files++;
		for (const r of e.judge?.reasons ?? []) s.reasons[r] = (s.reasons[r] ?? 0) + 1;
		const takes = e.takes ?? [];
		const offered = takes.filter((t) => t.flags.length === 0);
		if (takes.length) {
			s.withTakes++;
			s.offered += offered.length;
			s.cut += takes.length - offered.length;
		}
		if (e.judge && !e.judge.ok) {
			const best = offered.reduce((b, t) => (!b || (t.judge?.score ?? 0) > (b.judge?.score ?? 0) ? t : b), null);
			s.rejected.push({
				title: e.title,
				type: e.judge.type,
				reasons: e.judge.reasons,
				onsets: e.descriptors.onsetCount,
				durationSec: e.format.durationSec,
				takes: takes.length,
				offered: offered.length,
				bestTake: best ? { index: best.index, ok: best.judge?.ok ?? null, score: best.judge?.score ?? null, reasons: best.judge?.reasons ?? [] } : null,
				offeredOk: offered.filter((t) => t.judge?.ok).length,
			});
		}
		if (takes.length && s.examples.length < 6)
			s.examples.push({
				title: e.title,
				takes: takes.map((t) => ({ i: t.index, start: t.startSec, end: t.endSec, strokes: t.strokes, head: t.headDb, tail: t.tailDb, flags: t.flags, ok: t.judge?.ok ?? null })),
			});
	}
	const report = {
		measuredAt: new Date().toISOString(),
		seconds: Math.round((Date.now() - t0) / 1000),
		index: { analysed: indexed.result.analysed, reused: indexed.result.reused, sounds: indexed.result.sounds, errors: indexed.result.errors.length },
		snapshotHash: lib.snapshotHash,
		groups: Object.fromEntries(groups),
		materials: sounds.reduce((m, e) => {
			for (const x of e.materials ?? []) m[x] = (m[x] ?? 0) + 1;
			return m;
		}, {}),
	};
	if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 1).slice(0, 200_000));
} finally {
	engine.kill('SIGTERM');
	await Promise.race([new Promise((r) => engine.once('exit', r)), sleep(8000)]);
	if (engine.exitCode === null) engine.kill('SIGKILL');
}
