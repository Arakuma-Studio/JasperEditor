// Link Media on the engine (docs/wp-notes/link-media.md): Relink others automatically from a located file, match
// property verification, ambiguity and bounded cancellation. HTTP wiring lives in interchange.test.ts.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type RegisteredMedia, type RelinkScanRequest, RelinkScanRequestSchema } from '@jasper/api';
import type { MediaAsset } from '@jasper/project';
import { describe, expect, it, vi } from 'vitest';
import { type RelinkScanDeps, runRelinkScan } from '../src/interchange/relink.ts';
import { tempAppdir } from './temp.ts';

const FLICKS = 705_600_000;

/** An offline placeholder as an imported Premiere project has it: a Windows path and (optionally) a relative one. */
function placeholder(
	id: string,
	path: string,
	opts: {
		seconds?: number;
		kind?: MediaAsset['kind'];
		rel?: string;
		fingerprint?: string;
		size?: number;
	} = {},
): MediaAsset {
	const kind = opts.kind ?? 'video';
	const name = path.split(/[\\/]/).pop()!;
	return {
		id,
		kind,
		fingerprint: opts.fingerprint ?? `pending:interchange:${id}`,
		originalName: name,
		sizeBytes: opts.size ?? 0,
		container: '',
		probe: {
			durationFlicks: kind === 'image' ? null : Math.round((opts.seconds ?? 2) * FLICKS),
			startTimecode: null,
			streams:
				kind === 'audio'
					? [{ index: 0, type: 'audio', codec: '', sampleRate: 48000, channels: 2, channelLayout: 'stereo' }]
					: [
							{
								index: 0,
								type: 'video',
								codec: '',
								width: 1920,
								height: 1080,
								pixelAspect: { num: 1, den: 1 },
								frameRate: { num: 30, den: 1 },
								pixelFormat: '',
								bitDepth: 8,
								color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
								browserDecodable: null,
							},
						],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'path', path, relativeToProject: opts.rel ?? null }],
		derivation: null,
		importedAt: '2026-10-25T00:00:00.000Z',
	} as MediaAsset;
}

/** A tree of files; `seconds` is what the fake registration reports as each file's duration. */
function tree(root: string, files: Record<string, number>): void {
	for (const [rel, seconds] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(join(p, '..'), { recursive: true });
		writeFileSync(p, `${seconds}`);
	}
}

const AUDIO = /\.(wav|mp3|aif)$/i;
const IMAGE = /\.(png|jpg)$/i;
function fakeDeps(over: Partial<RelinkScanDeps> = {}): RelinkScanDeps {
	let nextMediaKey = 0;
	return {
		register: async (p) => {
			const mediaKey = `mk_${++nextMediaKey}`;
			const seconds = Number(readFileSync(p, 'utf8')) || 2;
			const kind = AUDIO.test(p) ? 'audio' : IMAGE.test(p) ? 'image' : 'video';
			const a = placeholder('x', p, { seconds, kind });
			return {
				mediaKey,
				fingerprint: `q1:${p}`,
				originalName: basename(p),
				sizeBytes: statSync(p).size,
				container: 'mov,mp4',
				kind,
				probe: { ...a.probe, startTimecode: '01:00:00:00' },
				locators: [
					{ type: 'engine-store', engineId: 'local', key: mediaKey },
					{ type: 'path', path: p, relativeToProject: null },
				],
				browserPlayable: 'yes',
			} as RegisteredMedia;
		},
		fingerprint: async (p) => `q1:${p}`,
		host: 'posix',
		signal: new AbortController().signal,
		progress: () => undefined,
		...over,
	};
}

const scan = (req: RelinkScanRequest, deps = fakeDeps()) =>
	runRelinkScan(RelinkScanRequestSchema.parse(req), deps);

describe('Relink others automatically (engine search)', () => {
	it('one located Windows file relinks the others by the folder mapping, relative path, same folder and search', async () => {
		const mac = tempAppdir('jasper-mac-');
		tree(mac, {
			'Videos/Short A/TV static.mp4': 2,
			'Videos/Short A/avatar/Happy.png': 0,
			'Assets/music/Composer/theme.mp3': 3,
			'Audio/voice.wav': 1,
			// moved out of its old folder into the located file's folder
			'Videos/Short A/loose.wav': 1,
			// moved deeper under the located file's folder
			'Videos/Short A/deep/er/buried.mov': 2,
			// two files of the same name: never guessed
			'Videos/Short A/a/dup.mov': 2,
			'Videos/Short A/b/dup.mov': 2,
		});
		const assets = [
			placeholder('happy', 'D:\\Videos\\Short A\\avatar\\Happy.png', { kind: 'image' }),
			placeholder('sans', 'D:\\Assets\\music\\Composer\\theme.mp3', { kind: 'audio', seconds: 3 }),
			placeholder('loose', 'E:\\Old SFX\\loose.wav', { kind: 'audio', seconds: 1 }),
			placeholder('buried', 'F:\\elsewhere\\buried.mov'),
			placeholder('dup', 'G:\\x\\dup.mov'),
			placeholder('gone', 'D:\\Videos\\Short A\\never there.mov'),
			placeholder('voice', '\\\\nas\\share\\voice.wav', {
				kind: 'audio',
				seconds: 1,
				rel: 'Audio\\voice.wav',
			}),
		];
		const r = await scan({
			anchors: [
				{
					from: 'D:\\Videos\\Short A\\TV static.mp4',
					to: join(mac, 'Videos/Short A/TV static.mp4'),
					relativePath: 'Videos\\Short A\\TV static.mp4',
				},
			],
			assets,
			// Unknown size/timecode on imported placeholders must not reject recorded candidate metadata.
			match: ['name', 'duration', 'streams', 'size', 'mediaStart'],
		});
		const by = Object.fromEntries(r.found.map((f) => [f.assetId, [f.step, f.path]]));
		expect(by).toEqual({
			happy: ['mapping', join(mac, 'Videos/Short A/avatar/Happy.png')],
			sans: ['mapping', join(mac, 'Assets/music/Composer/theme.mp3')],
			loose: ['same-folder', join(mac, 'Videos/Short A/loose.wav')],
			buried: ['search', join(mac, 'Videos/Short A/deep/er/buried.mov')],
			voice: ['relative', join(mac, 'Audio/voice.wav')],
		});
		expect(r.found.every((f) => f.match === 'placeholder' && f.needsConfirm === false)).toBe(true);
		expect(r.ambiguous).toEqual([
			{
				assetId: 'dup',
				step: 'search',
				candidates: [join(mac, 'Videos/Short A/a/dup.mov'), join(mac, 'Videos/Short A/b/dup.mov')],
			},
		]);
		expect(r.notFound).toEqual(['gone']);
		expect(r.mappings).toEqual([{ from: 'D:\\', to: mac }]);
	});

	it('verifies the match properties: a wrong duration or kind is rejected, File Extension off finds a transcode', async () => {
		const root = tempAppdir('jasper-verify-');
		tree(root, { 'M/a.mov': 2, 'M/short.mov': 0.2, 'M/clip.mp4': 2, 'M/tone.mov': 1 });
		const anchors = [{ from: 'D:\\M\\a.mov', to: join(root, 'M/a.mov') }];
		const assets = [
			placeholder('short', 'D:\\M\\short.mov', { seconds: 5 }),
			placeholder('clip', 'D:\\M\\clip.mov'),
			placeholder('tone', 'D:\\M\\tone.mov', { kind: 'audio', seconds: 1 }),
		];
		const strict = await scan({ anchors, assets, match: ['name', 'duration', 'streams'] });
		// a placeholder whose only difference is its (guessed) streams is found, but waits for confirmation
		expect(strict.found.map((f) => [f.assetId, f.needsConfirm])).toEqual([['tone', true]]);
		expect(strict.notFound).toEqual(['short', 'clip']);
		const noExt = await scan({ anchors, assets, match: ['name', 'duration'], ignoreExtension: true });
		// without Streams the video file named like the audio asset is found too, but only with confirmation
		expect(noExt.found.map((f) => [f.assetId, basename(f.path), f.needsConfirm])).toEqual([
			['clip', 'clip.mp4', false],
			['tone', 'tone.mov', true],
		]);
		// without the duration check the short file is found, but linking it needs confirmation (clips need 5 s)
		const loose = await scan({ anchors, assets: [assets[0]!], match: ['name'] });
		expect(loose.found[0]).toMatchObject({ assetId: 'short', needsConfirm: true });
	});

	it('selects a renamed asset by fingerprint over a same-size different candidate', async () => {
		const root = tempAppdir('jasper-fp-');
		tree(root, { 'new/a-wrong.mov': 2, 'new/renamed.mov': 2 });
		const p = join(root, 'new/renamed.mov');
		const r = await scan({
			folder: root,
			assets: [placeholder('real', '/gone/original.mov', { fingerprint: `q1:${p}`, size: 1 })],
			match: ['name'],
		});
		expect(r.found.map((f) => [f.assetId, f.step, f.match, f.path])).toEqual([
			['real', 'fingerprint', 'fingerprint', p],
		]);
	});

	it('the folder walk honours its file cap and time budget; cancelling stops the job', async () => {
		const root = tempAppdir('jasper-caps-');
		const files: Record<string, number> = {};
		for (let i = 0; i < 12; i++) files[`d${i}/f${i}.mov`] = 2;
		tree(root, files);
		const assets = [placeholder('x', '/old/nothing.mov')];
		const capped = await scan({ folder: root, assets, maxFiles: 10 });
		expect(capped.truncated).toBe(true);
		expect(capped.scannedFiles).toBe(10);
		let t = 0;
		const clock = vi.spyOn(Date, 'now').mockImplementation(() => (t += 400));
		try {
			const timed = await scan({ folder: root, assets, timeLimitSec: 1 });
			expect(timed.timedOut).toBe(true);
			expect(timed.scannedFiles).toBeLessThan(12);
		} finally {
			clock.mockRestore();
		}
		const ac = new AbortController();
		ac.abort();
		await expect(scan({ folder: root, assets }, fakeDeps({ signal: ac.signal }))).rejects.toMatchObject({
			code: 'JOB_CANCELLED',
		});
	});
});
