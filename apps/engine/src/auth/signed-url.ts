// Short-lived signed URLs (S04:MS-003, RR-003) for consumers that cannot send the session cookie: the
// headless browser of local Remotion renders. A signature covers exactly one path and an expiry.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULT_SIGNED_URL_TTL_SEC = 6 * 60 * 60;

/** Paths that may be signed (media, derivatives, fonts, renders). Everything else needs normal auth. */
const SIGNABLE = /^\/(media|fonts|renders|mg)\//;

export class UrlSigner {
	private readonly secret: Buffer;

	constructor(secret?: string | Buffer) {
		this.secret = secret ? Buffer.from(secret) : randomBytes(32);
	}

	private mac(path: string, exp: number): string {
		return createHmac('sha256', this.secret).update(`${path}\n${exp}`).digest('base64url');
	}

	/** Query string `sig=…&exp=…` for `path` (no query), valid for `ttlSec` seconds. */
	signQuery(path: string, ttlSec = DEFAULT_SIGNED_URL_TTL_SEC, nowMs = Date.now()): string {
		const exp = Math.floor(nowMs / 1000) + Math.max(1, Math.floor(ttlSec));
		return `sig=${this.mac(path, exp)}&exp=${exp}`;
	}

	/** Absolute signed URL on `origin` (e.g. `http://127.0.0.1:47900`). */
	signUrl(origin: string, path: string, ttlSec?: number): string {
		const sep = path.includes('?') ? '&' : '?';
		const bare = path.split('?')[0]!;
		return `${origin}${path}${sep}${this.signQuery(bare, ttlSec)}`;
	}

	/** Verifies a request URL (path + query). The path must be signable, the signature valid and fresh. */
	verify(url: string, nowMs = Date.now()): boolean {
		const q = url.indexOf('?');
		if (q < 0) return false;
		const path = url.slice(0, q);
		if (!SIGNABLE.test(path)) return false;
		const params = new URLSearchParams(url.slice(q + 1));
		const sig = params.get('sig');
		const exp = Number(params.get('exp'));
		if (!sig || !Number.isInteger(exp) || exp * 1000 < nowMs) return false;
		const expected = Buffer.from(this.mac(path, exp));
		const given = Buffer.from(sig);
		return expected.length === given.length && timingSafeEqual(expected, given);
	}
}
