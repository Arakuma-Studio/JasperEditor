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
// Stand-alone x264/x265/fdk-aac/xvid libraries and `.asar` archives that embed a GPL FFmpeg fail too.
//
// Flags: --allow-empty (a tree without FFmpeg passes), --json (machine-readable report),
//   --packaged (the directories are packaged apps, e.g. apps/desktop/release/linux-unpacked: besides the
//   checks above, each must contain the LGPL binaries directory `ffmpeg-lgpl` with ffmpeg, ffprobe,
//   Remotion's compositor and the license + notice files; the desktop packaging runs this after packing).
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
	evaluateBuild,
	isChromiumFfmpeg,
	isFfmpegArtifact,
	isForbiddenLibrary,
	platformKey,
	scanBinaryStrings,
	VENDOR_DIR,
} from './lib.mjs';

/** Executable format of a file: 'elf' | 'macho' | 'pe' | null. */
function binaryFormat(file) {
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

/** The `libvidstab` record of the BUILDINFO.json next to an artifact (vid.stab rule, S07:PST-003). */
function vidstabRecordFor(file) {
	const info = join(dirname(file), 'BUILDINFO.json');
	if (!existsSync(info)) return undefined;
	try {
		return JSON.parse(readFileSync(info, 'utf8')).libvidstab;
	} catch {
		return undefined;
	}
}

function checkFile(file, name) {
	const vidstab = vidstabRecordFor(file);
	if (isRunnableExe(file, name)) {
		const buildconf = ask(file, ['-buildconf']);
		const encoders = ask(file, ['-encoders']);
		const license = ask(file, ['-L']);
		if (buildconf !== null && encoders !== null && license !== null) {
			return { file, method: 'run', problems: evaluateBuild({ buildconf, encoders, license, vidstab }) };
		}
		// Does not run here (missing libraries?): fall back to the embedded strings.
	}
	const s = scanBinaryStrings(readFileSync(file));
	const problems = evaluateBuild({ ...s, vidstab });
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
			} else if (st.isFile() && isChromiumFfmpeg(name)) {
				const problems = evaluateBuild(scanBinaryStrings(readFileSync(p)));
				results.push({ file: p, method: 'strings', problems, chromium: true });
			} else if (st.isFile() && isForbiddenLibrary(name)) {
				results.push({ file: p, method: 'path', problems: ['GPL/nonfree codec library'] });
			} else if (st.isFile() && /\.asar$/i.test(name)) {
				// An archive we do not unpack: any FFmpeg inside still carries its configure line.
				const problems = evaluateBuild(scanBinaryStrings(readFileSync(p)));
				if (problems.length) results.push({ file: p, method: 'strings', problems });
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

/** Files a packaged app's LGPL binaries directory must contain (tools/lgpl.ts, fetch-or-build-lgpl.mjs). */
const LGPL_DIR_NAME = 'ffmpeg-lgpl';
const LGPL_DIR_FILES = [
	/^ffmpeg(\.exe)?$/,
	/^ffprobe(\.exe)?$/,
	/^remotion(\.exe)?$/,
	/^LICENSE-FFmpeg\.txt$/,
	/^NOTICE-FFmpeg\.txt$/,
	/^BUILDINFO\.json$/,
];

function findDirs(root, name) {
	const found = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		for (const n of readdirSync(dir)) {
			const p = join(dir, n);
			const st = lstatSync(p);
			if (!st.isDirectory() || st.isSymbolicLink()) continue;
			if (n === name) found.push(p);
			else stack.push(p);
		}
	}
	return found;
}

/**
 * A packaged app (electron-builder `appOutDir`): everything FFmpeg in it must be LGPL (`checkTree`), it
 * must ship the LGPL binaries directory, and no FFmpeg may live outside that directory or `resources/bin`
 * (except the LGPL FFmpeg library Electron itself ships for playback).
 * Returns `{ results, problems }`; `problems` are the packaging-level violations.
 */
export function checkPackagedApp(root) {
	const results = checkTree(root);
	const problems = [];
	const dirs = findDirs(root, LGPL_DIR_NAME);
	if (dirs.length === 0)
		problems.push(
			`no ${LGPL_DIR_NAME} directory: the LGPL FFmpeg is not packaged (run \`pnpm ffmpeg:lgpl\`)`,
		);
	for (const d of dirs) {
		const names = readdirSync(d);
		for (const re of LGPL_DIR_FILES)
			if (!names.some((n) => re.test(n)))
				problems.push(`${relative(root, d)} is incomplete: nothing matches ${re}`);
	}
	for (const r of results) {
		if (r.method === 'path' || r.chromium || /\.asar$/i.test(r.file)) continue;
		const parent = basename(join(r.file, '..'));
		if (parent !== LGPL_DIR_NAME && parent !== 'bin')
			problems.push(`${relative(root, r.file)}: an FFmpeg binary outside ${LGPL_DIR_NAME}/ (or bin/)`);
	}
	return { results, problems };
}

function main() {
	const args = process.argv.slice(2);
	const json = args.includes('--json');
	const allowEmpty = args.includes('--allow-empty');
	const packaged = args.includes('--packaged');
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
		const { results, problems } = packaged
			? checkPackagedApp(dir)
			: { results: checkTree(dir), problems: [] };
		report.push({ dir, results, problems });
		for (const p of problems) {
			failed = true;
			if (!json) console.error(`[ffmpeg:check] FAIL ${p}`);
		}
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
