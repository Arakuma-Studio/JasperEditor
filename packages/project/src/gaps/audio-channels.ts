// Clip ▸ Modify ▸ Audio Channels (docs/wp-notes/gaps.md §AU-7). Premiere's dialog: the Clip Channel
// Format (Mono, Stereo, 5.1), the Number of Audio Clips and the matrix routing each media source channel to a channel
// of one of the clips (or to none). In the model an audio clip reads one audio stream (`channels.streamIndex`) and its
// output channel i plays source channel `channels.map[i]` of that stream, or silence when i is in `channels.mute`
// (a clip channel no source channel is routed to). Media items carry the routing for future placements
// (`MediaItem.audioChannels`); timeline clips carry their own. The offline mixer (export, analysis) and the preview
// both decode through it.
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset, MediaStream } from '../schema/media.ts';
import { registerGapsCheck } from './settings.ts';

export type ClipChannels = { streamIndex: number; map: number[]; mute?: number[] };
export const CLIP_CHANNEL_FORMATS = { mono: 1, stereo: 2, '5.1': 6 } as const;
export type ClipChannelFormat = keyof typeof CLIP_CHANNEL_FORMATS;

const CH51 = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];

/** A clip channel's name (Premiere's matrix headers). */
export function clipChannelName(count: number, i: number): string {
	if (count === 6) return CH51[i] ?? `Ch ${i + 1}`;
	if (count === 2) return i === 0 ? 'L' : 'R';
	return 'Mono';
}

export function formatOfCount(n: number): ClipChannelFormat {
	return n === 6 ? '5.1' : n === 1 ? 'mono' : 'stereo';
}

/** The audio streams of a media and their channels (the rows of the matrix). */
export function sourceChannels(
	asset: Pick<MediaAsset, 'probe'>,
): { streamIndex: number; channel: number; label: string }[] {
	const streams = asset.probe.streams.filter(
		(s): s is Extract<MediaStream, { type: 'audio' }> => s.type === 'audio',
	);
	const out: { streamIndex: number; channel: number; label: string }[] = [];
	streams.forEach((s, k) => {
		for (let c = 0; c < Math.min(64, s.channels); c++)
			out.push({
				streamIndex: s.index,
				channel: c,
				label: `${streams.length > 1 ? `Stream ${k + 1} · ` : ''}Channel ${c + 1}`,
			});
	});
	return out;
}

/** Why a routing does not fit the media (null = it does). */
export function channelsProblem(
	asset: Pick<MediaAsset, 'probe'> | undefined,
	ch: ClipChannels,
	opts: { format?: boolean } = { format: true },
): string | null {
	if (!asset) return 'the media is missing';
	const s = asset.probe.streams.find((x) => x.type === 'audio' && x.index === ch.streamIndex);
	if (s?.type !== 'audio') return `stream ${ch.streamIndex} is not an audio stream of the media`;
	const n = ch.map.length;
	if (opts.format !== false && n !== 1 && n !== 2 && n !== 6)
		return 'a clip has 1 (mono), 2 (stereo) or 6 (5.1) channels';
	if (ch.map.some((m) => !Number.isInteger(m) || m < 0 || m >= s.channels))
		return `the stream has ${s.channels} channel${s.channels === 1 ? '' : 's'}`;
	if (ch.mute?.some((m) => !Number.isInteger(m) || m < 0 || m >= n))
		return 'a muted channel is outside the clip';
	return null;
}

/**
 * Builds the clips of a matrix: `assign[row]` = [clip, channel] or null for each source channel (row order of
 * `sourceChannels`). Every clip has `format` channels; clip channels no row is routed to are muted; a clip takes its
 * channels from one stream. Returns the routing or the first problem.
 */
export function routingFromMatrix(
	asset: Pick<MediaAsset, 'probe'>,
	format: ClipChannelFormat,
	clips: number,
	assign: readonly ([number, number] | null)[],
): { clips: ClipChannels[] } | { error: string } {
	const rows = sourceChannels(asset);
	const n = CLIP_CHANNEL_FORMATS[format];
	const out: { stream: number | null; map: (number | null)[] }[] = Array.from({ length: clips }, () => ({
		stream: null,
		map: Array.from({ length: n }, () => null),
	}));
	for (let r = 0; r < rows.length; r++) {
		const a = assign[r];
		if (!a) continue;
		const [k, c] = a;
		const clip = out[k];
		if (!clip || c < 0 || c >= n) return { error: `Source channel ${r + 1} points outside the clips` };
		if (clip.map[c] !== null)
			return { error: `Clip ${k + 1} ${clipChannelName(n, c)} already has a source channel` };
		if (clip.stream !== null && clip.stream !== rows[r]!.streamIndex)
			return { error: `Clip ${k + 1} takes channels from two streams: route each stream to its own clips` };
		clip.stream = rows[r]!.streamIndex;
		clip.map[c] = rows[r]!.channel;
	}
	const first = rows[0];
	if (!first) return { error: 'The media has no audio' };
	return {
		clips: out.map((o) => {
			const stream = o.stream ?? first.streamIndex;
			const mute = o.map.flatMap((m, i) => (m === null ? [i] : []));
			return { streamIndex: stream, map: o.map.map((m) => m ?? 0), ...(mute.length ? { mute } : {}) };
		}),
	};
}

/** The matrix of a routing (inverse of `routingFromMatrix`). */
export function matrixOfRouting(
	asset: Pick<MediaAsset, 'probe'>,
	clips: readonly ClipChannels[],
): ([number, number] | null)[] {
	const rows = sourceChannels(asset);
	return rows.map((r) => {
		for (let k = 0; k < clips.length; k++) {
			const cl = clips[k]!;
			if (cl.streamIndex !== r.streamIndex) continue;
			const i = cl.map.findIndex((m, idx) => m === r.channel && !cl.mute?.includes(idx));
			if (i >= 0) return [k, i];
		}
		return null;
	});
}

function clipChannelIssues(
	doc: Pick<ProjectDocument, 'media' | 'sequences'>,
): { invariant: string; message: string; path: string[] }[] {
	const out: { invariant: string; message: string; path: string[] }[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips)) {
			if (c.kind !== 'audio') continue;
			const ch = (c as { channels: ClipChannels; mediaId: string }).channels;
			const why = channelsProblem(doc.media[(c as { mediaId: string }).mediaId], ch, { format: false });
			// Only routings that would fail to decode are invalid (a map into a missing stream / channel).
			if (why && doc.media[(c as { mediaId: string }).mediaId])
				out.push({
					invariant: 'INV-CHANNELS',
					message: `clip ${c.id}: ${why}`,
					path: ['sequences', seq.id, 'clips', c.id, 'channels'],
				});
		}
	return out;
}

registerGapsCheck({
	clipIssues: clipChannelIssues,
	issues(doc) {
		const out = clipChannelIssues(doc);
		for (const it of Object.values(doc.items)) {
			const ac = (it as { audioChannels?: { clips?: ClipChannels[] } }).audioChannels;
			if (ac === undefined || it.kind !== 'media') continue;
			const asset = doc.media[it.mediaId];
			const bad =
				!Array.isArray(ac.clips) ||
				ac.clips.length < 1 ||
				ac.clips.length > 32 ||
				ac.clips.some((x) => !!channelsProblem(asset, x));
			if (bad)
				out.push({
					invariant: 'INV-CHANNELS',
					message: `item ${it.id}: invalid audio channel routing`,
					path: ['items', it.id, 'audioChannels'],
				});
		}
		return out;
	},
	repair(doc, note) {
		for (const seq of Object.values(doc.sequences))
			for (const c of Object.values(seq.clips)) {
				if (c.kind !== 'audio') continue;
				const r = c as unknown as { channels: ClipChannels; mediaId: string };
				const asset = doc.media[r.mediaId];
				if (!asset || !channelsProblem(asset, r.channels, { format: false })) continue;
				const s = asset.probe.streams.find((x) => x.type === 'audio');
				if (s?.type !== 'audio') continue;
				r.channels = { streamIndex: s.index, map: s.channels >= 2 ? [0, 1] : [0] };
				note('reset-channels', c.id, 'audio channel routing outside the media: reset to its first channels');
			}
		for (const it of Object.values(doc.items)) {
			const r = it as { audioChannels?: { clips?: ClipChannels[] } };
			if (r.audioChannels === undefined || it.kind !== 'media') continue;
			const asset = doc.media[it.mediaId];
			const ac = r.audioChannels;
			if (
				!Array.isArray(ac.clips) ||
				ac.clips.length < 1 ||
				ac.clips.length > 32 ||
				ac.clips.some((x) => !!channelsProblem(asset, x))
			) {
				delete r.audioChannels;
				note('reset-channels', it.id, 'invalid audio channel routing of the item removed');
			}
		}
	},
});
