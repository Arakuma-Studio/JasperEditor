import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { checkPackagedApp, checkTree } from './check-lgpl.mjs';
import { loadManifest, platformKey, rewriteElfRpath, VENDOR_DIR } from './lib.mjs';

const tempDir = (prefix) => {
	const root = mkdtempSync(join(tmpdir(), prefix));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	return root;
};

const LGPL_CONF =
	"--prefix=/ffbuild/prefix --enable-version3 --enable-shared --disable-libfdk-aac --enable-libopenh264 --disable-libx264 --disable-libx265 --enable-libvpx --extra-libs='-lgomp -ldl'";
const REMOTION_CONF =
	'--prefix=remotion --enable-shared --enable-libfdk-aac --enable-gpl --disable-encoders --enable-encoder=libx264 --enable-libx264 --enable-libx265';

describe('checkTree', () => {
	it('fails on GPL libraries and Remotion compositor packages, passes LGPL ones', () => {
		const root = tempDir('lgpl-check-');
		const ok = join(root, 'ok');
		const bad = join(root, 'bad', 'node_modules', '@remotion', 'compositor-linux-x64-gnu');
		mkdirSync(ok, { recursive: true });
		mkdirSync(bad, { recursive: true });
		writeFileSync(join(ok, 'libavcodec.so.61'), `\0${LGPL_CONF}\0LGPL version 3 or later\0`);
		writeFileSync(join(ok, 'libavcodec.61.dylib'), `\0${LGPL_CONF}\0LGPL version 3 or later\0`);
		writeFileSync(join(ok, 'avcodec-61.dll'), `\0${LGPL_CONF}\0LGPL version 3 or later\0`);
		writeFileSync(join(bad, 'libavcodec.so'), `\0${REMOTION_CONF}\0GPL version 2 or later\0`);
		writeFileSync(
			join(bad, 'libavutil.so.59'),
			'\0--prefix=/ffbuild --enable-nonfree --enable-shared\0nonfree and unredistributable\0',
		);
		const okResults = checkTree(ok);
		for (const file of ['libavcodec.so.61', 'libavcodec.61.dylib', 'avcodec-61.dll'])
			expect(okResults.find((r) => r.file === join(ok, file))?.problems).toEqual([]);
		const badResults = checkTree(join(root, 'bad'));
		for (const [file, reason] of [
			[join(bad, 'libavcodec.so'), /--enable-gpl/],
			[join(bad, 'libavutil.so.59'), /--enable-nonfree/],
			[bad, /Remotion compositor package/],
		])
			expect(badResults.find((r) => r.file === file)?.problems.join(' ')).toMatch(reason);
	});
});

describe('vid.stab rule (S07:PST-003)', () => {
	const pin = loadManifest().vidstab;
	const VIDSTAB_CONF = `--prefix=/x --enable-shared --disable-static --enable-libopenh264 --enable-libvpx --enable-libvidstab`;
	const record = (commit) => ({ commit, date: pin.commitDate, license: 'LGPL-2.1-or-later' });

	it('pins a post-relicense vid.stab commit with its provenance', () => {
		expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
		expect(pin.license).toBe('LGPL-2.1-or-later');
		expect(pin.relicenseIssue).toMatch(/vid\.stab\/issues\/165$/);
		expect(pin.relicenseRecord).toContain(`${pin.commit}/RELICENSE.md`);
		expect(Date.parse(pin.commitDate)).toBeGreaterThanOrEqual(Date.parse(pin.relicenseDate));
		expect(loadManifest().source.packages.vidstab.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(loadManifest().source.packages.vidstab.url).toContain(pin.commit);
	});

	it('pnpm ffmpeg:check reads the record from BUILDINFO.json next to the binaries', () => {
		const root = tempDir('lgpl-vidstab-');
		for (const [name, commit] of [
			['pinned', pin.commit],
			['other', 'f'.repeat(40)],
		]) {
			const d = join(root, name);
			mkdirSync(d, { recursive: true });
			writeFileSync(join(d, 'libavfilter.so.10'), `\0${VIDSTAB_CONF}\0LGPL version 2.1 or later\0`);
			writeFileSync(join(d, 'BUILDINFO.json'), JSON.stringify({ libvidstab: record(commit) }));
		}
		mkdirSync(join(root, 'none'));
		writeFileSync(join(root, 'none', 'libavfilter.so.10'), `\0${VIDSTAB_CONF}\0LGPL version 2.1 or later\0`);
		expect(checkTree(join(root, 'pinned'))[0].problems).toEqual([]);
		expect(checkTree(join(root, 'other'))[0].problems.join()).toMatch(/not the pinned/);
		expect(checkTree(join(root, 'none'))[0].problems.join()).toMatch(/records no libvidstab/);
	});
});

describe('checkPackagedApp', () => {
	const app = (opts = {}) => {
		const root = tempDir('packaged-');
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
	});

	it('fails without the LGPL directory, or when it lacks the notice', () => {
		expect(checkPackagedApp(app({ noLgplDir: true }).root).problems.join(' ')).toMatch(/incomplete/);
		const empty = tempDir('packaged-');
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

describe('manifest', () => {
	it('pins every prebuilt download and source tarball with a sha256', () => {
		const m = loadManifest();
		for (const p of Object.values(m.prebuilt.platforms)) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
		for (const p of Object.values(m.source.packages)) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
		for (const s of Object.values(m.remotion.compositorSha256)) expect(s).toMatch(/^[0-9a-f]{64}$/);
	});
});

const vendorFfmpeg = join(VENDOR_DIR, platformKey(), 'ffmpeg');
describe.runIf(
	process.platform === 'linux' &&
		existsSync(vendorFfmpeg) &&
		spawnSync('readelf', ['--version'], { stdio: 'ignore' }).status === 0,
)('rewriteElfRpath (requires readelf and vendored FFmpeg)', () => {
	it('rewrites the RPATH of the vendored ffmpeg in place', () => {
		const copy = join(tempDir('rpath-'), 'ffmpeg');
		// Keep fixture ownership and permissions independent of the vendored executable.
		writeFileSync(copy, readFileSync(vendorFfmpeg), { mode: 0o600 });
		rewriteElfRpath(copy, 'lib');
		// An independent ELF reader must see the changed artifact, not just a return value.
		expect(execFileSync('readelf', ['-d', copy], { encoding: 'utf8' })).toMatch(
			/\((?:RUNPATH|RPATH)\).*\[lib\]/,
		);
		const patched = readFileSync(copy);
		expect(() => rewriteElfRpath(copy, '$ORIGIN/../lib')).toThrow();
		expect(readFileSync(copy).equals(patched)).toBe(true);
	});
});
