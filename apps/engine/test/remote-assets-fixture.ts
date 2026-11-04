// social-comment §7.8: a local HTTP server standing in for font / emoji CDNs (no real network in tests), fixture
// files (a real OFL font from node_modules, generated PNGs) and manifest builders.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);

/** A real woff2 (TikTok Sans 700, OFL-1.1) to download and verify. */
export const FONT_BYTES = readFileSync(
	join(
		dirname(require.resolve('@fontsource/tiktok-sans/metadata.json')),
		'files',
		'tiktok-sans-latin-700-normal.woff2',
	),
);
export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A solid-colour RGBA PNG of `w × h`. */
export function pngBytes(w: number, h: number, rgba: [number, number, number, number]): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(td) >>> 0);
		return Buffer.concat([len, td, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const row = Buffer.alloc(1 + w * 4);
	for (let x = 0; x < w; x++) row.set(rgba, 1 + x * 4);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

export type Route = {
	status?: number;
	body?: Buffer | string;
	contentType?: string;
	/** Never answer (timeouts). */
	hang?: boolean;
	/** Answer 503 this many times first (retries). */
	failTimes?: number;
	/** Declared content-length larger than the body (size cap on headers). */
	declaredLength?: number;
	/** Stream the body without declaring its length. */
	chunked?: boolean;
};

export class FixtureServer {
	readonly routes = new Map<string, Route>();
	readonly hits = new Map<string, number>();
	active = 0;
	maxActive = 0;
	private server: Server | null = null;
	private readonly sockets = new Set<import('node:net').Socket>();
	url = '';
	host = '';

	async start(): Promise<this> {
		this.server = createServer((req, res) => {
			const path = (req.url ?? '/').split('?')[0]!;
			this.hits.set(path, (this.hits.get(path) ?? 0) + 1);
			const r = this.routes.get(path);
			if (!r) {
				res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
				return;
			}
			this.active++;
			this.maxActive = Math.max(this.maxActive, this.active);
			const done = () => {
				this.active--;
			};
			if (r.hang) {
				res.on('close', done);
				return;
			}
			const answer = () => {
				if (r.failTimes && r.failTimes > 0) {
					r.failTimes--;
					res.writeHead(503).end('busy');
					done();
					return;
				}
				const body = typeof r.body === 'string' ? Buffer.from(r.body) : (r.body ?? Buffer.alloc(0));
				res.writeHead(r.status ?? 200, {
					'content-type': r.contentType ?? 'application/octet-stream',
					...(r.chunked ? {} : { 'content-length': String(r.declaredLength ?? body.length) }),
				});
				if (r.declaredLength) {
					res.flushHeaders();
					const socket = res.socket;
					res.end(body, () => socket?.end());
				} else res.end(body);
				done();
			};
			answer();
		});
		this.server.on('connection', (s) => {
			this.sockets.add(s);
			s.on('close', () => this.sockets.delete(s));
		});
		await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
		const port = (this.server.address() as AddressInfo).port;
		this.host = `127.0.0.1:${port}`;
		this.url = `http://${this.host}`;
		return this;
	}

	async close(): Promise<void> {
		for (const s of this.sockets) s.destroy();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
		this.server = null;
	}
}

/** A tiny JPEG header + payload (the magic number is all the content check reads). */
export const AVATAR_BYTES = Buffer.concat([
	Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
	Buffer.from('avatar-fixture'),
]);

/** A manifest with one font (TikTok-Sans bytes served as "Chirp" 700), one emoji pack and one image on `base`. */
export function fixtureManifest(
	base: string,
	o: { fe0f?: 'keep' | 'strip' | 'try-both'; version?: string } = {},
) {
	return {
		version: 1 as const,
		fonts: [
			{
				id: 'chirp-700',
				family: 'Chirp',
				weight: 700,
				style: 'normal' as const,
				format: 'woff2' as const,
				url: `${base}/fonts/chirp-700.woff2`,
				sha256: sha256(FONT_BYTES),
				licence: 'test fixture (OFL-1.1 bytes)',
				source: 'fixture server',
			},
		],
		emojiPacks: [
			{
				id: 'apple' as const,
				name: 'Apple',
				version: o.version ?? '1',
				urlTemplate: `${base}/emoji/{cp}.png`,
				fe0f: o.fe0f ?? 'try-both',
				format: 'png' as const,
				pixelSize: 16,
				licence: 'test fixture',
				attribution: null,
			},
		],
		images: [
			{
				id: 'x-default-avatar',
				url: `${base}/images/default_profile.jpg`,
				sha256: sha256(AVATAR_BYTES),
				format: 'jpeg' as const,
				licence: 'test fixture',
				width: 400,
				height: 400,
			},
		],
	};
}
