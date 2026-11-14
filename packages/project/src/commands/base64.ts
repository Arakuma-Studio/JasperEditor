// Base64 for command payloads (voice analyses of `transcript.removePauses`, cut levels): the model is DOM- and
// Node-free, so no atob / btoa / Buffer. Pure.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i] as const));

/** Bytes of a base64 string (whitespace ignored); null when it is not base64. */
export function base64Bytes(b64: string): Uint8Array | null {
	const clean = b64.replace(/\s+/g, '');
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.replace(/=+$/, '').length % 4 === 1) return null;
	const body = clean.replace(/=+$/, '');
	const out = new Uint8Array(Math.floor((body.length * 3) / 4));
	let buf = 0;
	let bits = 0;
	let n = 0;
	for (const ch of body) {
		buf = ((buf << 6) | B64_INDEX.get(ch)!) & 0xffffff;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[n++] = (buf >> bits) & 0xff;
		}
	}
	return out.subarray(0, n);
}

/** Base64 of bytes (the model is DOM- and Node-free: no btoa / Buffer). */
export function bytesBase64(u: Uint8Array): string {
	let s = '';
	for (let i = 0; i < u.length; i += 3) {
		const n = (u[i]! << 16) | ((u[i + 1] ?? 0) << 8) | (u[i + 2] ?? 0);
		s += B64[n >> 18]! + B64[(n >> 12) & 63]!;
		s += i + 1 < u.length ? B64[(n >> 6) & 63]! : '=';
		s += i + 2 < u.length ? B64[n & 63]! : '=';
	}
	return s;
}
