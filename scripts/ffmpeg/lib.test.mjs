// Unit tests for the LGPL FFmpeg tooling: license evaluation, embedded-string scanning, the tree guard
// used by `pnpm ffmpeg:check` and the ELF RPATH rewrite.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPackagedApp, checkTree } from './check-lgpl.mjs';
import {
	configureFlags,
	evaluateBuild,
	isFfmpegArtifact,
	isForbiddenLibrary,
	loadManifest,
	platformKey,
	rewriteElfRpath,
	scanBinaryStrings,
	VENDOR_DIR,
} from './lib.mjs';

const LGPL_CONF =
	"--prefix=/ffbuild/prefix --enable-version3 --enable-shared --disable-libfdk-aac --enable-libopenh264 --disable-libx264 --disable-libx265 --enable-libvpx --extra-libs='-lgomp -ldl'";
const REMOTION_CONF =
	'--prefix=remotion --enable-shared --enable-libfdk-aac --enable-gpl --disable-encoders --enable-encoder=libx264 --enable-libx264 --enable-libx265';
const ENCODERS_LGPL = ' V....D libopenh264          OpenH264 H.264\n A....D aac                  AAC\n';
const ENCODERS_GPL = `${ENCODERS_LGPL} V....D libx264              libx264 H.264\n A....D libfdk_aac           Fraunhofer FDK AAC\n`;

describe('evaluateBuild', () => {
	it('accepts an LGPL build even though it lists --disable-libx264', () => {
		expect(configureFlags(LGPL_CONF)).toContain('--disable-libx264');
		expect(
			evaluateBuild({
				buildconf: LGPL_CONF,
				encoders: ENCODERS_LGPL,
				license: 'under the terms of the GNU Lesser General Public License as published',
			}),
		).toEqual([]);
	});

	it("rejects Remotion's bundled build", () => {
		const problems = evaluateBuild({
			buildconf: REMOTION_CONF,
			encoders: ENCODERS_GPL,
			license: 'under the terms of the GNU General Public License as published',
		});
		expect(problems).toEqual(
			expect.arrayContaining([
				'configured with --enable-gpl',
				'configured with --enable-libx264',
				'configured with --enable-libx265',
				'configured with --enable-libfdk-aac',
				'has the libx264 encoder',
				'has the libfdk_aac encoder',
				'license: GPL',
			]),
		);
	});

	it('rejects nonfree builds and GPL license strings', () => {
		expect(evaluateBuild({ buildconf: '--enable-nonfree' })).toContain('configured with --enable-nonfree');
		expect(evaluateBuild({ license: 'nonfree and unredistributable' })).toContain(
			'license: nonfree and unredistributable',
		);
		expect(evaluateBuild({ license: 'GPL version 2 or later' })).toContain('license: GPL');
		expect(evaluateBuild({ license: 'LGPL version 3 or later' })).toEqual([]);
	});
});

describe('scanBinaryStrings', () => {
	it('finds the embedded configuration and license string', () => {
		const buf = Buffer.concat([
			Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]),
			Buffer.from(`\0${REMOTION_CONF}\0junk\0GPL version 2 or later\0`, 'latin1'),
		]);
		const s = scanBinaryStrings(buf);
		expect(s.buildconf).toContain('--enable-gpl');
		expect(s.license).toBe('GPL version 2 or later');
		expect(evaluateBuild(s)).toContain('license: GPL');
	});
});

describe('isFfmpegArtifact', () => {
	it.each([
		['ffmpeg', true],
		['ffprobe.exe', true],
		['libavcodec.so', true],
		['libavcodec.so.61', true],
		['libavcodec.61.dylib', true],
		['libswscale.dylib', true],
		['avcodec-61.dll', true],
		['swresample-5.dll', true],
		['remotion', false],
		['libvpx-1.dll', false],
		['ffmpeg.txt', false],
	])('%s → %s', (name, expected) => expect(isFfmpegArtifact(name)).toBe(expected));
});

describe('checkTree', () => {
	it('fails on GPL libraries and Remotion compositor packages, passes LGPL ones', () => {
		const root = mkdtempSync(join(tmpdir(), 'lgpl-check-'));
		const ok = join(root, 'ok');
		const bad = join(root, 'bad', 'node_modules', '@remotion', 'compositor-linux-x64-gnu');
		mkdirSync(ok, { recursive: true });
		mkdirSync(bad, { recursive: true });
		writeFileSync(join(ok, 'libavcodec.so.61'), `\0${LGPL_CONF}\0LGPL version 3 or later\0`);
		writeFileSync(join(bad, 'libavcodec.so'), `\0${REMOTION_CONF}\0GPL version 2 or later\0`);
		const okResults = checkTree(ok);
		expect(okResults).toHaveLength(1);
		expect(okResults[0].problems).toEqual([]);
		const badResults = checkTree(join(root, 'bad'));
		expect(badResults.map((r) => r.problems.length > 0)).toEqual([true, true]);
		expect(badResults.some((r) => r.method === 'path')).toBe(true);
	});
});

describe('checkPackagedApp', () => {
	const app = (opts = {}) => {
		const root = mkdtempSync(join(tmpdir(), 'packaged-'));
		const res = join(root, 'resources');
		const lgpl = join(res, 'ffmpeg-lgpl');
		mkdirSync(lgpl, { recursive: true });
		if (!opts.noLgplDir) {
			for (const n of ['ffmpeg', 'ffprobe'])
				writeFileSync(join(lgpl, n), `\0${LGPL_CONF}\0LGPL version 3 or later\0`);
			writeFileSync(join(lgpl, 'libavcodec.so.61'), `\0${LGPL_CONF}\0LGPL version 3 or later\0`);
			for (const n of ['remotion', 'LICENSE-FFmpeg.txt', 'BUILDINFO.json']) writeFileSync(join(lgpl, n), 'x');
			if (!opts.noNotice) writeFileSync(join(lgpl, 'NOTICE-FFmpeg.txt'), 'x');
		}
		writeFileSync(join(res, 'app.asar'), opts.asar ?? 'plain js');
		return { root, res };
	};
	const bad = (r) => [...r.problems, ...r.results.flatMap((x) => x.problems)];

	it('passes an app that ships only the complete LGPL directory', () => {
		const r = checkPackagedApp(app().root);
		expect(bad(r)).toEqual([]);
		expect(r.results).toHaveLength(3);
	});

	it('fails without the LGPL directory, or when it lacks the notice', () => {
		expect(checkPackagedApp(app({ noLgplDir: true }).root).problems.join(' ')).toMatch(/incomplete/);
		const empty = mkdtempSync(join(tmpdir(), 'packaged-'));
		expect(checkPackagedApp(empty).problems.join(' ')).toMatch(/no ffmpeg-lgpl directory/);
		expect(checkPackagedApp(app({ noNotice: true }).root).problems.join(' ')).toMatch(/NOTICE-FFmpeg/);
	});

	it("fails when Remotion's compositor package, an x264 library or a GPL FFmpeg in the asar ships", () => {
		const a = app();
		const pkg = join(a.res, 'engine', 'node_modules', '@remotion', 'compositor-linux-x64-gnu');
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, 'ffmpeg'), `\0${REMOTION_CONF}\0GPL version 2 or later\0`);
		const r = checkPackagedApp(a.root);
		expect(bad(r).join(' | ')).toMatch(/--enable-gpl/);
		expect(bad(r).join(' | ')).toMatch(/Remotion compositor package/);
		expect(r.problems.join(' | ')).toMatch(/an FFmpeg binary outside ffmpeg-lgpl/);

		const b = app();
		writeFileSync(join(b.res, 'ffmpeg-lgpl', 'libx264.so.164'), 'x');
		expect(bad(checkPackagedApp(b.root)).join(' ')).toMatch(/GPL\/nonfree codec library/);

		const c = app({ asar: `js\0${REMOTION_CONF}\0GPL version 2 or later\0` });
		expect(bad(checkPackagedApp(c.root)).join(' ')).toMatch(/--enable-gpl/);
	});

	it("checks Electron's own FFmpeg library by its license string, wherever Electron puts it", () => {
		const a = app();
		writeFileSync(join(a.root, 'libffmpeg.so'), '\0libavcodec license: LGPL version 2.1 or later\0');
		expect(bad(checkPackagedApp(a.root))).toEqual([]);
		const b = app();
		writeFileSync(join(b.root, 'ffmpeg.dll'), '\0libavcodec license: GPL version 2 or later\0');
		expect(bad(checkPackagedApp(b.root)).join(' ')).toMatch(/license: GPL/);
	});

	it('even an LGPL FFmpeg must not sit in a stray location', () => {
		const a = app();
		mkdirSync(join(a.res, 'engine'), { recursive: true });
		writeFileSync(join(a.res, 'engine', 'ffmpeg'), `\0${LGPL_CONF}\0LGPL version 3 or later\0`);
		expect(checkPackagedApp(a.root).problems.join(' ')).toMatch(/outside ffmpeg-lgpl/);
	});
});

describe('isForbiddenLibrary', () => {
	it.each([
		['libx264.so.164', true],
		['libx264-164.dll', true],
		['libx265.so', true],
		['x265.dll', true],
		['libfdk-aac.2.dylib', true],
		['xvidcore.dll', true],
		['libvpx-1.dll', false],
		['libopenh264.so.7', false],
		['x264-notes.txt', false],
	])('%s → %s', (name, expected) => expect(isForbiddenLibrary(name)).toBe(expected));
});

describe('manifest', () => {
	it('pins every prebuilt download and source tarball with a sha256', () => {
		const m = loadManifest();
		for (const p of Object.values(m.prebuilt.platforms)) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
		for (const p of Object.values(m.source.packages)) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
		for (const s of Object.values(m.remotion.compositorSha256)) expect(s).toMatch(/^[0-9a-f]{64}$/);
		// Remotion 4.0.499's compositor ABI (FFmpeg 7.1).
		expect(m.abi).toMatchObject({ libavcodec: 61, libavformat: 61, libavutil: 59, libavfilter: 10 });
	});
});

const vendorFfmpeg = join(VENDOR_DIR, platformKey(), 'ffmpeg');
describe.runIf(process.platform === 'linux' && existsSync(vendorFfmpeg))('rewriteElfRpath', () => {
	it('rewrites the RPATH of the vendored ffmpeg in place', () => {
		const copy = join(mkdtempSync(join(tmpdir(), 'rpath-')), 'ffmpeg');
		copyFileSync(vendorFfmpeg, copy);
		expect(rewriteElfRpath(copy, '$ORIGIN')).toBe('$ORIGIN');
		expect(() => rewriteElfRpath(copy, '$ORIGIN/../lib')).toThrow(/longer/);
		expect(rewriteElfRpath(copy, 'lib')).toBe('$ORIGIN');
		// The string is NUL-terminated after "lib" now: its capacity shrank.
		expect(() => rewriteElfRpath(copy, '$ORIGIN')).toThrow(/longer/);
		expect(readFileSync(copy).length).toBe(readFileSync(vendorFfmpeg).length);
	});
});
