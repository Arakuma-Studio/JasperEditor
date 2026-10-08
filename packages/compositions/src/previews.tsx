// Render previews in the Program monitor (workstream `previews`, docs/wp-notes/previews.md). The editor hands the
// Player the preview files of the segments that have one (`RenderOptions.previews`, preview only); the composition
// then plays them in place of the live layers, in the same Player clock, so playback crosses between previews and
// live frames without a seam:
//
// - video: a full-frame, muted `<Video>` per preview span over everything (previews are the finished picture,
//   captions included). Live clips whose whole drawn span is covered by previews are not mounted at all (no decode);
//   clips that are only partly covered stay mounted under the opaque preview.
// - audio: a span plays its WAV (the finished mix) instead of the clips heard in it, but only where no live clip would
//   overlap it — a clip partly inside a rendered span keeps the whole span live (`usableAudioSpans`), so nothing plays
//   twice.
import type { RenderSnapshot } from '@jasper/project';
import { Audio, Video } from '@remotion/media';
import { useContext } from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { FlatDisplayContext } from './fx/flat.tsx';
import type { RenderOptions } from './types.ts';

/** A preview file shown over sequence frames [start, start + frames); `offset` = its first frame used (audio). */
export type PreviewSpan = { start: number; frames: number; url: string; offset?: number };
export type PreviewFiles = { video: PreviewSpan[]; audio: PreviewSpan[] };

type Range = { start: number; end: number };

/** Sorted, merged ranges of spans. */
function union(spans: readonly { start: number; frames: number }[]): Range[] {
	const r = spans
		.filter((s) => s.frames > 0)
		.map((s) => ({ start: s.start, end: s.start + s.frames }))
		.sort((a, b) => a.start - b.start);
	const out: Range[] = [];
	for (const x of r) {
		const last = out[out.length - 1];
		if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
		else out.push({ ...x });
	}
	return out;
}

const inside = (ranges: readonly Range[], a: number, b: number) =>
	ranges.some((r) => r.start <= a && b <= r.end);

/** Removes [a, b) from sorted ranges. */
function subtract(ranges: Range[], a: number, b: number): Range[] {
	const out: Range[] = [];
	for (const r of ranges) {
		if (b <= r.start || a >= r.end) out.push(r);
		else {
			if (r.start < a) out.push({ start: r.start, end: a });
			if (b < r.end) out.push({ start: b, end: r.end });
		}
	}
	return out;
}

/**
 * Where audio previews may replace the live mix: covered frames whose every heard clip lies entirely inside the
 * covered frames (fixpoint: a clip that must stay live takes the frames it plays out of the coverage).
 */
export function usableAudioSpans(
	clips: readonly { start: number; duration: number; headHandle?: number; tailHandle?: number }[],
	previews: readonly { start: number; frames: number }[],
): Range[] {
	let usable = union(previews);
	for (let pass = 0; pass < 64; pass++) {
		let changed = false;
		for (const c of clips) {
			const a = c.start - (c.headHandle ?? 0);
			const b = c.start + c.duration + (c.tailHandle ?? 0);
			if (inside(usable, a, b)) continue;
			const next = subtract(usable, a, b);
			if (
				next.length !== usable.length ||
				next.some((r, i) => r.start !== usable[i]!.start || r.end !== usable[i]!.end)
			) {
				usable = next;
				changed = true;
			}
		}
		if (!changed) break;
	}
	return usable;
}

/**
 * The document the live layers draw with previews applied (clips fully covered removed) and the preview spans to
 * play. Identity when there are no previews.
 */
export function applyPreviews(
	doc: RenderSnapshot,
	previews: PreviewFiles | undefined,
): { doc: RenderSnapshot; video: PreviewSpan[]; audio: PreviewSpan[] } {
	if (!previews || (previews.video.length === 0 && previews.audio.length === 0))
		return { doc, video: [], audio: [] };
	const cover = union(previews.video);
	const covered = (s: { start: number; end: number }) => cover.length > 0 && inside(cover, s.start, s.end);
	const videoTracks = cover.length
		? doc.videoTracks.map((t) => ({
				...t,
				clips: t.clips.filter(
					(c) =>
						!covered({
							start: c.start - (c.headHandle ?? 0),
							end: c.start + c.duration + (c.tailHandle ?? 0),
						}),
				),
				...(t.mattes
					? { mattes: t.mattes.filter((m) => !covered({ start: m.start, end: m.start + m.duration })) }
					: {}),
				...(t.transitions
					? {
							transitions: t.transitions.filter(
								(x) => !covered({ start: x.start, end: x.start + x.duration }),
							),
						}
					: {}),
			}))
		: doc.videoTracks;
	const usable = previews.audio.length ? usableAudioSpans(doc.audioClips, previews.audio) : [];
	const audioClips = usable.length
		? doc.audioClips.filter(
				(c) => !inside(usable, c.start - (c.headHandle ?? 0), c.start + c.duration + (c.tailHandle ?? 0)),
			)
		: doc.audioClips;
	// Each audio preview plays only its usable part (offset into its file accordingly).
	const audio: PreviewSpan[] = [];
	for (const p of previews.audio)
		for (const r of usable) {
			const a = Math.max(p.start, r.start);
			const b = Math.min(p.start + p.frames, r.end);
			if (b > a)
				audio.push({ start: a, frames: b - a, url: p.url, ...(a > p.start ? { offset: a - p.start } : {}) });
		}
	return {
		doc:
			videoTracks === doc.videoTracks && audioClips === doc.audioClips
				? doc
				: { ...doc, videoTracks, audioClips },
		video: previews.video.filter((p) => p.frames > 0),
		audio,
	};
}

const FILL = { width: '100%', height: '100%', display: 'block', objectFit: 'fill' } as const;

/** The preview spans of the Program monitor (see the module comment). */
export function PreviewLayers(props: {
	video: readonly PreviewSpan[];
	audio: readonly PreviewSpan[];
	offset: number;
	premount: number;
	options: RenderOptions;
}) {
	// compositor: when the display stage does not capture (a flat stack), preview files get the display transform here.
	const display = useContext(FlatDisplayContext);
	if (!props.options.isPreview) return null;
	return (
		<>
			{props.video.map((p) => (
				<Sequence
					key={`v:${p.url}:${p.start}`}
					from={p.start - props.offset}
					durationInFrames={p.frames}
					name="Render preview"
					premountFor={props.premount}
				>
					<AbsoluteFill data-render-preview={p.url}>
						<Video src={p.url} muted style={FILL} {...(display ? { effects: display } : {})} />
					</AbsoluteFill>
				</Sequence>
			))}
			{props.audio.map((p) => (
				<Sequence
					key={`a:${p.url}:${p.start}`}
					from={p.start - props.offset}
					durationInFrames={p.frames}
					name="Render preview (audio)"
					layout="none"
				>
					<Audio src={p.url} {...(p.offset ? { trimBefore: p.offset } : {})} />
				</Sequence>
			))}
		</>
	);
}
