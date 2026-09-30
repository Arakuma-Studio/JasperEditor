// Byte serving for media, derivatives, renders and fonts (S04:MS-002): HEAD, single Range → 206,
// Accept-Ranges, ETag / Last-Modified, conditional requests, streaming without buffering.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { errorBody } from '@jasper/api';
import type { FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.mkv': 'video/x-matroska',
	'.avi': 'video/x-msvideo',
	'.ts': 'video/mp2t',
	'.m2ts': 'video/mp2t',
	'.mxf': 'application/mxf',
	'.mpg': 'video/mpeg',
	'.mpeg': 'video/mpeg',
	'.wav': 'audio/wav',
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
	'.ogg': 'audio/ogg',
	'.opus': 'audio/ogg',
	'.aif': 'audio/aiff',
	'.aiff': 'audio/aiff',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.tif': 'image/tiff',
	'.tiff': 'image/tiff',
	'.svg': 'image/svg+xml',
	'.json': 'application/json',
	'.bin': 'application/octet-stream',
	'.woff2': 'font/woff2',
	'.woff': 'font/woff',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
};

export function contentTypeFor(file: string, fallback = 'application/octet-stream'): string {
	return TYPES[extname(file).toLowerCase()] ?? fallback;
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a `Range` header for a resource of `size` bytes. Returns `null` (serve the whole file) for a
 * missing, malformed or multi-range header, `'unsatisfiable'` for ranges outside the file.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
	if (!header) return null;
	const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
	if (!m) return null; // multi-range or other units: ignore (RFC 9110 allows a full 200)
	const [, a, b] = m;
	if (a === '' && b === '') return null;
	if (a === '') {
		const suffix = Number(b);
		if (suffix === 0) return 'unsatisfiable';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(a);
	const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
	if (start >= size || end < start) return 'unsatisfiable';
	return { start, end };
}

export type ServeFileOptions = {
	contentType?: string;
	/** `immutable` for content-addressed artifacts; `revalidate` (no-cache + ETag) for originals. */
	cache: 'immutable' | 'revalidate' | 'none';
	/** Content-Disposition download name. */
	downloadName?: string;
	extraHeaders?: Record<string, string>;
};

function etagFor(size: number, mtimeMs: number): string {
	return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

function matchesEtag(header: string | undefined, etag: string): boolean {
	if (!header) return false;
	return header
		.split(',')
		.map((s) => s.trim().replace(/^W\//, ''))
		.some((t) => t === '*' || t === etag);
}

/** Streams a file (or part of it) honoring HEAD/Range/conditional headers. 404 when missing. */
export async function serveFile(
	req: FastifyRequest,
	reply: FastifyReply,
	file: string,
	opts: ServeFileOptions,
): Promise<FastifyReply> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(file);
		if (!info.isFile()) throw new Error('not a file');
	} catch {
		return reply.code(404).type('application/json').send(errorBody('NOT_FOUND', 'File not found'));
	}
	const size = info.size;
	const etag = etagFor(size, info.mtimeMs);
	const lastModified = new Date(info.mtimeMs).toUTCString();
	reply.header('accept-ranges', 'bytes');
	reply.header('etag', etag);
	reply.header('last-modified', lastModified);
	reply.header(
		'cache-control',
		opts.cache === 'immutable'
			? 'private, max-age=31536000, immutable'
			: opts.cache === 'revalidate'
				? 'private, no-cache'
				: 'no-store',
	);
	if (opts.downloadName) {
		reply.header(
			'content-disposition',
			`attachment; filename="${opts.downloadName.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`,
		);
	}
	for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) reply.header(k, v);
	const type = opts.contentType ?? contentTypeFor(file);

	// Conditional GET (RFC 9110 §13): If-None-Match wins over If-Modified-Since.
	const inm = req.headers['if-none-match'];
	if (inm !== undefined) {
		if (matchesEtag(inm, etag)) return reply.code(304).send();
	} else {
		const ims = req.headers['if-modified-since'];
		if (ims && !Number.isNaN(Date.parse(ims)) && Math.floor(info.mtimeMs / 1000) <= Date.parse(ims) / 1000)
			return reply.code(304).send();
	}

	let range = parseRange(req.headers.range, size);
	// If-Range: only honor the range while the representation is unchanged.
	const ifRangeRaw = req.headers['if-range'];
	const ifRange = Array.isArray(ifRangeRaw) ? ifRangeRaw[0] : ifRangeRaw;
	if (range && ifRange && ifRange.trim() !== etag && ifRange.trim() !== lastModified) range = null;

	if (range === 'unsatisfiable') {
		return reply
			.code(416)
			.header('content-range', `bytes */${size}`)
			.type('application/json')
			.send(errorBody('BAD_REQUEST', 'Range not satisfiable', { size }));
	}
	const head = req.method === 'HEAD';
	if (range) {
		const len = range.end - range.start + 1;
		reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`);
		reply.header('content-length', String(len)).type(type);
		if (head) return reply.send();
		return reply.send(createReadStream(file, { start: range.start, end: range.end }));
	}
	reply.code(200).header('content-length', String(size)).type(type);
	if (head) return reply.send();
	return reply.send(createReadStream(file));
}
