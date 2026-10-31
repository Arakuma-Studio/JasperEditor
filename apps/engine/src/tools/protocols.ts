// FFmpeg may read local files only (spec 18 AF-SEC-001, the Media Browser's rule D-47): every input of a media
// file gets `-protocol_whitelist file,crypto,data` (`crypto` for AES-encrypted local HLS, `data` for data: URIs a
// playlist embeds), so a playlist or reference file that names http://, tcp://, rtmp://… is refused instead of
// fetched. Pipes from the engine get `pipe` only; lavfi sources open no protocol.
//
// The whitelist does not cover every demuxer: FFmpeg's DASH demuxer (6.1 and 7.1, libavformat/dashdec.c `open_url`)
// opens its http(s) segments with avio_open2 and ignores the context's whitelist (measured: a local .mpd whose
// BaseURL is http://127.0.0.1/… is fetched even with -protocol_whitelist file,crypto,data). Probes — which every file
// goes through before the engine uses it — therefore also get `-format_whitelist` with every demuxer of the binary
// except NETWORK_DEMUXERS; the whitelist is inherited by nested demuxers (a DASH manifest posing as an HLS segment
// is refused too). FFmpeg runs with many inputs do not get the demuxer list (2 KB per input would exceed Windows'
// 32 K command line), see docs/wp-notes/agent-footage-security.md.
//
// Pure (no Node imports): the jasper-proc, roto, speech and CLAP workers import it too.

/** The protocols a media file input may use. */
export const LOCAL_PROTOCOLS = ['-protocol_whitelist', 'file,crypto,data'] as const;
const PIPE_PROTOCOLS = ['-protocol_whitelist', 'pipe'] as const;

/**
 * Demuxers a probe never opens: `dash` fetches its segments itself (see above); `rtsp`, `rtp`, `sdp` and `sap` exist
 * only to open network sessions.
 */
export const NETWORK_DEMUXERS: readonly string[] = ['dash', 'rtsp', 'rtp', 'sdp', 'sap'];

/** The engine error code of a refused network reference (non-retryable). */
export const REMOTE_REFERENCE_BLOCKED = 'REMOTE_REFERENCE_BLOCKED';

const isPipe = (src: string) => src === '-' || src.startsWith('pipe:');

/**
 * An ffmpeg argument list with a protocol whitelist in front of every `-i` whose option group has none: the local
 * one for files, `pipe` for `pipe:N` / `-`; `-f lavfi` inputs are left alone. A whitelist the caller put in an
 * input's group is kept. Idempotent.
 */
export function restrictInputs(args: readonly string[]): string[] {
	const out: string[] = [];
	let groupStart = 0;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a !== '-i' || i + 1 >= args.length) {
			out.push(a);
			continue;
		}
		const src = args[i + 1]!;
		const group = out.slice(groupStart);
		const f = group.lastIndexOf('-f');
		const lavfi = f >= 0 && group[f + 1] === 'lavfi';
		if (!lavfi && !group.includes('-protocol_whitelist'))
			out.push(...(isPipe(src) ? PIPE_PROTOCOLS : LOCAL_PROTOCOLS));
		out.push('-i', src);
		i++;
		groupStart = out.length;
	}
	return out;
}

/**
 * An ffprobe argument list (one input) with the local protocol whitelist and, when given, the demuxer whitelist of
 * `probeFormatWhitelist` in front. A caller's own `-protocol_whitelist` / `-format_whitelist` is kept.
 */
export function restrictProbeArgs(args: readonly string[], formatWhitelist?: string | null): string[] {
	const f = args.indexOf('-f');
	const lavfi = f >= 0 && args[f + 1] === 'lavfi';
	const pre: string[] = [];
	if (!lavfi && !args.includes('-protocol_whitelist')) pre.push(...LOCAL_PROTOCOLS);
	if (formatWhitelist && !args.includes('-format_whitelist')) pre.push('-format_whitelist', formatWhitelist);
	return [...pre, ...args];
}

/**
 * Demuxer names of `ffmpeg|ffprobe -demuxers` (6.1: ` D  name  …`; 7.1: ` D   name  …`, ` D d name  …` for
 * devices). Names may hold commas (`mov,mp4,m4a,3gp,3g2,mj2`): they are matched per comma-separated token.
 */
export function parseDemuxers(listing: string): string[] {
	const names: string[] = [];
	let started = false;
	for (const line of listing.split('\n')) {
		if (!started) {
			if (/^\s*-{2,}\s*$/.test(line)) started = true;
			continue;
		}
		const m = /^ D[E ]?[d ]? (\S+)/.exec(line);
		if (m) names.push(m[1]!);
	}
	return names;
}

/** `-format_whitelist` for probes: every demuxer of the listing but NETWORK_DEMUXERS; null when none was listed. */
export function probeFormatWhitelist(listing: string): string | null {
	const keep = parseDemuxers(listing).filter((n) => !n.split(',').some((t) => NETWORK_DEMUXERS.includes(t)));
	return keep.length > 0 ? keep.join(',') : null;
}

/** What FFmpeg refused in `stderr`: a protocol outside the whitelist, or a demuxer outside the format whitelist. */
export function blockedReference(stderr: string): { kind: 'protocol' | 'format'; name: string } | null {
	const p = /Protocol '([^']+)' not on whitelist/.exec(stderr);
	if (p) return { kind: 'protocol', name: p[1]! };
	const f = /\[([\w,]+) @ [^\]]*\] Format not on whitelist/.exec(stderr);
	if (f) return { kind: 'format', name: f[1]! };
	return null;
}

/** The user-facing message of a refused reference. */
export function blockedReferenceMessage(b: { kind: 'protocol' | 'format'; name: string }): string {
	return b.kind === 'protocol'
		? `This media file refers to a ${b.name}:// resource; JasperEditor reads local files only`
		: `This media file is a ${b.name.toUpperCase()} stream description that loads its media from the network; JasperEditor reads local files only`;
}
