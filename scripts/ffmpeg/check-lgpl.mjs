#!/usr/bin/env node
// `pnpm ffmpeg:check [dir…]` — LGPL guard for everything FFmpeg that would ship (ARCHITECTURE D-13).
//
// Walks the given directories (default: vendor/ffmpeg-lgpl/<host platform>) and checks every FFmpeg
// artifact: ffmpeg/ffprobe executables and libavcodec/libavformat/… libraries (.so / .dylib / .dll).
// Executables this host can run are asked directly (`-hide_banner -buildconf`, `-encoders`, `-L`); other
// files (libraries, binaries for another OS) are checked through the configure line and license string
// FFmpeg embeds in them. Fails (exit 1) on --enable-gpl, --enable-nonfree, x264/x265/fdk-aac (and the
// other GPL/nonfree external libraries), a GPL/nonfree license string, or when nothing was found.
// It also fails on any @remotion/compositor-* package directory: those ship Remotion's GPL FFmpeg.
//
// Flags: --allow-empty (a tree without FFmpeg passes), --json (machine-readable report).
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join, relative } from 'node:path';
import { evaluateBuild, isFfmpegArtifact, platformKey, scanBinaryStrings, VENDOR_DIR } from './lib.mjs';

/** Executable format of a file: 'elf' | 'macho' | 'pe' | null. */
export function binaryFormat(file) {
	const fd = openSync(file, 'r');
	const b = Buffer.alloc(4);
	try {
		readSync(fd, b, 0, 4, 0);
	} finally {
		closeSync(fd);
	}
	if (b.readUInt32BE(0) === 0x7f454c46) return 'elf';
	if ([0xcffaedfe, 0xcefaedfe, 0xcafebabe].includes(b.readUInt32BE(0))) return 'macho';
	if (b[0] === 0x4d && b[1] === 0x5a) return 'pe';
	return null;
}

const HOST_FORMAT = { linux: 'elf', darwin: 'macho', win32: 'pe' }[process.platform];

function isRunnableExe(file, name) {
	return /^(ffmpeg|ffprobe)(\.exe)?$/i.test(name) && binaryFormat(file) === HOST_FORMAT;
}

function ask(file, args) {
	const r = spawnSync(file, ['-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	if (r.error || r.status !== 0) return null;
	return `${r.stdout}${r.stderr}`;
}

/** Checks one artifact; returns { file, method, problems }. */
export function checkFile(file, name) {
	if (isRunnableExe(file, name)) {
		const buildconf = ask(file, ['-buildconf']);
		const encoders = ask(file, ['-encoders']);
		const license = ask(file, ['-L']);
		if (buildconf !== null && encoders !== null && license !== null) {
			return { file, method: 'run', problems: evaluateBuild({ buildconf, encoders, license }) };
		}
		// Does not run here (missing libraries?): fall back to the embedded strings.
	}
	const s = scanBinaryStrings(readFileSync(file));
	const problems = evaluateBuild(s);
	if (!s.buildconf && /^(ffmpeg|ffprobe)|avcodec/i.test(name))
		problems.push('no embedded FFmpeg configuration found (cannot prove it is LGPL)');
	return { file, method: 'strings', problems };
}

/** Walks `root` (not following symlinks) and checks every FFmpeg artifact below it. */
export function checkTree(root) {
	const results = [];
	const offenders = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = lstatSync(p);
			if (st.isSymbolicLink()) continue;
			if (st.isDirectory()) {
				if (/^compositor-/.test(name) && dir.endsWith('@remotion')) offenders.push(p);
				if (/^@remotion\+compositor-/.test(name)) offenders.push(p);
				stack.push(p);
			} else if (st.isFile() && isFfmpegArtifact(name)) {
				results.push(checkFile(p, name));
			}
		}
	}
	for (const p of offenders)
		results.push({
			file: p,
			method: 'path',
			problems: ['Remotion compositor package (bundles a GPL FFmpeg)'],
		});
	return results;
}

function main() {
	const args = process.argv.slice(2);
	const json = args.includes('--json');
	const allowEmpty = args.includes('--allow-empty');
	const dirs = args.filter((a) => !a.startsWith('--'));
	if (dirs.length === 0) {
		const def = join(VENDOR_DIR, platformKey());
		if (!existsSync(def)) {
			console.error(
				`[ffmpeg:check] ${def} does not exist: run \`pnpm ffmpeg:lgpl\` first (or pass directories)`,
			);
			process.exit(1);
		}
		dirs.push(def);
	}
	let failed = false;
	const report = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) {
			console.error(`[ffmpeg:check] ${dir} does not exist`);
			failed = true;
			continue;
		}
		const results = checkTree(dir);
		report.push({ dir, results });
		if (results.length === 0 && !allowEmpty) {
			console.error(`[ffmpeg:check] ${dir}: no FFmpeg binaries found`);
			failed = true;
		}
		for (const r of results) {
			const rel = relative(dir, r.file) || r.file;
			if (r.problems.length) {
				failed = true;
				if (!json) console.error(`[ffmpeg:check] FAIL ${rel} (${r.method}): ${r.problems.join('; ')}`);
			} else if (!json) console.log(`[ffmpeg:check] ok   ${rel} (${r.method})`);
		}
	}
	if (json) console.log(JSON.stringify(report, null, 2));
	console.log(
		failed
			? '[ffmpeg:check] FAILED: GPL/nonfree FFmpeg would ship'
			: '[ffmpeg:check] all FFmpeg artifacts are LGPL',
	);
	process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-lgpl.mjs')) main();
