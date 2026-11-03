// @vitest-environment node
// Spec 19 TL-052 / TL-053 end to end (REMOTION_E2E=1): title templates expanded by the command, rendered by Remotion with
// the bundled display fonts. Frames land in `TL_E2E_OUT` to be looked at.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '@jasper/project';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { type FxMedia, startFxMedia } from './fx-media.ts';

const here = dirname(fileURLToPath(import.meta.url));
const enabled = process.env.REMOTION_E2E === '1';
const CHROME =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
const OUT = process.env.TL_E2E_OUT ?? join(here, '..', '..', '..', 'test-results', 'title-look-template-e2e');
const ENGINE = join(here, '..', '..', '..', 'apps', 'engine');
const DISPLAY = join(ENGINE, 'fonts', 'display');
const require_ = createRequire(join(ENGINE, 'package.json'));

/** Display fonts are large and the host is shared: the default 30 s is too short to load a Japanese face under load. */
const LOAD_TIMEOUT = 240_000;

const BACKDROP: [number, number, number, number] = [0.16, 0.24, 0.3, 1];

/** The font file of a face, copied where the test server serves it. */
function fontUrl(media: FxMedia, family: string, weight: number): string | null {
	const manifest = JSON.parse(readFileSync(join(DISPLAY, 'manifest.json'), 'utf8')) as {
		families: { id: string; family: string; files: { file: string; weights: number[] }[] }[];
	};
	const m = manifest.families.find((f) => f.family === family);
	let src: string;
	if (m) {
		const file = m.files.find((x) => x.weights.includes(weight)) ?? m.files[0]!;
		src = join(DISPLAY, m.id, 'files', file.file);
	} else {
		const id = family.toLowerCase().replace(/ /g, '-');
		try {
			src = join(
				dirname(require_.resolve(`@fontsource/${id}/metadata.json`)),
				'files',
				`${id}-latin-${weight}-normal.woff2`,
			);
		} catch {
			return null;
		}
	}
	if (!existsSync(src)) return null;
	const name = `${weight}-${basename(src)}`;
	copyFileSync(src, join(media.dir, name));
	return `${media.base}/${name}`;
}

/** A sequence with a plain backdrop and one template over it. */
function build(media: FxMedia, templateId: string, preset: string, extra: object = {}) {
	const ids = createCounterIdSource(1);
	const project = createEmptyProject({ ids, name: 'template', preset });
	const seqId = Object.keys(project.sequences)[0]!;
	const commands = [
		{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: BACKDROP },
		{ type: 'title.insertTemplate', templateId, at: 0, ...extra },
	] as unknown as Command[];
	const { document, result } = applyTransaction(
		project,
		{ label: 't', origin: 'user', sequenceId: seqId, commands },
		{ ids, now: () => '2026-11-02T10:00:00.000Z', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, seqId, {
		resolveMedia: () => null,
		resolveFont: (font, weight) => fontUrl(media, font.family, weight),
	});
}

const SHOTS = [
	{ template: 'template.lower-third-clean', preset: 'hd-720p-30', frame: 75 },
	{ template: 'template.lower-third-corporate', preset: 'hd-720p-30', frame: 75 },
	{ template: 'template.lower-third-broadcast', preset: 'hd-720p-30', frame: 75 },
	{ template: 'template.cinematic-title', preset: 'hd-720p-30', frame: 90 },
	{ template: 'template.sports-title', preset: 'hd-720p-30', frame: 60 },
	{ template: 'template.end-card-gradient', preset: 'hd-720p-30', frame: 75 },
	{ template: 'template.variety-telop', preset: 'hd-720p-30', frame: 45 },
	{ template: 'template.social-hook', preset: 'vertical-1080x1920-30', frame: 45 },
];

describe.runIf(enabled && !!CHROME)(
	'title templates in a render (REMOTION_E2E=1)',
	{ timeout: 600_000 },
	() => {
		let media: FxMedia;
		let serveUrl: string;
		let renderer: typeof import('@remotion/renderer');
		let puppeteerInstance: Awaited<ReturnType<typeof renderer.openBrowser>> | undefined;
		const remotionBrowser = { browserExecutable: CHROME, chromeMode: 'chrome-for-testing' as const };

		beforeAll(async () => {
			mkdirSync(OUT, { recursive: true });
			media = await startFxMedia('title-template-');
			const { bundle } = await import('@remotion/bundler');
			serveUrl = await bundle({ entryPoint: join(here, 'fx-render', 'entry.ts') });
			renderer = await import('@remotion/renderer');
			puppeteerInstance = await renderer.openBrowser('chrome', {
				...remotionBrowser,
				chromiumOptions: { gl: 'swangle' },
			});
		}, 600_000);

		afterAll(async () => {
			await puppeteerInstance?.close({ silent: true });
			media?.close();
		});

		for (const s of SHOTS)
			it(`${s.template} draws over the backdrop`, async () => {
				const snapshot = build(media, s.template, s.preset);
				const inputProps = {
					doc: snapshot,
					options: { isPreview: false, useProxies: false, transparentBackground: false },
				};
				const composition = await renderer.selectComposition({
					serveUrl,
					id: SEQUENCE_COMPOSITION_ID,
					inputProps,
					puppeteerInstance,
					timeoutInMilliseconds: LOAD_TIMEOUT,
					...remotionBrowser,
				});
				const output = join(OUT, `${s.template}.png`);
				await renderer.renderStill({
					composition,
					serveUrl,
					inputProps,
					frame: s.frame,
					output,
					puppeteerInstance,
					timeoutInMilliseconds: LOAD_TIMEOUT,
					...remotionBrowser,
				});
				const raw = execFileSync(
					'ffmpeg',
					['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
					{ maxBuffer: 1 << 28 },
				);
				const base = BACKDROP.slice(0, 3).map((v) => Math.round(v * 255));
				let changed = 0;
				for (let i = 0; i < raw.length; i += 3)
					if (
						Math.abs(raw[i]! - base[0]!) +
							Math.abs(raw[i + 1]! - base[1]!) +
							Math.abs(raw[i + 2]! - base[2]!) >
						40
					)
						changed++;
				expect(changed, s.template).toBeGreaterThan(1500);
			});
	},
);
