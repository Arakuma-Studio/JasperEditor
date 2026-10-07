// wp captions: reads a caption or transcript file by path for the editor (desktop File ▸ Import of caption files,
// which cannot be registered as media). Local engines only, like path registration (S04:SC-002); only caption /
// transcript extensions, at most 64 MB.
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { CAPTION_FILE_EXTENSIONS, CaptionFileReadRequestSchema } from '@jasper/api';
import type { FastifyInstance } from 'fastify';
import { isLoopbackHost } from '../context.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

const MAX_BYTES = 64 * 1024 * 1024;

export default async function captionRoutes(app: FastifyInstance): Promise<void> {
	const core = coreServices(app);
	app.post(
		'/api/captions/read',
		guarded(async (req) => {
			if (!core.config.dev && !isLoopbackHost(core.config.host))
				throw new HttpError(403, 'LOCAL_MODE_ONLY', 'Reading files by path is only available in local mode');
			const { path } = parseOr400(CaptionFileReadRequestSchema, req.body);
			if (!isAbsolute(path)) throw new HttpError(400, 'VALIDATION_FAILED', 'The path must be absolute');
			const ext = extname(path).slice(1).toLowerCase();
			if (!(CAPTION_FILE_EXTENSIONS as readonly string[]).includes(ext))
				throw new HttpError(400, 'UNSUPPORTED_FILE', `Not a caption or transcript file: .${ext}`);
			const info = await stat(path).catch(() => null);
			if (!info?.isFile()) throw new HttpError(404, 'NOT_FOUND', 'No such file');
			if (info.size > MAX_BYTES)
				throw new HttpError(413, 'TOO_LARGE', 'Caption files larger than 64 MB are not read');
			const bytes = await readFile(path);
			return { name: basename(path), bytes: bytes.length, contentBase64: bytes.toString('base64') };
		}),
	);
}
