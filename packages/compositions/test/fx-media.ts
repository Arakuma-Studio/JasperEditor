import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type MediaAsset,
} from '@jasper/project';
import { BROWSER_VIDEO_ARGS } from '@jasper/testkit/fixture-video';
import { testFxRegistry } from './fx-examples.ts';

export const FX_W = 640;
export const FX_H = 360;

export type FxMedia = {
	dir: string;
	base: string;
	video: string;
	close(): void;
	/** Serves an in-memory file at `/<name>` (test pages). */
	page(name: string, type: string, body: string): void;
};

export async function startFxMedia(prefix: string): Promise<FxMedia> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
	ff(['-f', 'lavfi', '-i', 'color=c=red:s=200x200', '-frames:v', '1', join(dir, 'red.png')]);
	const src = `testsrc2=s=${FX_W}x${FX_H}:r=30:d=2`;
	// VP9 in MP4: an LGPL encoder every FFmpeg build here has, and a codec every Chromium decodes
	const video = 'clip.mp4';
	ff(['-f', 'lavfi', '-i', src, '-pix_fmt', 'yuv420p', ...BROWSER_VIDEO_ARGS, join(dir, video)]);
	const pages = new Map<string, { type: string; body: string }>();
	const server = createServer((req, res) => {
		const name = decodeURIComponent((req.url ?? '/').split('?')[0]!.slice(1));
		const mem = pages.get(name);
		// UTF-8 always: bundles carry non-ASCII literals (XML name regexes), which Latin-1 decoding breaks.
		if (mem) {
			const memType = /charset=/i.test(mem.type) ? mem.type : `${mem.type}; charset=utf-8`;
			return void res.writeHead(200, { 'Content-Type': memType }).end(mem.body);
		}
		const file = join(dir, name);
		if (!file.startsWith(dir) || !existsSync(file)) return void res.writeHead(404).end();
		const size = statSync(file).size;
		const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.webm') ? 'video/webm' : 'video/mp4';
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
			return void createReadStream(file, { start, end }).pipe(res);
		}
		res.writeHead(200, { ...headers, 'Content-Length': size });
		if (req.method === 'HEAD') return void res.end();
		createReadStream(file).pipe(res);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		dir,
		base,
		video,
		close: () => server.close(),
		page: (name, type, body) => pages.set(name, { type, body }),
	};
}

export function fxAsset(
	m: FxMedia,
	kind: 'image' | 'video',
	name: string,
	w: number,
	h: number,
): Omit<MediaAsset, 'id'> {
	return {
		kind,
		fingerprint: `q1:${name.padStart(64, '0')}`,
		originalName: name,
		sizeBytes: statSync(join(m.dir, name)).size,
		container: kind === 'image' ? 'png_pipe' : 'mov,mp4',
		probe: {
			durationFlicks: kind === 'image' ? null : 2 * FLICKS_PER_SECOND,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: kind === 'image' ? 'png' : 'h264',
					width: w,
					height: h,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'url', url: `${m.base}/${name}` }],
		derivation: null,
		importedAt: '2026-10-05T10:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

export function fxSnapshot(
	commands: Command[] | ((doc: ReturnType<typeof createEmptyProject>) => Command[]),
) {
	const ids = createCounterIdSource(1);
	const project = createEmptyProject({ ids, name: 'fx', preset: 'hd-720p-30' });
	// Track Matte Key commands may need track ids from the empty project.
	const list = typeof commands === 'function' ? commands(project) : commands;
	const ctx = {
		ids,
		now: () => '2026-10-05T10:00:00.000Z',
		revision: 0,
		registries: { ...defaultRegistries(), effects: testFxRegistry },
	};
	const seqId = Object.keys(project.sequences)[0]!;
	const { document, result } = applyTransaction(
		project,
		{
			label: 'fx',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'sequence.updateSettings',
					sequenceId: seqId,
					settings: { width: FX_W, height: FX_H },
				} as Command,
				...list,
			],
		},
		ctx,
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
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
		resolveFont: () => null,
	});
}

export const fxCmd = {
	video(m: FxMedia, seconds = 1): Command[] {
		return [
			{
				type: 'media.register',
				ref: '$m',
				asset: fxAsset(m, 'video', m.video, FX_W, FX_H),
			} as unknown as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds } },
				tracks: { video: 'V1' },
				ref: '$c',
			} as unknown as Command,
		];
	},
	still(m: FxMedia): Command[] {
		return [
			{
				type: 'media.register',
				ref: '$m',
				asset: fxAsset(m, 'image', 'red.png', 200, 200),
			} as unknown as Command,
			{
				type: 'clip.place',
				source: { mediaId: '$m' },
				at: 0,
				tracks: { video: 'V1' },
				ref: '$c',
			} as unknown as Command,
		];
	},
	shape(): Command[] {
		return [
			{
				type: 'clip.addShape',
				at: 0,
				duration: 30,
				track: 'V1',
				shape: { type: 'rect', size: [100, 100], fill: [1, 1, 1, 1] },
				ref: '$c',
			} as Command,
		];
	},
	solid(color: [number, number, number, number]): Command[] {
		return [{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V1', color, ref: '$c' } as Command];
	},
	/**
	 * Transform on the clip with a keyframed Position (layer-normalised x from 0 to 1 over frames 0…10: the picture
	 * moves 1/10 of its width per frame) and a 360° Shutter Angle (or the composition's, i.e. none).
	 */
	movingTransform(useCompShutterAngle: boolean): Command[] {
		return [
			{
				type: 'effect.add',
				target: { clipId: '$c' },
				effectId: 'jasper.transform',
				params: { useCompShutterAngle, shutterAngle: 360 },
				ref: '$t',
			} as unknown as Command,
			{
				type: 'keyframe.add',
				target: ['effect', '$t', 'position'],
				at: { frames: 0 },
				value: [0, 0.5],
			} as Command,
			{
				type: 'keyframe.add',
				target: ['effect', '$t', 'position'],
				at: { frames: 10 },
				value: [1, 0.5],
			} as Command,
		];
	},
	effect(effectId: string, params?: Record<string, unknown>): Command {
		return {
			type: 'effect.add',
			target: { clipId: '$c' },
			effectId,
			...(params ? { params } : {}),
		} as Command;
	},
};
