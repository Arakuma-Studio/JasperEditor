// Test media must be made with encoders an LGPL-only FFmpeg has (AGENTS.md §2: `JASPER_FFMPEG_LGPL_ONLY=1` must
// behave like the shipped app). The vendored build in vendor/ffmpeg-lgpl, which the engine tests prefer, has no x264,
// x265, Xvid or fdk-aac: a test, spec or fixture script that hard-codes one of them cannot run in an LGPL-only
// environment — it fails in its setup ("Unknown encoder 'libx264'") before checking anything. Fixtures use FFmpeg's
// own LGPL encoders (mpeg4, ffv1, prores, mjpeg, png), libvpx (VP8 / VP9, BSD) for media a browser must play, or
// `fixtureH264Args` (OpenH264 in LGPL-only mode) when the test needs H.264 itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const GPL_ENCODER =
	/['"`](?:-c:v|-vcodec|-codec:v|-c:a|-acodec|-codec:a)['"`]\s*,\s*['"`](libx264|libx264rgb|libx265|libxvid|libfdk_aac)['"`]/g;
/** GPL-only filters (AGENTS.md §2.2) at the start of a filter in filter text. */
const GPL_FILTER =
	/(?:^|["'`,;\]])\s*(eq|hqdn3d|perspective|boxblur|smartblur|delogo|frei0r|spp|pp7|uspp|fspp|mpdecimate|pullup)=/gm;
/** The one place a GPL encoder may be named as an argument: the selector that refuses it in LGPL-only mode. */
const ALLOWED = new Set(['scripts/fixture-encoding.mjs']);
/** Tests of the engine's own LGPL filter guard (they feed it GPL filter text on purpose). */
const FILTER_GUARD_TESTS = new Set(['apps/engine/test/processing-steps.test.ts']);

/** Files that make test media: tests, specs, test helpers, benches and the fixture scripts. */
function fixtureSources() {
	const out = [];
	const walk = (dir, all) => {
		for (const name of readdirSync(dir)) {
			if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p, all || /^(test|tests|e2e|bench|scripts|fixtures)$/.test(name));
			else if (all && /\.(m?[jt]sx?)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
		}
	};
	walk(join(root, 'e2e'), true);
	walk(join(root, 'scripts'), true);
	for (const group of ['apps', 'packages'])
		for (const pkg of readdirSync(join(root, group))) {
			const dir = join(root, group, pkg);
			if (statSync(dir).isDirectory()) walk(dir, false);
		}
	return out;
}

describe('test fixtures use LGPL encoders', () => {
	it('no test, spec or fixture script hard-codes a GPL encoder or a GPL-only filter', () => {
		const found = [];
		for (const file of fixtureSources()) {
			const rel = relative(root, file).split('\\').join('/');
			if (ALLOWED.has(rel) || rel === 'scripts/fixture-gpl-encoders.test.mjs') continue;
			const text = readFileSync(file, 'utf8');
			for (const m of text.matchAll(GPL_ENCODER)) {
				const line = text.slice(0, m.index).split('\n').length;
				found.push(`${rel}:${line} ${m[1]}`);
			}
			if (!FILTER_GUARD_TESTS.has(rel))
				for (const m of text.matchAll(GPL_FILTER)) {
					const line = text.slice(0, m.index).split('\n').length;
					found.push(`${rel}:${line} filter ${m[1]}`);
				}
		}
		expect(found).toEqual([]);
	});

	it('the scan sees the places fixtures are made', () => {
		const files = fixtureSources().map((f) => relative(root, f).split('\\').join('/'));
		for (const f of [
			'apps/engine/test/sound-design-motion.test.ts',
			'apps/mcp/test/sound-motion.test.ts',
			'e2e/source-range.spec.ts',
			'packages/compositions/test/fx-media.ts',
			'scripts/make-fixtures.mjs',
		])
			expect(files).toContain(f);
		expect("['-c:v', 'libx264']".match(GPL_ENCODER)).not.toBeNull();
		expect("['-c:v',\n\t\t'libx265'".match(GPL_ENCODER)).not.toBeNull();
		expect("['-c:v', 'mpeg4', '-q:v', '2']".match(GPL_ENCODER)).toBeNull();
		expect(`"eq=brightness='0.1':eval=frame"`.match(GPL_FILTER)).not.toBeNull();
		expect("'scale=2:2,hqdn3d=1'".match(GPL_FILTER)).not.toBeNull();
		expect(`"geq=lum='lum(X,Y)'"`.match(GPL_FILTER)).toBeNull();
		expect('const seq = 1; frame=2'.match(GPL_FILTER)).toBeNull();
	});
});
