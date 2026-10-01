#!/usr/bin/env node
// Packaged-app FFmpeg check (ARCHITECTURE D-13, wp-lgpl): proves that a packed desktop app renders through
// Remotion with ONLY the LGPL FFmpeg it ships.
//
//   node e2e/packaged-lgpl-check.mjs [appOutDir]     # default apps/desktop/release/<os>-unpacked
//   (after `pnpm --filter @jasper/desktop dist:dir`)
//
//   1. license guard over the packed app (`check-lgpl.mjs --packaged`);
//   2. copies its resources to a temp directory outside the checkout (no workspace node_modules, no vendor
//      directory to fall back to) and starts the packaged engine there; poisoned `ffmpeg`/`ffprobe` come first
//      in PATH and must never be run;
//   3. /api/capabilities: ffmpeg from `resources`, LGPL license, no libx264; Remotion binaries from
//      `resources`, LGPL; no @remotion/compositor-* package is resolvable;
//   4. /api/licenses: the bundled FFmpeg entry with license text and source link;
//   5. a Remotion H.264 export (text clip) → ProRes intermediate → OpenH264, checked with the packaged ffprobe.
//
// Env: PACKAGED_CHECK_PORT (default 48530), JASPER_BROWSER_EXECUTABLE (default: system Chrome if present).
import { spawn, spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackagedApp } from '../scripts/ffmpeg/check-lgpl.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const osName = { linux: 'linux', win32: 'win', darwin: 'mac' }[process.platform];
const appOutDir = process.argv[2] ?? join(root, 'apps/desktop/release', `${osName}-unpacked`);
const port = Number(process.env.PACKAGED_CHECK_PORT ?? 48530);
const exe = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
const temps = [];
let child = null;
process.on('exit', () => {
	if (child && child.exitCode === null) child.kill('SIGTERM');
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const log = (m) => console.log(`[packaged-lgpl] ${m}`);
function fail(msg) {
	console.error(`[packaged-lgpl] FAIL: ${msg}`);
	process.exit(1);
}
const expect = (cond, msg) => {
	if (!cond) fail(msg);
};

if (!existsSync(appOutDir))
	fail(`${appOutDir} does not exist (run \`pnpm --filter @jasper/desktop dist:dir\`)`);

// 1. license guard
const guard = checkPackagedApp(appOutDir);
const violations = [
	...guard.problems,
	...guard.results.flatMap((r) => r.problems.map((p) => `${r.file}: ${p}`)),
];
expect(violations.length === 0, `license guard:\n  ${violations.join('\n  ')}`);
log(`license guard: ${guard.results.length} FFmpeg artifacts, all LGPL`);

// 2. isolated copy of the resources
const packedResources = existsSync(join(appOutDir, 'resources'))
	? join(appOutDir, 'resources')
	: fail('resources directory not found (macOS .app bundles: pass <App>.app/Contents as appOutDir)');
const work = mkdtempSync(join(tmpdir(), 'jasper-packaged-'));
temps.push(work);
const resources = join(work, 'resources');
cpSync(packedResources, resources, { recursive: true, verbatimSymlinks: true });
const appdir = join(work, 'appdir');
const lgpl = join(resources, 'ffmpeg-lgpl');

// No @remotion/compositor-* (GPL FFmpeg) is reachable from the packaged engine.
const req = createRequire(join(resources, 'engine', 'engine.mjs'));
for (const pkg of [
	'@remotion/compositor-linux-x64-gnu',
	'@remotion/compositor-linux-x64-musl',
	'@remotion/compositor-linux-arm64-gnu',
	'@remotion/compositor-darwin-arm64',
	'@remotion/compositor-darwin-x64',
	'@remotion/compositor-win32-x64-msvc',
]) {
	let found = null;
	try {
		found = req.resolve(`${pkg}/package.json`);
	} catch {
		found = null;
	}
	expect(found === null, `${pkg} is resolvable from the packaged engine: ${found}`);
}

// The packaged build must not need an ffmpeg from PATH: put poisoned `ffmpeg`/`ffprobe` first in PATH that
// leave a marker when anything runs them (the rest of PATH stays: the browser launcher needs coreutils).
const poison = join(work, 'poison-bin');
const marker = join(work, 'path-ffmpeg-was-used');
mkdirSync(poison);
for (const n of ['ffmpeg', 'ffprobe']) {
	if (process.platform === 'win32') {
		writeFileSync(join(poison, `${n}.cmd`), `@echo ${n} %*>>"${marker}"\r\n@exit /b 97\r\n`);
	} else {
		writeFileSync(join(poison, n), `#!/bin/sh\necho "${n} $*" >> '${marker}'\nexit 97\n`);
		chmodSync(join(poison, n), 0o755);
	}
}
const cleanPath = [poison, process.env.PATH ?? ''].join(delimiter);
const browser =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));
child = spawn(
	process.execPath,
	[join(resources, 'engine', 'engine.mjs'), '--port', String(port), '--appdir', appdir],
	{
		cwd: work,
		env: {
			PATH: cleanPath,
			HOME: process.env.HOME,
			JASPER_APPDIR: appdir,
			JASPER_WEB_DIR: join(resources, 'web'),
			JASPER_RESOURCES_DIR: resources,
			JASPER_HW_ENCODERS: '0',
			...(browser ? { JASPER_BROWSER_EXECUTABLE: browser } : {}),
		},
		stdio: ['ignore', 'inherit', 'inherit'],
	},
);
const url = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 240 && !up; i++) {
	try {
		up = (await fetch(`${url}/health`)).ok;
	} catch {
		await new Promise((r) => setTimeout(r, 250));
	}
	if (child.exitCode !== null) fail(`the packaged engine exited with code ${child.exitCode}`);
}
expect(up, 'the packaged engine did not start');

async function call(method, path, body) {
	const res = await fetch(`${url}${path}`, {
		method,
		headers: body ? { 'content-type': 'application/json' } : {},
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json();
	if (!res.ok) fail(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
	return json;
}

// 3. capabilities
const caps = await call('GET', '/api/capabilities');
log(
	`ffmpeg ${caps.media.ffmpegVersion} (${caps.media.ffmpegSource}, ${caps.media.encoding?.license}); Remotion binaries: ${JSON.stringify(caps.render.remotionBinaries)}`,
);
expect(caps.media.ffmpegSource === 'resources', `ffmpeg source is ${caps.media.ffmpegSource}, not resources`);
expect(caps.media.encoding?.license === 'lgpl', `ffmpeg license is ${caps.media.encoding?.license}`);
for (const gpl of ['libx264', 'libx264rgb', 'libx265', 'libfdk_aac', 'libxvid'])
	expect(!caps.media.encoders.includes(gpl), `the packaged ffmpeg has the ${gpl} encoder`);
const rb = caps.render.remotionBinaries;
expect(
	rb?.source === 'resources' && rb.lgpl === true && rb.license === 'lgpl' && !rb.message,
	`Remotion binaries: ${JSON.stringify(rb)}`,
);
expect(caps.render.remotionLocal === 'ready', `render.remotionLocal is ${caps.render.remotionLocal}`);

// 4. licenses
const lic = (await call('GET', '/api/licenses')).components.find((c) => c.id === 'ffmpeg');
expect(lic?.bundled === true, 'the FFmpeg license entry is not the bundled build');
expect(/^LGPL-(2\.1|3\.0)-or-later$/.test(lic.license), `license ${lic.license}`);
expect(/GNU LESSER GENERAL PUBLIC LICENSE/.test(lic.texts[0]?.text ?? ''), 'no LGPL text');
expect(/^https:\/\//.test(lic.sourceUrl), 'no source link');
log(`licenses: FFmpeg ${lic.version} ${lic.license}, source ${lic.sourceUrl}`);

// 5. Remotion export (H.264 → ProRes intermediate → OpenH264)
const { projectId } = await call('POST', '/api/projects', { name: 'Packaged check', preset: 'hd-720p-30' });
const tx = await call('POST', '/api/agent/tx', {
	projectId,
	transaction: {
		protocol: 'jasper.tx/1',
		label: 'Title',
		origin: { agent: 'packaged-lgpl-check' },
		commands: [{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'LGPL FFmpeg' } }],
	},
});
expect(tx.result.ok, `tx rejected: ${JSON.stringify(tx.result.errors)}`);
const { envelope } = await call('GET', `/api/projects/${projectId}`);
const sequenceId = Object.keys(envelope.document.sequences)[0];
const request = {
	envelope,
	sequenceId,
	settings: {
		sequenceId,
		range: { type: 'entire' },
		container: 'mp4',
		engine: 'remotion',
		video: {
			codec: 'h264',
			width: 640,
			height: 360,
			frameRate: { num: 30, den: 1 },
			scaling: 'fit',
			quality: { mode: 'crf', value: 23 },
			encoderSpeed: 'fast',
			colorTags: 'rec709',
		},
	},
};
const plan = await call('POST', '/api/exports/plan', request);
expect(plan.path === 'remotion', `plan path ${plan.path}`);
expect(plan.encoder?.encoder === 'libopenh264', `plan encoder ${JSON.stringify(plan.encoder)}`);
const started = await call('POST', '/api/exports', request);
let job = started;
for (let i = 0; i < 600; i++) {
	job = await call('GET', `/api/jobs/${started.id}`);
	if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state)) break;
	await new Promise((r) => setTimeout(r, 500));
}
expect(job.state === 'succeeded', `export ${job.state}: ${JSON.stringify(job.error ?? null)}`);
const result = job.result;
expect(
	result.renderPath === 'remotion' &&
		result.encoder === 'libopenh264' &&
		result.remotionOutput === 'intermediate',
	`export result ${JSON.stringify(result)}`,
);
const download = await fetch(new URL(result.downloadUrl, url));
expect(download.ok, `download ${result.downloadUrl} → ${download.status}`);
const output = join(work, 'output.mp4');
writeFileSync(output, Buffer.from(await download.arrayBuffer()));
const probe = spawnSync(
	join(lgpl, exe('ffprobe')),
	[
		'-v',
		'error',
		'-count_frames',
		'-show_entries',
		'stream=codec_type,codec_name,nb_read_frames',
		'-of',
		'json',
		output,
	],
	{ encoding: 'utf8' },
);
expect(probe.status === 0, `ffprobe failed: ${probe.stderr}`);
const video = JSON.parse(probe.stdout).streams.find((s) => s.codec_type === 'video');
expect(video?.codec_name === 'h264' && video.nb_read_frames === '30', `output ${JSON.stringify(video)}`);
expect(!readFileSync(output).includes('x264 - core'), 'the output was encoded by x264');
log(`Remotion export: ${video.codec_name}, ${video.nb_read_frames} frames, encoder ${result.encoder}`);

const conf = spawnSync(join(lgpl, exe('ffmpeg')), ['-hide_banner', '-buildconf'], { encoding: 'utf8' });
expect(
	conf.status === 0 && !/--enable-(gpl|nonfree)\b/.test(conf.stdout),
	'buildconf has --enable-gpl/--enable-nonfree',
);
expect(
	!existsSync(marker),
	`an ffmpeg from PATH was run: ${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`,
);
const artifactDir = join(root, 'test-results');
mkdirSync(artifactDir, { recursive: true });
cpSync(output, join(artifactDir, 'e2e-packaged-lgpl.mp4'));
writeFileSync(
	join(artifactDir, 'e2e-packaged-lgpl.json'),
	JSON.stringify(
		{
			ffmpegSource: caps.media.ffmpegSource,
			license: lic.license,
			renderPath: result.renderPath,
			encoder: result.encoder,
			video,
		},
		null,
		2,
	),
);
log('no ffmpeg/ffprobe from PATH was used');
log('PASS');
process.exit(0);
