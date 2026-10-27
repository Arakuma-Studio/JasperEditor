import { MaskTraceRequestSchema, type MaskTraceResponse } from '@jasper/api';
import { traceFieldOf, tracePaths } from '@jasper/project';
import type { FastifyInstance } from 'fastify';
import type { Ffmpeg } from '../tools/ffmpeg.ts';
import { terminateTree } from '../tools/process.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

/** Decodes source frame `frame` of `file` to straight RGBA at `w×h` (display orientation). */
async function decodeRgbaFrame(
	ff: Ffmpeg,
	file: string,
	frame: number,
	fps: { num: number; den: number } | null,
	w: number,
	h: number,
): Promise<Uint8Array> {
	const seek = fps && frame > 0 ? ['-ss', (((frame - 0.5) * fps.den) / fps.num).toFixed(6)] : [];
	const child = ff.spawnRaw([
		...seek,
		'-i',
		file,
		...['-map', '0:v:0', '-an', '-sn', '-dn'],
		...['-vf', `scale=${w}:${h}:flags=bicubic,format=rgba`, '-frames:v', '1'],
		...['-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
	]);
	const chunks: Buffer[] = [];
	let stderr = '';
	child.stderr?.setEncoding('utf8').on('data', (c: string) => {
		stderr = (stderr + c).slice(-2000);
	});
	try {
		for await (const c of child.stdout! as AsyncIterable<Buffer>) chunks.push(c);
		const code = await new Promise<number | null>((resolve) => {
			if (child.exitCode !== null) resolve(child.exitCode);
			else child.once('close', (c) => resolve(c));
		});
		const buf = Buffer.concat(chunks);
		if (code !== 0 || buf.length < w * h * 4)
			throw new HttpError(
				422,
				'UNSUPPORTED_MEDIA',
				`Cannot decode frame ${frame}: ${stderr.trim().slice(-500)}`,
			);
		return new Uint8Array(buf.buffer, buf.byteOffset, w * h * 4);
	} finally {
		if (child.exitCode === null) await terminateTree(child, 200);
	}
}

export default async function maskRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	app.post(
		'/api/masks/trace',
		guarded(async (req, reply) => {
			const r = parseOr400(MaskTraceRequestSchema, req.body);
			const rec = core.registry.get(r.mediaKey);
			if (!rec) throw new HttpError(404, 'ASSET_NOT_FOUND', `Unknown media key ${r.mediaKey}`);
			const file = await core.registry.resolvePath(r.mediaKey);
			if (!file) throw new HttpError(404, 'ASSET_NOT_FOUND', 'The media file is offline');
			const vs = rec.probe.streams.find((s) => s.type === 'video');
			if (vs?.type !== 'video') throw new HttpError(400, 'VALIDATION_FAILED', 'The media has no picture');
			const rgba = await decodeRgbaFrame(core.ffmpeg, file, r.frame, vs.frameRate, r.width, r.height);
			const field = traceFieldOf(rgba, r.width, r.height, r.channel);
			if (r.invert) for (let i = 0; i < field.length; i++) field[i] = 1 - field[i]!;
			const traced = tracePaths(field, r.width, r.height, {
				threshold: r.threshold,
				tolerance: r.tolerance,
				minArea: r.minArea,
				cornerRoundness: r.cornerRoundness,
			});
			const W = r.width;
			const H = r.height;
			const out: MaskTraceResponse = {
				total: traced.length,
				paths: traced.slice(0, r.maxPaths).map((t) => ({
					depth: t.depth,
					area: t.area,
					path: {
						closed: true,
						vertices: t.path.vertices.map((v) => ({
							p: [v.p[0] / W, v.p[1] / H] as [number, number],
							in: [v.in[0] / W, v.in[1] / H] as [number, number],
							out: [v.out[0] / W, v.out[1] / H] as [number, number],
						})),
					},
				})),
			};
			return reply.send(out);
		}),
	);
}
