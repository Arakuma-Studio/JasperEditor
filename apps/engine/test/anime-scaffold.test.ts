// S11:ANM-016: the scaffolded Remotion project (S08:MGC-015) carries an anime.js example that follows the
// determinism contract — paused timeline over plain objects, canonical seek, nothing wall-clock — and a README
// paragraph for bundle authors. The example's timeline module is bundled with esbuild and checked like the
// runtime: any visit order gives the values of a fresh build.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { findViolations } from '../../../scripts/check-anime.mjs';
import { ANIMEJS_PINNED_VERSION } from '../src/anime/index.ts';
import { scaffoldProject } from '../src/mg-bundles/scaffold.ts';
import { TEMPLATE_FILES } from '../src/mg-bundles/template/files.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type Glyph = { y: number; opacity: number; rotate: number };
type TimelineModule = {
	buildTitleTimeline(count: number): { timeline: unknown; glyphs: Glyph[] };
	seekCanonical(timeline: unknown, ms: number): void;
};

describe('scaffold anime.js example (S11:ANM-016)', { timeout: 60_000 }, () => {
	it('is scaffolded: AnimeTitle registered, schema + manifest entry, animejs pinned, README rule', async () => {
		const dir = await scaffoldProject(mkdtempSync(join(tmpdir(), 'jasper-anime-scaffold-')), 'titles', {
			install: false,
		});
		const read = (f: string) => readFileSync(join(dir, f), 'utf8');
		expect(JSON.parse(read('package.json')).dependencies.animejs).toBe(ANIMEJS_PINNED_VERSION);
		expect(read('src/Root.tsx')).toMatch(/id="AnimeTitle"[\s\S]*schema=\{animeTitleSchema\}/);
		expect(read('src/jasper-schemas.ts')).toMatch(/AnimeTitle: animeTitleSchema/);
		expect(JSON.parse(read('jasper.mg.json')).compositions.AnimeTitle.category).toBe('Titles');
		const readme = read('README.md');
		expect(readme).toMatch(/## Animating with anime\.js/);
		expect(readme).toMatch(/seek\(duration\)\\`, \\`seek\(0\)\\`|seek\(duration\)`, `seek\(0\)`/);
		expect(readme).toMatch(/Math\.random\(\)/);
	});

	it('follows the contract: lint-clean as runtime code, autoplay off, the canonical seek, no wall clock', () => {
		for (const f of ['src/anime/title-timeline.ts', 'src/AnimeTitle.tsx']) {
			const src = TEMPLATE_FILES[f]!;
			// held to the rules of our own runtime (which may create timelines and seek)
			expect(findViolations(`packages/motion/src/runtime/${f.split('/').pop()}`, src), f).toEqual([]);
		}
		const tl = TEMPLATE_FILES['src/anime/title-timeline.ts']!;
		expect(tl).toMatch(/createTimeline\(\{ autoplay: false \}\)/);
		expect(tl).toMatch(
			/timeline\.seek\(timeline\.duration, true\);\s*timeline\.seek\(0, true\);\s*timeline\.seek\(ms, true\);/,
		);
		expect(TEMPLATE_FILES['src/AnimeTitle.tsx']).toMatch(
			/seekCanonical\(built\.timeline, \(frame \* 1000\) \/ fps\)/,
		);
	});

	it('the scaffolded project compiles (esbuild bundle of src/index.ts with the workspace packages)', async () => {
		const dir = await scaffoldProject(mkdtempSync(join(tmpdir(), 'jasper-anime-bundle-')), 'titles', {
			install: false,
		});
		const r = await build({
			entryPoints: [join(dir, 'src', 'index.ts')],
			bundle: true,
			format: 'esm',
			platform: 'browser',
			jsx: 'automatic',
			write: false,
			outdir: join(dir, 'out'),
			nodePaths: ['compositions', 'motion', 'project'].map((p) => join(repo, 'packages', p, 'node_modules')),
			logLevel: 'silent',
		});
		expect(r.errors).toEqual([]);
		expect(r.outputFiles.some((f) => f.text.includes('AnimeTitle'))).toBe(true);
	});

	it('the example timeline is order-independent (bundled with the pinned anime.js)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-anime-example-'));
		const out = join(dir, 'title-timeline.mjs');
		await build({
			stdin: {
				contents: TEMPLATE_FILES['src/anime/title-timeline.ts']!,
				loader: 'ts',
				resolveDir: dir,
				sourcefile: 'title-timeline.ts',
			},
			bundle: true,
			format: 'esm',
			platform: 'node',
			outfile: out,
			nodePaths: [join(repo, 'packages', 'motion', 'node_modules')],
			logLevel: 'silent',
		});
		const m = (await import(pathToFileURL(out).href)) as TimelineModule;
		const frames = Array.from({ length: 50 }, (_, i) => i);
		const at = (built: ReturnType<TimelineModule['buildTitleTimeline']>, f: number) => {
			m.seekCanonical(built.timeline, (f * 1000) / 30);
			return built.glyphs.map((g) => ({ y: g.y, opacity: g.opacity, rotate: g.rotate }));
		};
		const fresh = frames.map((f) => at(m.buildTitleTimeline(9), f));
		const first = fresh[0]![0]!;
		expect([first.y, first.opacity, first.rotate].map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([
			60, 0, -12,
		]);
		expect(fresh[49]!.every((g) => g.y === 0 && g.opacity === 1 && g.rotate === 0)).toBe(true);
		const one = m.buildTitleTimeline(9);
		const order = [...frames].reverse().concat([7, 30, 3, 44, 3, 12, 49, 0, 25]);
		for (const f of order) expect(at(one, f), `frame ${f}`).toEqual(fresh[f]);
		expect(at(m.buildTitleTimeline(0), 10)).toEqual([]);
	});
});
