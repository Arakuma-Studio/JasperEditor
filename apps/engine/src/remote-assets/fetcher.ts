// HTTP downloads of remote assets: per-host concurrency, a timeout per attempt, a size cap enforced while reading,
// bounded retries (network errors, timeouts, 5xx, 429) and content checks. Errors are `RemoteAssetError`s
// (`{code, message, detail?, retryable}`, AGENTS §0).

export class RemoteAssetError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable: boolean,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = 'RemoteAssetError';
	}

	toJSON(): { code: string; message: string; detail?: unknown; retryable: boolean } {
		return {
			code: this.code,
			message: this.message,
			...(this.detail !== undefined ? { detail: this.detail } : {}),
			retryable: this.retryable,
		};
	}
}

/** Any thrown value as a RemoteAssetError (unexpected failures are retryable internal errors). */
export function asRemoteAssetError(e: unknown): RemoteAssetError {
	if (e instanceof RemoteAssetError) return e;
	return new RemoteAssetError('REMOTE_ASSET_FAILED', (e as Error)?.message ?? String(e), true);
}

export type FetchLimits = {
	/** Per attempt, connection to last byte. */
	timeoutMs: number;
	/** Bytes; a longer body is refused while it is read. */
	maxBytes: number;
	/** Extra attempts after a retryable failure. */
	retries: number;
	/** First retry delay; doubles per attempt. */
	backoffMs: number;
};

/** A counting semaphore per host: at most `limit` downloads from one host at a time. */
export class HostLimiter {
	private readonly active = new Map<string, number>();
	private readonly waiting = new Map<string, (() => void)[]>();
	constructor(private readonly limit: number) {}

	async run<T>(host: string, fn: () => Promise<T>): Promise<T> {
		if ((this.active.get(host) ?? 0) >= this.limit)
			await new Promise<void>((resolve) => {
				const q = this.waiting.get(host) ?? [];
				q.push(resolve);
				this.waiting.set(host, q);
			});
		this.active.set(host, (this.active.get(host) ?? 0) + 1);
		try {
			return await fn();
		} finally {
			const n = (this.active.get(host) ?? 1) - 1;
			if (n > 0) this.active.set(host, n);
			else this.active.delete(host);
			const q = this.waiting.get(host);
			const next = q?.shift();
			if (q && q.length === 0) this.waiting.delete(host);
			next?.();
		}
	}
}

export type Fetched = { bytes: Buffer; contentType: string; url: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
	const declared = Number(res.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new RemoteAssetError('DOWNLOAD_TOO_LARGE', `${url} is larger than ${maxBytes} bytes`, false, {
			url,
			bytes: declared,
		});
	if (!res.body) return Buffer.alloc(0);
	const chunks: Buffer[] = [];
	let total = 0;
	const reader = res.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new RemoteAssetError('DOWNLOAD_TOO_LARGE', `${url} is larger than ${maxBytes} bytes`, false, {
				url,
			});
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks, total);
}

async function attempt(url: string, limits: FetchLimits, fetchImpl: typeof fetch): Promise<Fetched> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), limits.timeoutMs);
	try {
		let res: Response;
		try {
			res = await fetchImpl(url, { redirect: 'follow', signal: ac.signal, headers: { accept: '*/*' } });
		} catch (e) {
			if (ac.signal.aborted)
				throw new RemoteAssetError(
					'DOWNLOAD_TIMEOUT',
					`${url} did not answer within ${limits.timeoutMs} ms`,
					true,
					{
						url,
					},
				);
			throw new RemoteAssetError(
				'DOWNLOAD_FAILED',
				`${url} could not be reached (${(e as Error).message})`,
				true,
				{
					url,
				},
			);
		}
		if (!res.ok) {
			await res.body?.cancel().catch(() => undefined);
			const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
			throw new RemoteAssetError(
				res.status === 404 || res.status === 410 ? 'DOWNLOAD_NOT_FOUND' : 'DOWNLOAD_FAILED',
				`${url} answered HTTP ${res.status}`,
				retryable,
				{ url, status: res.status },
			);
		}
		const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
		try {
			const bytes = await readCapped(res, limits.maxBytes, url);
			return { bytes, contentType, url: res.url || url };
		} catch (e) {
			if (e instanceof RemoteAssetError) throw e;
			if (ac.signal.aborted)
				throw new RemoteAssetError(
					'DOWNLOAD_TIMEOUT',
					`${url} did not finish within ${limits.timeoutMs} ms`,
					true,
					{
						url,
					},
				);
			throw new RemoteAssetError('DOWNLOAD_FAILED', `${url} broke off (${(e as Error).message})`, true, {
				url,
			});
		}
	} finally {
		clearTimeout(timer);
	}
}

/** Downloads `url` within `limits` through the host limiter, retrying retryable failures. */
export async function fetchCapped(
	url: string,
	o: { limits: FetchLimits; hosts: HostLimiter; fetchImpl?: typeof fetch },
): Promise<Fetched> {
	const host = new URL(url).host;
	let last: RemoteAssetError | null = null;
	for (let i = 0; i <= o.limits.retries; i++) {
		if (i > 0) await sleep(o.limits.backoffMs * 2 ** (i - 1));
		try {
			return await o.hosts.run(host, () => attempt(url, o.limits, o.fetchImpl ?? fetch));
		} catch (e) {
			last = e instanceof RemoteAssetError ? e : asRemoteAssetError(e);
			if (!last.retryable) throw last;
		}
	}
	throw last!;
}

const MAGIC: Record<'woff2' | 'woff' | 'otf', string> = { woff2: 'wOF2', woff: 'wOFF', otf: 'OTTO' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** HTML (an error or login page) is never a font or image, whatever the status said. */
function looksLikeHtml(f: Fetched): boolean {
	if (f.contentType === 'text/html' || f.contentType === 'application/xhtml+xml') return true;
	const head = f.bytes.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
	return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/** Refuses a body that is not a font file of `format` (magic number). */
export function checkFont(f: Fetched, format: 'woff2' | 'woff' | 'ttf' | 'otf'): void {
	const bad = (why: string) =>
		new RemoteAssetError('ASSET_BAD_CONTENT', `${f.url} is not a ${format} font (${why})`, false, {
			url: f.url,
			contentType: f.contentType,
		});
	if (looksLikeHtml(f)) throw bad('HTML page');
	const magic = f.bytes.subarray(0, 4);
	if (format === 'ttf') {
		const ok = magic.equals(Buffer.from([0, 1, 0, 0])) || magic.toString('latin1') === 'true';
		if (!ok) throw bad('bad magic number');
	} else if (magic.toString('latin1') !== MAGIC[format]) throw bad('bad magic number');
}

/**
 * SVG markup that could run code or load other resources (the engine serves these files from its own origin; they
 * are also served with `REMOTE_IMAGE_CSP`): script / foreignObject / handler / iframe / embed / object elements (any
 * namespace prefix), event-handler attributes (also after `/`: `<svg/onload=…>`), `href` / `xlink:href` / `src`
 * that are not same-document (`#id`), `url(…)` that is not `url(#id)`, `@import`, external stylesheets
 * (`<?xml-stylesheet`) and entity declarations. Matched on the markup with character references decoded.
 */
const SVG_ACTIVE =
	/<([a-z][\w.-]*:)?(script|foreignobject|handler|listener|iframe|embed|object)\b|[\s/"']on[a-z]+\s*=|(^|[\s/"'])((xlink:)?href|src)\s*=(?!\s*["']?\s*#)|url\((?!\s*["']?\s*#)|@import|<\?xml-stylesheet|<!entity/i;
/** Script URL schemes, matched with whitespace and control characters removed (`java&#9;script:`). */
const SVG_SCRIPT_SCHEME = /(java|vb|live)script:/i;

/** XML / HTML named character references an attacker could use to spell `javascript:` or an attribute. */
const NAMED_REFS: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	colon: ':',
	sol: '/',
	lpar: '(',
	rpar: ')',
	tab: '\t',
	newline: '\n',
	nbsp: ' ',
	period: '.',
	equals: '=',
	num: '#',
	bsol: '\\',
};

/** `text` with character references decoded: numeric (with or without `;`) and the named ones above, twice (`&amp;#106;`). */
function decodeCharRefs(text: string): string {
	let out = text;
	for (let i = 0; i < 2; i++)
		out = out.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ref: string) => {
			const r = ref.toLowerCase();
			if (!r.startsWith('#')) return NAMED_REFS[r] ?? m;
			const cp = r[1] === 'x' ? Number.parseInt(r.slice(2), 16) : Number.parseInt(r.slice(1), 10);
			return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
		});
	return out;
}

/** True when SVG markup holds active content or external references (see `SVG_ACTIVE`). Never throws. */
export function svgHasActiveContent(text: string): boolean {
	const decoded = decodeCharRefs(text);
	if (SVG_ACTIVE.test(decoded)) return true;
	// a browser ignores whitespace and control characters inside a URL scheme
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
	const compact = decoded.replace(/[\s\u0000-\u001f\u007f-\u009f\u200b-\u200d\ufeff]+/g, '');
	return SVG_SCRIPT_SCHEME.test(compact);
}

/**
 * Content-Security-Policy of every remote image / emoji file the engine serves (SVG ones especially): no scripts
 * (sandbox), nothing loaded but inline styles and `data:` pictures.
 */
export const REMOTE_IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** Refuses a body that is not an image of `format` (magic number / root element; active SVG content). */
export function checkImage(f: Fetched, format: 'png' | 'jpeg' | 'webp' | 'svg'): void {
	const bad = (why: string) =>
		new RemoteAssetError('ASSET_BAD_CONTENT', `${f.url} is not a ${format} image (${why})`, false, {
			url: f.url,
			contentType: f.contentType,
		});
	if (looksLikeHtml(f)) throw bad('HTML page');
	if (format !== 'svg') {
		const b = f.bytes;
		const ok =
			format === 'png'
				? b.subarray(0, 8).equals(PNG)
				: format === 'jpeg'
					? b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
					: b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
		if (!ok) throw bad('bad magic number');
		if (
			f.contentType &&
			!new RegExp(
				`^(image/${format === 'jpeg' ? 'p?jpe?g' : format}|application/octet-stream|binary/octet-stream)$`,
			).test(f.contentType)
		)
			throw bad(`content type ${f.contentType}`);
		return;
	}
	const text = f.bytes.toString('utf8');
	const body = text
		.replace(/^﻿/, '')
		.replace(/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype[^>]*>\s*)?/i, '');
	if (!/^<svg[\s>]/i.test(body)) throw bad('no <svg> root');
	if (svgHasActiveContent(text)) throw bad('scripts or external references');
}
