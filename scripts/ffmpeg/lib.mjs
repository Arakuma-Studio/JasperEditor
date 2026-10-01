// Shared helpers for the LGPL FFmpeg tooling (ARCHITECTURE D-13, docs/wp-notes/wp-lgpl.md):
// the pinned manifest, platform keys, license evaluation of `ffmpeg -buildconf` / `-encoders` / `-L`
// output (and of the configuration string embedded in binaries we cannot run), and an in-place ELF
// RPATH rewrite so the Linux ffmpeg/ffprobe find their libav* next to them without LD_LIBRARY_PATH.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VENDOR_DIR = join(ROOT, 'vendor', 'ffmpeg-lgpl');

/** Pinned inputs (read once; the JSON is the single source of truth for URLs and checksums). */
export function loadManifest() {
	return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'manifest.json'), 'utf8'));
}

/**
 * `<platform>-<arch>` like Node's `process.platform`/`process.arch` (`linux-x64`, `darwin-arm64`,
 * `win32-x64`). musl Linux gets a `-musl` suffix (Remotion ships a separate compositor for it).
 */
export function platformKey(platform = process.platform, arch = process.arch, musl = isMusl()) {
	return `${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`;
}

export function isMusl() {
	if (process.platform !== 'linux') return false;
	const report = process.report?.getReport?.();
	return !!report && typeof report === 'object' && !report.header?.glibcVersionRuntime;
}

/** Remotion's compositor package for a platform key (see @remotion/renderer get-executable-path.js). */
export function compositorPackage(key) {
	const map = {
		'linux-x64': '@remotion/compositor-linux-x64-gnu',
		'linux-x64-musl': '@remotion/compositor-linux-x64-musl',
		'linux-arm64': '@remotion/compositor-linux-arm64-gnu',
		'linux-arm64-musl': '@remotion/compositor-linux-arm64-musl',
		'darwin-x64': '@remotion/compositor-darwin-x64',
		'darwin-arm64': '@remotion/compositor-darwin-arm64',
		'win32-x64': '@remotion/compositor-win32-x64-msvc',
	};
	return map[key] ?? null;
}

/** File names inside a Remotion binaries directory (`binariesDirectory`) for a platform key. */
export function binaryNames(key) {
	const win = key.startsWith('win32');
	return {
		compositor: win ? 'remotion.exe' : 'remotion',
		ffmpeg: win ? 'ffmpeg.exe' : 'ffmpeg',
		ffprobe: win ? 'ffprobe.exe' : 'ffprobe',
	};
}

export async function sha256File(file) {
	const h = createHash('sha256');
	await new Promise((resolve, reject) => {
		createReadStream(file)
			.on('data', (c) => h.update(c))
			.on('end', resolve)
			.on('error', reject);
	});
	return h.digest('hex');
}

// ------------------------------------------------------------------------------------------ licensing

/**
 * configure switches that make a build GPL or nonfree (FFmpeg 7.1 configure: EXTERNAL_LIBRARY_GPL_LIST,
 * EXTERNAL_LIBRARY_NONFREE_LIST, HWACCEL_LIBRARY_NONFREE_LIST, plus `--enable-gpl` / `--enable-nonfree`
 * themselves and GPL-only components). `--disable-libx264` is fine; only `--enable-*` counts.
 */
export const FORBIDDEN_FLAGS = [
	'--enable-gpl',
	'--enable-nonfree',
	'--enable-libx264',
	'--enable-libx265',
	'--enable-libfdk-aac',
	'--enable-libxvid',
	'--enable-libxavs',
	'--enable-libxavs2',
	'--enable-libdavs2',
	'--enable-librubberband',
	'--enable-frei0r',
	'--enable-avisynth',
	'--enable-libcdio',
	'--enable-libdvdnav',
	'--enable-libdvdread',
	'--enable-libsmbclient',
	'--enable-postproc',
	'--enable-decklink',
	'--enable-libtls',
	'--enable-libnpp',
	'--enable-cuda-nvcc',
	'--enable-cuda-sdk',
];

/** Encoders that only exist in GPL/nonfree builds. */
export const FORBIDDEN_ENCODERS = [
	'libx264',
	'libx264rgb',
	'libx265',
	'libfdk_aac',
	'libxvid',
	'libxavs',
	'libxavs2',
];

/** Configure switches in a `-buildconf` / `-version` text (or an embedded configuration string). */
export function configureFlags(text) {
	return [...text.matchAll(/(?:^|[\s'"])(--(?:enable|disable)-[a-z0-9_-]+)/gi)].map((m) =>
		m[1].toLowerCase(),
	);
}

/**
 * vid.stab (S07:PST-003, ARCHITECTURE D-13 M2 note): `--enable-libvidstab` is only acceptable for a build of
 * the pinned post-relicense (LGPL-2.1-or-later) vid.stab commit, which the build records in BUILDINFO.json
 * (`libvidstab: {commit, license}`). Any other vid.stab — every release up to v1.1.2 is GPL — fails.
 * Returns null when the record is acceptable, else the reason.
 */
export function vidstabRecordProblem(record, manifest = loadManifest()) {
	const pin = manifest.vidstab;
	if (!record || typeof record !== 'object')
		return 'configured with --enable-libvidstab but BUILDINFO.json records no libvidstab build (only the pinned relicensed vid.stab is allowed)';
	if (record.commit !== pin.commit)
		return `configured with --enable-libvidstab from vid.stab ${String(record.commit ?? '?').slice(0, 12)}, not the pinned post-relicense commit ${pin.commit.slice(0, 12)}`;
	if (record.license !== 'LGPL-2.1-or-later')
		return `libvidstab licence recorded as ${record.license}, expected LGPL-2.1-or-later`;
	return null;
}

/**
 * Evaluates the build of one ffmpeg binary or library. Inputs are the texts we could obtain: `buildconf`
 * (`-hide_banner -buildconf` or an embedded configuration string), `encoders` (`-hide_banner -encoders`)
 * and `license` (`-L` or the embedded `avcodec_license()` string), plus the `libvidstab` record of the
 * build's BUILDINFO.json (`vidstab`, see vidstabRecordProblem). Returns the violations (empty = OK).
 */
export function evaluateBuild({ buildconf = '', encoders = '', license = '', vidstab = undefined }) {
	const problems = [];
	const flags = new Set(configureFlags(buildconf));
	for (const f of FORBIDDEN_FLAGS) if (flags.has(f)) problems.push(`configured with ${f}`);
	if (flags.has('--enable-libvidstab')) {
		const p = vidstabRecordProblem(vidstab);
		if (p) problems.push(p);
	}
	for (const line of encoders.split('\n')) {
		const m = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
		if (m && FORBIDDEN_ENCODERS.includes(m[1])) problems.push(`has the ${m[1]} encoder`);
	}
	const lic = license.replace(/\s+/g, ' ');
	if (/nonfree and unredistributable/i.test(lic)) problems.push('license: nonfree and unredistributable');
	// `ffmpeg -L`: "GNU Lesser General Public License" (LGPL) vs "GNU General Public License" (GPL);
	// embedded avcodec_license(): "LGPL version 3 or later" vs "GPL version 2 or later".
	if (/GNU General Public License/.test(lic) || /(^|[^L])GPL version \d/.test(lic))
		problems.push('license: GPL');
	return [...new Set(problems)];
}

/**
 * Pulls the licensing-relevant strings out of a binary we cannot execute (another OS, or a shared
 * library): the embedded configure line(s) and the `avcodec_license()`-style string.
 */
export function scanBinaryStrings(buf) {
	const text = buf.toString('latin1');
	const configs = [];
	for (const m of text.matchAll(/--(?:prefix|arch|enable|disable|extra|cross|target|cc|pkg)[^\0\n]{20,}/g)) {
		if (/--(enable|disable)-/.test(m[0])) configs.push(m[0]);
	}
	const lic = [];
	for (const m of text.matchAll(/(?:L?GPL version [0-9] or later|nonfree and unredistributable)/g))
		lic.push(m[0]);
	return { buildconf: configs.join('\n'), license: [...new Set(lic)].join('\n') };
}

/** Names of files that are part of an FFmpeg distribution and must be checked. */
export function isFfmpegArtifact(name) {
	return (
		/^(ffmpeg|ffprobe|ffplay)(\.exe)?$/i.test(name) ||
		/^lib(avcodec|avformat|avutil|avfilter|avdevice|swscale|swresample|postproc)(\.so(\.\d+)*|(\.\d+)*\.dylib)$/i.test(
			name,
		) ||
		/^(avcodec|avformat|avutil|avfilter|avdevice|swscale|swresample|postproc)-\d+\.dll$/i.test(name)
	);
}

/**
 * The FFmpeg that Electron/Chromium ships for media playback (`libffmpeg.so`, `ffmpeg.dll`,
 * `libffmpeg.dylib`): an LGPL build by the Chromium project. It is checked through its embedded license
 * strings like any other library, but it lives next to the Electron executable.
 */
export function isChromiumFfmpeg(name) {
	return /^(libffmpeg\.(so|dylib)|ffmpeg\.dll)$/i.test(name);
}

/**
 * Stand-alone GPL/nonfree codec libraries that must never ship next to (or instead of) an LGPL FFmpeg:
 * libx264.so.164, libx265.dll, libfdk-aac.2.dylib, xvidcore.dll …
 */
export function isForbiddenLibrary(name) {
	return /^(lib)?(x264|x265|fdk-aac|xvidcore)([-.]\d+)*\.(so(\.\d+)*|dll|dylib)$/i.test(name);
}

// ------------------------------------------------------------------------------------------ ELF rpath

/**
 * Rewrites the DT_RPATH/DT_RUNPATH string of an ELF64 little-endian file in place (the new value must
 * not be longer than the old one; the rest is NUL-padded). Returns the previous value, or null when the
 * file has no RPATH/RUNPATH entry. Dependency-free alternative to `patchelf --set-rpath` for the one
 * case we need (BtbN's shared builds carry a mangled `-Wl:../lib` rpath).
 */
export function rewriteElfRpath(file, value) {
	const b = readFileSync(file);
	if (b.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file}: not an ELF file`);
	if (b[4] !== 2 || b[5] !== 1) throw new Error(`${file}: only ELF64 little-endian is supported`);
	const phoff = Number(b.readBigUInt64LE(0x20));
	const phentsize = b.readUInt16LE(0x36);
	const phnum = b.readUInt16LE(0x38);
	const loads = [];
	let dyn = null;
	for (let i = 0; i < phnum; i++) {
		const o = phoff + i * phentsize;
		const type = b.readUInt32LE(o);
		const offset = Number(b.readBigUInt64LE(o + 8));
		const vaddr = Number(b.readBigUInt64LE(o + 16));
		const filesz = Number(b.readBigUInt64LE(o + 32));
		if (type === 1) loads.push({ offset, vaddr, filesz });
		if (type === 2) dyn = { offset, filesz };
	}
	if (!dyn) throw new Error(`${file}: no PT_DYNAMIC segment`);
	let strtab = null;
	let rpathOff = null;
	for (let o = dyn.offset; o < dyn.offset + dyn.filesz; o += 16) {
		const tag = Number(b.readBigInt64LE(o));
		const val = Number(b.readBigUInt64LE(o + 8));
		if (tag === 0) break;
		if (tag === 5) strtab = val; // DT_STRTAB
		if (tag === 15 || tag === 29) rpathOff = val; // DT_RPATH / DT_RUNPATH
	}
	if (rpathOff === null) return null;
	if (strtab === null) throw new Error(`${file}: no DT_STRTAB`);
	const seg = loads.find((l) => strtab >= l.vaddr && strtab < l.vaddr + l.filesz);
	if (!seg) throw new Error(`${file}: DT_STRTAB is not in a PT_LOAD segment`);
	const start = seg.offset + (strtab - seg.vaddr) + rpathOff;
	let end = start;
	while (b[end] !== 0) end++;
	const old = b.toString('utf8', start, end);
	const next = Buffer.from(value, 'utf8');
	if (next.length > end - start)
		throw new Error(`${file}: new rpath "${value}" is longer than the old one "${old}" (use patchelf)`);
	b.fill(0, start, end);
	next.copy(b, start);
	writeFileSync(file, b);
	return old;
}
