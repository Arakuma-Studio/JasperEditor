#!/usr/bin/env node
// `pnpm ffmpeg:lgpl` (ARCHITECTURE D-13, docs/wp-notes/wp-lgpl.md): produces the LGPL FFmpeg + Remotion
// "binaries directory" under vendor/ffmpeg-lgpl/<platform>/ (gitignored):
//
//   ffmpeg, ffprobe            LGPL FFmpeg 7.1 (no --enable-gpl / --enable-nonfree, no x264/x265/fdk-aac)
//   libav*/libsw* (or *.dll)   the shared libraries, under the names both our ffmpeg and Remotion's
//                              compositor load (Linux: libavcodec.so.61 + libavcodec.so symlink)
//   remotion[.exe]             Remotion's own compositor, copied unmodified from @remotion/compositor-*
//   LICENSE-FFmpeg.txt (+ COPYING.GPLv3.txt for LGPL 3 builds), NOTICE-FFmpeg.txt, BUILDINFO.json
//
// The engine passes this directory to every Remotion call as `binariesDirectory` and uses its ffmpeg for
// the native path. Sources: a pinned BtbN "lgpl-shared" build (linux-x64, linux-arm64, win32-x64), or a
// from-source build (build-lgpl-from-source.sh; macOS has no prebuilt), or any LGPL prefix you point at.
// Every download is checked against the sha256 in manifest.json; the result is license-checked.
//
// Flags:
//   --platform <key>     linux-x64 | linux-arm64 | win32-x64 | darwin-arm64 | darwin-x64 (default: host)
//   --from-source        build FFmpeg + deps from pinned sources (host platform only; macOS default)
//   --ffmpeg-prefix <d>  use an existing LGPL FFmpeg install prefix (bin/ + lib/) instead
//   --force              re-assemble even if BUILDINFO.json matches the manifest
//   --out <dir>          output directory (default vendor/ffmpeg-lgpl/<platform>)
//   --work <dir>         download cache + source-build directory (default vendor/ffmpeg-lgpl/.cache; also
//                        JASPER_FFMPEG_WORK)
//
// vid.stab (S07:PST-003): a source build includes libvidstab from the pinned post-relicense commit
// (manifest.json `vidstab`); the prefix records it in share/jasper/libvidstab.json, which becomes
// BUILDINFO.json `libvidstab` — the only way `pnpm ffmpeg:check` accepts --enable-libvidstab.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	binaryNames,
	compositorPackage,
	evaluateBuild,
	loadManifest,
	platformKey,
	ROOT,
	rewriteElfRpath,
	scanBinaryStrings,
	sha256File,
	VENDOR_DIR,
} from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

const manifest = loadManifest();
const host = platformKey();
const key = opt('platform') ?? host;
const out = opt('out') ?? join(VENDOR_DIR, key);
const cache = opt('work') ?? process.env.JASPER_FFMPEG_WORK ?? join(VENDOR_DIR, '.cache');
const names = binaryNames(key);
const log = (m) => console.log(`[ffmpeg:lgpl] ${m}`);
const fail = (m) => {
	console.error(`[ffmpeg:lgpl] ERROR: ${m}`);
	process.exit(1);
};

const REQUIRED_ENCODERS = [
	'libopenh264',
	'libvpx',
	'libvpx-vp9',
	'prores_ks',
	'aac',
	'libopus',
	'pcm_s16le',
	'png',
];
const AV1_ENCODERS = ['libsvtav1', 'libaom-av1'];

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
	if (r.error) throw r.error;
	return r;
}

async function download(url, dest, sha256) {
	if (existsSync(dest) && (await sha256File(dest)) === sha256) {
		log(`cached ${basename(dest)}`);
		return;
	}
	mkdirSync(dirname(dest), { recursive: true });
	log(`downloading ${url}`);
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok || !res.body) fail(`download failed (${res.status}): ${url}`);
	const tmp = `${dest}.partial`;
	await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
	const got = await sha256File(tmp);
	if (got !== sha256) {
		rmSync(tmp, { force: true });
		fail(`checksum mismatch for ${url}\n  expected ${sha256}\n  got      ${got}`);
	}
	renameSync(tmp, dest);
	log(`sha256 ok ${basename(dest)}`);
}

function extract(archive, into) {
	rmSync(into, { recursive: true, force: true });
	mkdirSync(into, { recursive: true });
	if (/\.zip$/i.test(archive)) {
		const tries =
			process.platform === 'win32'
				? [
						[
							'powershell',
							[
								'-NoProfile',
								'-Command',
								`Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}'`,
							],
						],
						['tar', ['-xf', archive, '-C', into]],
					]
				: [
						['unzip', ['-q', archive, '-d', into]],
						['python3', ['-m', 'zipfile', '-e', archive, into]],
						['bsdtar', ['-xf', archive, '-C', into]],
					];
		for (const [cmd, args] of tries) {
			const r = spawnSync(cmd, args, { stdio: 'inherit' });
			if (!r.error && r.status === 0) return;
		}
		fail(`could not extract ${archive} (install unzip or python3)`);
	}
	const r = spawnSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
	if (r.status !== 0) fail(`could not extract ${archive}`);
}

/** Resolves (or `npm pack`s) the Remotion compositor package for `key`; returns its directory. */
function compositorDir() {
	const pkg = compositorPackage(key);
	if (!pkg) fail(`Remotion has no compositor package for ${key}`);
	const version = manifest.remotion.version;
	let installed = null;
	try {
		const engineReq = createRequire(join(ROOT, 'apps', 'engine', 'package.json'));
		const rendererDir = dirname(engineReq.resolve('@remotion/renderer/package.json'));
		const req = createRequire(join(rendererDir, 'package.json'));
		installed = dirname(req.resolve(`${pkg}/package.json`));
	} catch {
		// not installed for this platform
	}
	if (installed) {
		const v = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
		if (v !== version)
			fail(`${pkg} is ${v}, the manifest pins ${version}: update manifest.json (abi + sha256)`);
		return installed;
	}
	// Another platform (or the optional dependency was not installed): fetch the npm tarball.
	const dir = join(cache, 'npm', `${pkg.replace('/', '+')}@${version}`);
	if (!existsSync(join(dir, 'package', 'package.json'))) {
		mkdirSync(dir, { recursive: true });
		log(`npm pack ${pkg}@${version}`);
		const r = run('npm', ['pack', `${pkg}@${version}`, '--silent'], {
			cwd: dir,
			shell: process.platform === 'win32',
		});
		if (r.status !== 0) fail(`npm pack ${pkg}@${version} failed: ${r.stderr}`);
		const tgz = r.stdout.trim().split('\n').pop();
		extract(join(dir, tgz), join(dir, 'x'));
		renameSync(join(dir, 'x', 'package'), join(dir, 'package'));
	}
	return join(dir, 'package');
}

/** An FFmpeg install prefix (bin/, lib/ on Unix; bin/ with DLLs on Windows) for `key`. */
async function ffmpegPrefix() {
	const explicit = opt('ffmpeg-prefix');
	if (explicit) return { prefix: explicit, origin: { kind: 'prefix', path: explicit } };
	const prebuilt = manifest.prebuilt.platforms[key];
	if (flag('from-source') || !prebuilt) {
		if (key !== host) fail(`building from source only works for the host platform (${host}), not ${key}`);
		if (process.platform === 'win32')
			fail('no from-source build on Windows: use the pinned BtbN win64 lgpl-shared build');
		const work = join(cache, 'source-build', key);
		const prefix = join(work, 'prefix');
		const script = join(ROOT, 'scripts', 'ffmpeg', 'build-lgpl-from-source.sh');
		log(`building FFmpeg ${manifest.ffmpeg.version} from source in ${work} (takes a while)`);
		const r = spawnSync('bash', [script, work, prefix], { stdio: 'inherit' });
		if (r.status !== 0) fail('source build failed');
		return {
			prefix,
			origin: {
				kind: 'source',
				url: manifest.source.packages.ffmpeg.url,
				sha256: manifest.source.packages.ffmpeg.sha256,
			},
		};
	}
	const file = join(cache, basename(new URL(prebuilt.url).pathname));
	await download(prebuilt.url, file, prebuilt.sha256);
	const into = join(cache, 'extract', key);
	extract(file, into);
	return {
		prefix: join(into, prebuilt.root),
		origin: { kind: 'btbn', release: manifest.prebuilt.release, url: prebuilt.url, sha256: prebuilt.sha256 },
	};
}

function libMajor(lib) {
	const m = manifest.abi[lib];
	if (!m) fail(`no ABI major for ${lib}`);
	return m;
}

function assembleUnix(prefix, dest) {
	const darwin = key.startsWith('darwin');
	for (const lib of Object.keys(manifest.abi)) {
		const major = libMajor(lib);
		const file = darwin ? `${lib}.${major}.dylib` : `${lib}.so.${major}`;
		const src = join(prefix, 'lib', file);
		if (!existsSync(src)) fail(`${src} is missing (expected FFmpeg 7.1 ABI: ${lib} major ${major})`);
		copyFileSync(realpathSync(src), join(dest, file));
		chmodSync(join(dest, file), 0o755);
		// Remotion's compositor links the unversioned names (NEEDED libavcodec.so / libavcodec.dylib).
		symlinkSync(file, join(dest, darwin ? `${lib}.dylib` : `${lib}.so`));
	}
	for (const exe of ['ffmpeg', 'ffprobe']) {
		copyFileSync(join(prefix, 'bin', exe), join(dest, exe));
		chmodSync(join(dest, exe), 0o755);
		if (!darwin) {
			const old = rewriteElfRpath(join(dest, exe), '$ORIGIN');
			if (old === null) fail(`${exe} has no RPATH/RUNPATH; rebuild with -Wl,-rpath,'$ORIGIN'`);
			if (old !== '$ORIGIN') log(`${exe}: rpath "${old}" → "$ORIGIN"`);
		}
	}
}

function assembleWindows(prefix, dest) {
	const bin = join(prefix, 'bin');
	for (const n of readdirSync(bin)) {
		if (/\.dll$/i.test(n) || /^(ffmpeg|ffprobe)\.exe$/i.test(n)) copyFileSync(join(bin, n), join(dest, n));
	}
	for (const lib of Object.keys(manifest.abi)) {
		const dll = `${lib.replace(/^lib/, '')}-${libMajor(lib)}.dll`;
		if (!existsSync(join(dest, dll))) fail(`${dll} is missing from ${bin}`);
	}
}

/** SPDX id of an LGPL FFmpeg build: `--enable-version3` upgrades LGPL 2.1+ to LGPL 3+. */
function spdxOf(buildconf) {
	return /--enable-version3\b/.test(buildconf) ? 'LGPL-3.0-or-later' : 'LGPL-2.1-or-later';
}

function licenseFiles(prefix, dest, origin, spdx) {
	const candidates = ['LICENSE.txt', 'LICENSE', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3'];
	const found = candidates.map((n) => join(prefix, n)).find((p) => existsSync(p));
	const lic = found ?? join(prefix, 'share', 'doc', 'ffmpeg', 'COPYING.LGPLv2.1');
	if (!existsSync(lic)) fail(`no FFmpeg license file found in ${prefix} (expected LICENSE.txt)`);
	const text = readFileSync(lic, 'utf8');
	const v3 = spdx === 'LGPL-3.0-or-later';
	if (
		!/GNU LESSER GENERAL PUBLIC LICENSE/.test(text) ||
		!new RegExp(`Version ${v3 ? '3' : '2\\.1'},`).test(text)
	)
		fail(`${lic} is not the ${spdx} text this build needs`);
	copyFileSync(lic, join(dest, 'LICENSE-FFmpeg.txt'));
	// LGPL 3 is written as additional permissions on top of GPL 3 and must be accompanied by its text.
	if (v3)
		copyFileSync(
			join(ROOT, 'scripts', 'ffmpeg', 'licenses', 'COPYING.GPLv3'),
			join(dest, 'COPYING.GPLv3.txt'),
		);
	writeFileSync(
		join(dest, 'NOTICE-FFmpeg.txt'),
		[
			`This directory contains FFmpeg ${manifest.ffmpeg.version} (${manifest.ffmpeg.describe}) built as an LGPL`,
			`shared library build (${spdx}; no --enable-gpl, no --enable-nonfree). FFmpeg is free software licensed`,
			'under the GNU Lesser General Public License; see LICENSE-FFmpeg.txt. JasperEditor runs ffmpeg/ffprobe as',
			"separate processes and does not link FFmpeg into its own code. Remotion's compositor (below) loads the",
			'libav*/libsw* shared libraries in this directory dynamically; you can replace them with your own build of',
			'the same FFmpeg release series (same library major versions).',
			...(v3
				? [
						'',
						'The LGPL version 3 consists of additional permissions on top of the GNU General Public License',
						'version 3, so that text is included as COPYING.GPLv3.txt. This FFmpeg build is NOT GPL-licensed.',
					]
				: []),
			'',
			`FFmpeg source: ${manifest.ffmpeg.sourceUrl}`,
			`Release tarball: ${manifest.ffmpeg.sourceTarball}`,
			origin.kind === 'btbn'
				? `Build: ${manifest.prebuilt.buildScripts} release ${origin.release} (build scripts and every dependency's source)`
				: 'Build: scripts/ffmpeg/build-lgpl-from-source.sh (pinned sources in scripts/ffmpeg/manifest.json)',
			'',
			`remotion${key.startsWith('win32') ? '.exe' : ''} is Remotion's compositor from ${compositorPackage(key)}@${manifest.remotion.version}`,
			'(Remotion license, https://remotion.dev/license), copied unmodified.',
			'',
		].join('\n'),
	);
}

/** The vid.stab record a source build leaves in its prefix (null: built without vid.stab). */
function vidstabRecord(prefix) {
	const f = join(prefix, 'share', 'jasper', 'libvidstab.json');
	return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

function hostVerify(dest, vidstab) {
	const ff = join(dest, names.ffmpeg);
	const text = (args) => {
		const r = run(ff, ['-hide_banner', ...args]);
		if (r.status !== 0) fail(`${ff} ${args.join(' ')} failed: ${r.stderr.slice(-800)}`);
		return r.stdout + r.stderr;
	};
	const buildconf = text(['-buildconf']);
	const encoders = text(['-encoders']);
	const license = text(['-L']);
	const problems = evaluateBuild({ buildconf, encoders, license, vidstab: vidstab ?? undefined });
	if (problems.length) fail(`the FFmpeg build is not LGPL-clean: ${problems.join('; ')}`);
	const list = new Set([...encoders.matchAll(/^\s*[A-Z.]{6}\s+(\S+)/gm)].map((m) => m[1]));
	const missing = REQUIRED_ENCODERS.filter((e) => !list.has(e));
	if (missing.length) fail(`required encoders missing: ${missing.join(', ')}`);
	if (!AV1_ENCODERS.some((e) => list.has(e))) log('warning: no AV1 encoder (libsvtav1 / libaom-av1)');
	const probe = run(join(dest, names.ffprobe), ['-hide_banner', '-version']);
	if (probe.status !== 0) fail(`ffprobe does not run: ${probe.stderr}`);
	if (process.platform === 'linux') {
		// `-r` also resolves every symbol the compositor imports (LIBAVCODEC_61 …): an ABI mismatch or a
		// build without a function it needs shows up as "undefined symbol" / "version … not found".
		const ldd = run('ldd', ['-r', join(dest, names.compositor)]);
		const lddOut = `${ldd.stdout}${ldd.stderr}`;
		if (/not found|undefined symbol|symbol lookup error/.test(lddOut))
			fail(`the compositor is not ABI-compatible with this FFmpeg build:\n${lddOut}`);
		const resolved = [...ldd.stdout.matchAll(/(lib(?:av|sw)\S+) => (\S+)/g)];
		for (const [, lib, path] of resolved) {
			if (dirname(path) !== dest && dirname(realpathSync(path)) !== realpathSync(dest))
				fail(`the compositor resolves ${lib} outside the binaries directory: ${path}`);
		}
	}
	return {
		buildconf: (/configuration:\s*\n([\s\S]*)/.exec(buildconf)?.[1] ?? buildconf).trim(),
		version: /ffmpeg version (\S+)/.exec(run(ff, ['-hide_banner', '-version']).stdout)?.[1] ?? null,
		encoders: [...list].filter((e) => [...REQUIRED_ENCODERS, ...AV1_ENCODERS].includes(e)).sort(),
	};
}

/** Cross-platform verification: the configure line and license string embedded in the binaries. */
function staticVerify(dest, vidstab) {
	const problems = [];
	let buildconf = '';
	for (const n of readdirSync(dest)) {
		if (!/^(ffmpeg|ffprobe)(\.exe)?$|^(lib)?avcodec[-.]/i.test(n)) continue;
		const s = scanBinaryStrings(readFileSync(join(dest, n)));
		buildconf ||= s.buildconf;
		for (const p of evaluateBuild({ ...s, vidstab: vidstab ?? undefined })) problems.push(`${n}: ${p}`);
	}
	if (!buildconf) fail('could not find an embedded FFmpeg configuration string');
	if (problems.length) fail(`the FFmpeg build is not LGPL-clean: ${problems.join('; ')}`);
	return { buildconf: buildconf.trim(), version: manifest.ffmpeg.describe, encoders: null };
}

/** Bump when the assembly itself changes (layout, notices, checks): existing directories are rebuilt. */
const ASSEMBLY_VERSION = 3;

/** Hash of every input that determines the assembled directory (re-assemble when it changes). */
function fingerprint() {
	const inputs = JSON.stringify({
		assembly: ASSEMBLY_VERSION,
		ffmpeg: manifest.ffmpeg,
		abi: manifest.abi,
		prebuilt: manifest.prebuilt.platforms[key] ?? null,
		source: flag('from-source') || !manifest.prebuilt.platforms[key] ? manifest.source : null,
		vidstab: flag('from-source') || !manifest.prebuilt.platforms[key] ? manifest.vidstab : null,
		prefix: opt('ffmpeg-prefix') ?? null,
		remotion: { version: manifest.remotion.version, sha256: manifest.remotion.compositorSha256[key] ?? null },
	});
	return createHash('sha256').update(inputs).digest('hex');
}

async function main() {
	const infoFile = join(out, 'BUILDINFO.json');
	if (!flag('force') && existsSync(infoFile)) {
		try {
			const info = JSON.parse(readFileSync(infoFile, 'utf8'));
			if (info.fingerprint === fingerprint()) {
				log(`up to date: ${out}`);
				return;
			}
		} catch {
			// re-assemble
		}
	}
	const { prefix, origin } = await ffmpegPrefix();
	const compDir = compositorDir();
	const compositor = join(compDir, names.compositor);
	const compSha = await sha256File(compositor);
	const pinned = manifest.remotion.compositorSha256[key];
	if (pinned && pinned !== compSha)
		fail(
			`${compositor} sha256 ${compSha} does not match the pinned ${pinned} (Remotion upgrade? update manifest.json)`,
		);

	const tmp = `${out}.partial`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	if (key.startsWith('win32')) assembleWindows(prefix, tmp);
	else assembleUnix(prefix, tmp);
	copyFileSync(compositor, join(tmp, names.compositor));
	if (!key.startsWith('win32')) chmodSync(join(tmp, names.compositor), 0o755);
	const vidstab = vidstabRecord(prefix);
	const verified = key === host ? hostVerify(tmp, vidstab) : staticVerify(tmp, vidstab);
	const spdx = spdxOf(verified.buildconf);
	licenseFiles(prefix, tmp, origin, spdx);
	if (vidstab) {
		const lic = join(prefix, 'LICENSE-libvidstab.txt');
		if (!existsSync(lic)) fail(`${lic} is missing (the source build copies vid.stab's COPYING.LESSER)`);
		copyFileSync(lic, join(tmp, 'LICENSE-libvidstab.txt'));
		writeFileSync(
			join(tmp, 'NOTICE-FFmpeg.txt'),
			`${readFileSync(join(tmp, 'NOTICE-FFmpeg.txt'), 'utf8')}
The FFmpeg libraries include vid.stab ${vidstab.version} (${vidstab.repository}, commit ${vidstab.commit}), licensed
under the GNU Lesser General Public License version 2.1 or later since its 2026 relicensing
(${vidstab.relicenseRecord}); see LICENSE-libvidstab.txt. It is statically linked into libavfilter; the
corresponding source is the pinned archive ${vidstab.archive}.
`,
		);
	}
	const files = {};
	for (const n of readdirSync(tmp).sort()) {
		const p = join(tmp, n);
		if (statSync(p).isFile() && !n.endsWith('.json')) files[n] = await sha256File(p);
	}
	writeFileSync(
		join(tmp, 'BUILDINFO.json'),
		`${JSON.stringify(
			{
				platform: key,
				fingerprint: fingerprint(),
				createdAt: new Date().toISOString(),
				ffmpeg: {
					version: verified.version,
					describe: manifest.ffmpeg.describe,
					license: spdx,
					sourceUrl: manifest.ffmpeg.sourceUrl,
					origin,
					buildconf: verified.buildconf,
					encoders: verified.encoders,
				},
				remotion: {
					package: compositorPackage(key),
					version: manifest.remotion.version,
					compositorSha256: compSha,
				},
				...(vidstab ? { libvidstab: vidstab } : {}),
				verifiedOnHost: key === host,
				files,
			},
			null,
			2,
		)}\n`,
	);
	rmSync(out, { recursive: true, force: true });
	renameSync(tmp, out);
	log(`ready: ${out}${key === host ? '' : ' (assembled for another platform: statically checked only)'}`);
}

await main();
