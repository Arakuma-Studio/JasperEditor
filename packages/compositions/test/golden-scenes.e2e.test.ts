// @vitest-environment node
// Golden frames of the composition (golden-fuzz; docs/testing.md §Golden frames): every scene of golden/scenes.ts —
// compositor, blend modes, masks, adjustment layers, nests, colour, GPU effects of every family, text, text
// animators, shapes, 3D, time remapping, sim-warp, captions, a transition — is rendered as one 256×144 still by
// @remotion/renderer in headless Chrome (the engine's export and bake path) and compared with
// goldens/scenes/<name>.png (Tolerance.BROWSER; JASPER_BLESS=1 re-blesses, failures write actual / expected / ×8
// diff to test-results/golden-failures/). A guard checks that no scene is blank or a duplicate of another.
// Media are generated here (pictures by the test, a movie by ffmpeg); text uses the repository's Inter font.
// Gated by REMOTION_E2E=1 (bundling ≈ 15–40 s); needs ffmpeg and a Chrome.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '@jasper/project';
import { assertDistinctScenes, expectGolden, Tolerance } from '@jasper/testkit/golden';
import type { Rgba8 } from '@jasper/testkit/image';
import { ffmpeg, oraclesAvailable } from '@jasper/testkit/oracle';
import { decodePng, encodePng } from '@jasper/testkit/png';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';
import { type FxMedia, fxAsset, startFxMedia } from './fx-media.ts';
import { GH, GW, goldenCard, goldenTile, SCENES } from './golden/scenes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const GOLDENS = join(here, 'goldens', 'scenes');
const FONT = join(root, 'native/mg/crates/jasper-mg-templates/media/Inter_24pt-Regular.ttf');
const enabled = process.env.REMOTION_E2E === '1' && oraclesAvailable('ffmpeg');

describe.runIf(enabled)('golden scenes rendered by Remotion (REMOTION_E2E=1)', { timeout: 600_000 }, () => {
	let media: FxMedia;
	let serveUrl: string;
	let renderer: typeof import('@remotion/renderer');
	const browserExecutable =
		process.env.JASPER_BROWSER_EXECUTABLE ??
		(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
	const browser = browserExecutable ? { browserExecutable, chromeMode: 'chrome-for-testing' as const } : {};
	const frames: Record<string, Rgba8> = {};

	beforeAll(async () => {
		media = await startFxMedia('golden-scenes-');
		writeFileSync(join(media.dir, 'card.png'), encodePng(goldenCard()));
		writeFileSync(join(media.dir, 'tile.png'), encodePng(goldenTile()));
		copyFileSync(FONT, join(media.dir, 'inter.ttf'));
		// A generated movie at the sequence size (frame numbers burned in by testsrc2), 2 s at 30 fps.
		ffmpeg([
			'-f',
			'lavfi',
			'-i',
			`testsrc2=s=${GW}x${GH}:r=30:d=2`,
			'-pix_fmt',
			'yuv420p',
			'-c:v',
			'libvpx-vp9',
			'-b:v',
			'0',
			'-crf',
			'20',
			'-g',
			'1',
			join(media.dir, 'golden.webm'),
		]);
		const { bundle } = await import('@remotion/bundler');
		serveUrl = await bundle({ entryPoint: join(here, '../src/remotion-entry.ts') });
		renderer = await import('@remotion/renderer');
	}, 600_000);
	afterAll(() => media?.close());

	function snapshot(commands: Command[]) {
		const ids = createCounterIdSource(1);
		const project = createEmptyProject({ ids, name: 'golden', preset: 'hd-720p-30' });
		const seqId = Object.keys(project.sequences)[0]!;
		const { document, result } = applyTransaction(
			project,
			{
				label: 'golden',
				origin: 'user',
				sequenceId: seqId,
				commands: [
					{
						type: 'sequence.updateSettings',
						sequenceId: seqId,
						settings: { width: GW, height: GH },
					} as Command,
					...commands,
				],
			},
			{ ids, now: () => '2026-10-08T00:00:00.000Z', revision: 0, registries: defaultRegistries() },
		);
		if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 1));
		return buildRenderSnapshot(document, seqId, {
			resolveMedia: (a) => {
				const loc = a.locators.find((l) => l.type === 'url');
				const vs = a.probe.streams.find((s) => s.type === 'video');
				return loc?.type === 'url'
					? {
							url: loc.url,
							proxyUrl: null,
							kind: a.kind,
							width: vs?.type === 'video' ? vs.width : null,
							height: vs?.type === 'video' ? vs.height : null,
							durationFlicks: a.probe.durationFlicks,
							hasAudio: false,
							rotation: 0,
						}
					: null;
			},
			// Every face renders with the repository's Inter: the same glyphs on every machine.
			resolveFont: () => `${media.base}/inter.ttf`,
		});
	}

	async function still(doc: ReturnType<typeof snapshot>, frame: number, name: string): Promise<Rgba8> {
		const inputProps = {
			doc,
			options: { isPreview: false, useProxies: false, transparentBackground: false },
		};
		const composition = await renderer.selectComposition({
			serveUrl,
			id: SEQUENCE_COMPOSITION_ID,
			inputProps,
			...browser,
		});
		const output = join(media.dir, `${name}.png`);
		await renderer.renderStill({ composition, serveUrl, inputProps, frame, output, ...browser });
		return decodePng(readFileSync(output));
	}

	const asset = (kind: 'image' | 'video', file: string, w: number, h: number) => {
		const a = fxAsset(media, kind, file, w, h) as unknown as {
			container: string;
			probe: { streams: { codec?: string }[] };
		};
		if (kind === 'video') {
			a.container = 'matroska,webm';
			a.probe.streams[0]!.codec = 'vp9';
		}
		return a;
	};

	for (const scene of SCENES)
		it(`${scene.name}: ${scene.covers}`, async () => {
			const doc = snapshot(
				scene.commands({ card: 'card.png', tile: 'tile.png', video: 'golden.webm', asset }),
			);
			const img = await still(doc, scene.frame, `golden-${scene.name}`);
			expect([img.width, img.height]).toEqual([GW, GH]);
			frames[scene.name] = img;
			expectGolden(join(GOLDENS, `${scene.name}.png`), img, Tolerance.BROWSER);
		});

	it('no scene is blank or a duplicate of another', () => {
		expect(Object.keys(frames).length).toBe(SCENES.length);
		assertDistinctScenes(frames);
	});
});
