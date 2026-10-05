// S11:ANM-016: the scaffolded Remotion project must compile, and its bundled anime.js timeline must produce
// the same frames regardless of seek order.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { scaffoldProject } from '../src/mg-bundles/scaffold.ts';
import { TEMPLATE_FILES } from '../src/mg-bundles/template/files.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'jasper-anime-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Glyph = { y: number; opacity: number; rotate: number };
type TimelineModule = {
	buildTitleTimeline(count: number): { timeline: unknown; glyphs: Glyph[] };
	seekCanonical(timeline: unknown, ms: number): void;
};

describe('scaffold anime.js example (S11:ANM-016)', { timeout: 60_000 }, () => {
	it('the scaffolded project compiles (esbuild bundle of src/index.ts with the workspace packages)', async () => {
		const dir = await scaffoldProject(scratch, 'titles', {
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
		expect(r.outputFiles[0]?.contents.length).toBeGreaterThan(0);
	});

	it('the example timeline is order-independent (bundled with the pinned anime.js)', async () => {
		const out = join(scratch, 'title-timeline.mjs');
		await build({
			stdin: {
				contents: TEMPLATE_FILES['src/anime/title-timeline.ts']!,
				loader: 'ts',
				resolveDir: scratch,
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
		expect(fresh[0]).not.toEqual(fresh[49]);
		const one = m.buildTitleTimeline(9);
		const order = [...frames].reverse().concat([7, 30, 3, 44, 3, 12, 49, 0, 25]);
		for (const f of order) expect(at(one, f), `frame ${f}`).toEqual(fresh[f]);
		expect(at(m.buildTitleTimeline(0), 10)).toEqual([]);
	});
});
