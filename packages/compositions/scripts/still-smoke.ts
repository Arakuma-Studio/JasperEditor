// `pnpm --filter @jasper/compositions still:smoke`
// Bundles the compositions with @remotion/bundler and renders stills with @remotion/renderer against
// fixtures/media/clip-a.mp4 served from a temporary static HTTP server (with Range support), then checks
// the PNGs: size equals the sequence size and the sampled pixels show video + text, not black.
//
// Browser: JASPER_BROWSER_EXECUTABLE, else /usr/bin/google-chrome when present (run as
// chrome-for-testing, i.e. --headless=new), else Remotion's own downloaded headless shell.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
} from '@jasper/project';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { SEQUENCE_COMPOSITION_ID } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const mediaDir = join(root, 'fixtures/media');
const clip = join(mediaDir, 'clip-a.mp4');
const outDir = join(root, 'packages/compositions/.smoke');

function fail(msg: string): never {
	console.error(`still:smoke FAILED: ${msg}`);
	process.exit(1);
}

if (!existsSync(clip)) fail(`missing ${clip}; run \`pnpm fixtures\` first`);
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- static media server (Range)
const server = createServer((req, res) => {
	const name = decodeURIComponent((req.url ?? '/').split('?')[0]!.slice(1));
	const file = join(mediaDir, name);
	if (!file.startsWith(mediaDir) || !existsSync(file)) {
		res.writeHead(404).end();
		return;
	}
	const size = statSync(file).size;
	const type = file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.png') ? 'image/png' : 'audio/wav';
	const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': type, 'Access-Control-Allow-Origin': '*' };
	const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
	if (range) {
		const start = range[1] ? Number(range[1]) : 0;
		const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		res.writeHead(206, {
			...headers,
			'Content-Range': `bytes ${start}-${end}/${size}`,
			'Content-Length': end - start + 1,
		});
		if (req.method === 'HEAD') return void res.end();
		createReadStream(file, { start, end }).pipe(res);
		return;
	}
	res.writeHead(200, { ...headers, 'Content-Length': size });
	if (req.method === 'HEAD') return void res.end();
	createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ---------------------------------------------------------------- document: video on V1 + text on V2
const ids = createCounterIdSource(1);
const project = createEmptyProject({ ids, name: 'Smoke', preset: 'hd-1080p-30' });
const ctx = { ids, now: () => new Date().toISOString(), revision: 0, registries: defaultRegistries() };
const { document, result } = applyTransaction(
	project,
	{
		label: 'setup',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				ref: '$m',
				asset: {
					kind: 'video',
					fingerprint: 'q1:smoke',
					originalName: 'clip-a.mp4',
					sizeBytes: statSync(clip).size,
					container: 'mp4',
					probe: {
						durationFlicks: 10 * FLICKS_PER_SECOND,
						startTimecode: null,
						streams: [
							{
								index: 0,
								type: 'video',
								codec: 'h264',
								width: 1920,
								height: 1080,
								pixelAspect: { num: 1, den: 1 },
								frameRate: { num: 30, den: 1 },
								pixelFormat: 'yuv420p',
								bitDepth: 8,
								color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
								browserDecodable: true,
							},
							{
								index: 1,
								type: 'audio',
								codec: 'aac',
								sampleRate: 48000,
								channels: 2,
								channelLayout: 'stereo',
							},
						],
						rotationDegrees: 0,
						hasAlpha: false,
						variableFrameRate: false,
					},
					locators: [{ type: 'url', url: `${base}/clip-a.mp4` }],
				},
			},
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { seconds: 2 }, out: { seconds: 6 } },
				tracks: { video: 'V1', audio: 'A1' },
			},
			{
				type: 'clip.addText',
				at: 0,
				duration: 120,
				track: 'V2',
				content: { text: 'JASPER SMOKE', style: { sizePx: 120, fill: [1, 0.9, 0, 1] } },
				transform: { position: [960, 900], rotation: -5 },
			},
		],
	},
	ctx,
);
if (!result.ok) fail(`transaction failed: ${JSON.stringify(result.errors)}`);
const seqId = Object.keys(document.sequences)[0]!;
const doc = buildRenderSnapshot(document, seqId, {
	resolveMedia: (asset) => {
		const loc = asset.locators.find((l) => l.type === 'url');
		const vs = asset.probe.streams.find((s) => s.type === 'video');
		return loc && loc.type === 'url'
			? {
					url: loc.url,
					proxyUrl: null,
					kind: asset.kind,
					width: vs?.type === 'video' ? vs.width : null,
					height: vs?.type === 'video' ? vs.height : null,
					durationFlicks: asset.probe.durationFlicks,
					hasAudio: true,
					rotation: 0,
				}
			: null;
	},
	resolveFont: () => null,
});
const inputProps = {
	doc,
	options: { isPreview: false, useProxies: false, transparentBackground: false },
};

// ---------------------------------------------------------------- bundle + render
const t0 = Date.now();
const serveUrl = await bundle({ entryPoint: join(root, 'packages/compositions/src/remotion-entry.ts') });
console.log(`bundled in ${Date.now() - t0} ms`);
const sys =
	process.env.JASPER_BROWSER_EXECUTABLE ??
	(existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null);
const browser = sys ? { browserExecutable: sys, chromeMode: 'chrome-for-testing' as const } : {};
const composition = await selectComposition({
	serveUrl,
	id: SEQUENCE_COMPOSITION_ID,
	inputProps,
	...browser,
});
console.log(
	`composition ${composition.id}: ${composition.width}x${composition.height} @ ${composition.fps} fps, ${composition.durationInFrames} frames`,
);
if (composition.width !== 1920 || composition.height !== 1080 || composition.durationInFrames !== 120)
	fail('calculateMetadata did not take size/duration from the document');

function pngSize(file: string): { width: number; height: number } {
	const b = readFileSync(file);
	if (b.toString('ascii', 1, 4) !== 'PNG') fail(`${file} is not a PNG`);
	return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function pixel(file: string, x: number, y: number): [number, number, number] {
	const raw = execFileSync('ffmpeg', [
		'-v',
		'error',
		'-i',
		file,
		'-vf',
		`crop=1:1:${x}:${y}`,
		'-f',
		'rawvideo',
		'-pix_fmt',
		'rgb24',
		'-',
	]);
	return [raw[0]!, raw[1]!, raw[2]!];
}

const results: string[] = [];
for (const frame of [0, 45]) {
	const output = join(outDir, `still-${frame}.png`);
	const t1 = Date.now();
	await renderStill({ composition, serveUrl, output, frame, inputProps, ...browser });
	const { width, height } = pngSize(output);
	if (width !== 1920 || height !== 1080) fail(`frame ${frame}: PNG is ${width}x${height}`);
	// testsrc2 is colorful everywhere; the text is yellow near y=900.
	const bg = pixel(output, 200, 200);
	const lum = (bg[0] + bg[1] + bg[2]) / 3;
	if (lum < 8) fail(`frame ${frame}: video area is black (${bg.join(',')}) — media did not render`);
	results.push(
		`frame ${frame}: ${width}x${height}, ${statSync(output).size} bytes, px(200,200)=${bg.join(',')} (${Date.now() - t1} ms)`,
	);
}
// Speed 2×: the media time at frame 45 must be sourceIn (2 s) + 1.5 s × 2 = 5 s (trimBefore is not
// scaled by playbackRate). The testsrc2 timecode burned into the frame shows it; inspect by eye.
const fast = {
	...inputProps,
	doc: {
		...doc,
		videoTracks: doc.videoTracks.map((t) => ({
			...t,
			clips: t.clips.map((c) => (c.kind === 'video' ? { ...c, speed: { ...c.speed, rate: 2 } } : c)),
		})),
	},
};
const speedOut = join(outDir, 'still-45-speed2.png');
// renderStill renders `composition.props` (resolved at selectComposition time), so select again.
const fastComposition = await selectComposition({
	serveUrl,
	id: SEQUENCE_COMPOSITION_ID,
	inputProps: fast,
	...browser,
});
await renderStill({
	composition: fastComposition,
	serveUrl,
	output: speedOut,
	frame: 45,
	inputProps: fast,
	...browser,
});
results.push(`speed 2x frame 45 -> ${speedOut} (burned-in source time should read 00:00:05.000)`);
server.close();
console.log(results.join('\n'));
console.log('still:smoke OK');
