// The sync strip of a Sound Check sync finding (spec 12 §2.7 "Sync rows expand into a strip of 5 frames plus the
// waveform"; wp-note "Phase 5 → WP5.2"): the picture at the cue frame and two frames either side (engine stills of
// the committed sequence, the Program's own render), above the mix waveform around the cue (the engine's visual data,
// `POST /api/sound-design/visual`, 10 ms peaks — the same data the MCP pictures draw), with a solid line at the picture
// event (the cue frame) and a dashed line where the sound's aligned point was measured (cue + the report's offset).
// Ticks under the frames show where each thumbnail sits in time. Drawn as SVG with design tokens (high contrast
// follows the theme); the lines are told apart by dash and label, not colour alone. Nothing animates.
import type { EngineJob, SoundCheckEvent, SoundCheckIssue, SoundVisualResponse } from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { type Sequence, sequenceDuration } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useEffect, useMemo, useRef, useState } from 'react';
import { exportEnvelope } from '../export/settings.ts';
import { t } from '../i18n/runtime.ts';
import { issueFrame } from './check-model.ts';
import { seqTimecode } from './design-model.ts';

export type StripEngine = Pick<EngineClient, 'requestStill' | 'getJob' | 'soundVisual' | 'url'>;

/** Frames either side of the cue in the strip (5 thumbnails). */
export const STRIP_FRAMES = [-2, -1, 0, 1, 2] as const;
/** Seconds of waveform either side of the cue (covers the ±3-frame sync search at 23.976 fps and more). */
export const STRIP_WAVE_SEC = 0.3;
const THUMB_W = 112;
/** The strip's width before it is measured (px). */
const STRIP_DEFAULT_W = 5 * THUMB_W + 16;
const WAVE_H = 56;
const FLOOR_DB = -60;
const STILL_TIMEOUT_MS = 60_000;

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
/** Stills by revision, sequence and frame (bounded; a new revision renders again). */
const stills = new Map<string, Promise<string | null>>();
const STILL_CACHE = 120;

async function stillUrl(
	engine: StripEngine,
	session: EditorSession,
	sequenceId: string,
	frame: number,
	signal: AbortSignal,
): Promise<string | null> {
	const key = `${session.projectId}:${session.revision}:${sequenceId}:${frame}`;
	const had = stills.get(key);
	if (had) return had;
	const p = (async () => {
		let job = (await engine.requestStill({
			envelope: exportEnvelope(session.getCommitted(), session.revision) as never,
			sequenceId,
			frame,
			width: THUMB_W * 2,
			format: 'jpeg',
		})) as EngineJob;
		const until = Date.now() + STILL_TIMEOUT_MS;
		while (!TERMINAL.has(job.state)) {
			if (signal.aborted || Date.now() > until) return null;
			await new Promise((r) => setTimeout(r, 250));
			job = (await engine.getJob(job.id)) as EngineJob;
		}
		const url = (job.result as { url?: unknown } | undefined)?.url;
		return job.state === 'succeeded' && typeof url === 'string' ? engine.url(url) : null;
	})().catch(() => null);
	stills.set(key, p);
	if (stills.size > STILL_CACHE) stills.delete(stills.keys().next().value as string);
	// a failed or abandoned render is tried again next time
	void p.then((u) => {
		if (u === null) stills.delete(key);
	});
	return p;
}

/** The waveform path (a filled envelope of the 10 ms peaks, mirrored) over `w` × `h`. */
export function wavePath(peaksDb: readonly number[], w: number, h: number): string {
	if (!peaksDb.length || w <= 0 || h <= 0) return '';
	const mid = h / 2;
	const n = peaksDb.length;
	const amp = (db: number) => {
		const v = Number.isFinite(db) ? Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB)) : 0;
		return Math.max(0.5, v * (mid - 1));
	};
	const xs = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
	const top = peaksDb.map((db, i) => `${xs(i).toFixed(1)},${(mid - amp(db)).toFixed(1)}`);
	const bottom = peaksDb.map((db, i) => `${xs(i).toFixed(1)},${(mid + amp(db)).toFixed(1)}`).reverse();
	return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}

export type StripGeometry = {
	/** Sequence frames of the waveform range [start, end). */
	range: { start: number; end: number };
	frames: number[];
	/** x (0…1) of the picture event, the measured aligned point (null: not measured) and each thumbnail's frame. */
	eventX: number;
	measuredX: number | null;
	frameX: number[];
};

/** Where things sit in the strip (pure; tested). */
export function stripGeometry(
	seq: Pick<Sequence, 'settings'> & { clips?: unknown },
	cueFrame: number,
	offsetMs: number | null,
	durationFrames: number,
): StripGeometry {
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den || 30;
	const pad = Math.max(3, Math.round(STRIP_WAVE_SEC * fps));
	const last = Math.max(1, durationFrames);
	const start = Math.max(0, cueFrame - pad);
	const end = Math.max(start + 1, Math.min(last, cueFrame + pad + 1));
	const span = end - start;
	const x = (f: number) => Math.max(0, Math.min(1, (f - start) / span));
	const frames = STRIP_FRAMES.map((d) => cueFrame + d).filter((f) => f >= 0 && f < last);
	return {
		range: { start, end },
		frames,
		// a frame is drawn at its start: the picture changes there
		eventX: x(cueFrame),
		measuredX: offsetMs === null || !Number.isFinite(offsetMs) ? null : x(cueFrame + (offsetMs / 1000) * fps),
		frameX: frames.map((f) => x(f + 0.5)),
	};
}

export function SyncStrip(props: {
	session: EditorSession;
	engine: StripEngine | null;
	sequenceId: string;
	issue: SoundCheckIssue;
	event: SoundCheckEvent | null;
	checkJobId: string | null;
}) {
	const { session, engine, sequenceId, issue, event } = props;
	const seq = session.getCommitted().sequences[sequenceId] as Sequence | undefined;
	const cueFrame = issueFrame(issue) ?? 0;
	const offsetMs =
		event?.offsetMs ?? (typeof issue.measured?.offsetMs === 'number' ? issue.measured.offsetMs : null);
	const duration = seq ? Math.ceil(sequenceDuration(seq)) : 0;
	const geo = useMemo(
		() => (seq ? stripGeometry(seq, cueFrame, offsetMs, duration) : null),
		[seq, cueFrame, offsetMs, duration],
	);
	const [thumbs, setThumbs] = useState<Record<number, string | null | 'loading'>>({});
	const [visual, setVisual] = useState<SoundVisualResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const frameKey = geo?.frames.join(',') ?? '';
	// the strip takes the width the panel gives it (measured; 5 thumbnails share it)
	const boxRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(STRIP_DEFAULT_W);
	useEffect(() => {
		const el = boxRef.current;
		if (!el) return;
		const measure = () => {
			const w = Math.floor(el.clientWidth);
			if (w > 0) setWidth((old) => (old === w ? old : w));
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the frames and the job identify what to fetch
	useEffect(() => {
		if (!engine || !geo || !seq) return;
		const ac = new AbortController();
		setError(null);
		setThumbs(Object.fromEntries(geo.frames.map((f) => [f, 'loading' as const])));
		void (async () => {
			try {
				const v = (await engine.soundVisual(
					{
						projectId: session.projectId,
						sequenceId,
						range: geo.range,
						...(props.checkJobId ? { checkJobId: props.checkJobId } : {}),
					},
					ac.signal,
				)) as SoundVisualResponse;
				if (!ac.signal.aborted) setVisual(v);
			} catch (e) {
				if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
			}
			// one still at a time: the engine renders them in the order the strip shows them
			for (const f of geo.frames) {
				if (ac.signal.aborted) return;
				const url = await stillUrl(engine, session, sequenceId, f, ac.signal);
				if (!ac.signal.aborted) setThumbs((m) => ({ ...m, [f]: url }));
			}
		})();
		return () => ac.abort();
	}, [engine, session, sequenceId, frameKey, props.checkJobId]);

	if (!seq || !geo) return null;
	const tcAt = (f: number) => seqTimecode(seq, f);
	const fps = seq.settings.frameRate.num / seq.settings.frameRate.den || 30;
	const offsetFrames = offsetMs === null ? null : (offsetMs / 1000) * fps;
	const summary =
		offsetMs === null
			? t('Picture event at {0}; the sound was not measured there', tcAt(cueFrame))
			: t(
					'Picture event at {0}; sound measured {1} ms {2} ({3} frames)',
					tcAt(cueFrame),
					Math.abs(offsetMs).toFixed(1),
					offsetMs >= 0 ? t('late') : t('early'),
					Math.abs(offsetFrames!).toFixed(1),
				);
	const path = visual ? wavePath(visual.waveformPeakDb, width, WAVE_H) : '';
	return (
		<div
			className="mt-1 flex flex-col gap-1 rounded-pr-control bg-pr-field-deep p-2"
			data-testid="sound-check-sync-strip"
			data-cue-frame={cueFrame}
		>
			<div ref={boxRef} className="grid w-full grid-cols-5 gap-1">
				{geo.frames.map((f) => {
					const th = thumbs[f];
					const d = f - cueFrame;
					return (
						<figure key={f} className="m-0 flex min-w-0 flex-col items-center gap-0.5">
							<div
								className={`flex aspect-video w-full items-center justify-center overflow-hidden rounded-pr-control border bg-pr-panel ${d === 0 ? 'border-pr-text' : 'border-pr-border-subtle'}`}
							>
								{th && th !== 'loading' ? (
									<img
										src={th}
										alt={t('Frame {0}', tcAt(f))}
										className="h-full w-full object-cover"
										data-testid="sound-check-thumb"
									/>
								) : (
									<span className="text-pr-small text-pr-dim">
										{th === 'loading' ? t('Rendering…') : t('No picture')}
									</span>
								)}
							</div>
							<figcaption className="font-pr-mono text-pr-small text-pr-muted">
								{d === 0 ? t('cue') : d > 0 ? `+${d}` : `−${-d}`}
							</figcaption>
						</figure>
					);
				})}
			</div>
			<svg
				role="img"
				aria-label={summary}
				width={width}
				height={WAVE_H + 14}
				className="block"
				data-testid="sound-check-wave"
			>
				<rect x={0} y={0} width={width} height={WAVE_H} fill="var(--pr-bg-panel)" />
				{path ? <path d={path} fill="var(--pr-text-secondary)" data-testid="sound-check-wave-path" /> : null}
				{geo.frameX.map((x, i) => (
					<line
						key={geo.frames[i]}
						x1={x * width}
						x2={x * width}
						y1={WAVE_H}
						y2={WAVE_H + 4}
						stroke="var(--pr-text-tertiary)"
					/>
				))}
				<line
					x1={geo.eventX * width}
					x2={geo.eventX * width}
					y1={0}
					y2={WAVE_H}
					stroke="var(--pr-cue-hero)"
					strokeWidth={2}
					data-testid="sound-check-event-line"
				/>
				<text x={geo.eventX * width + 3} y={WAVE_H + 12} fontSize={10} fill="var(--pr-text-primary)">
					{t('Picture')}
				</text>
				{geo.measuredX !== null ? (
					<>
						<line
							x1={geo.measuredX * width}
							x2={geo.measuredX * width}
							y1={0}
							y2={WAVE_H}
							stroke="var(--pr-warning)"
							strokeWidth={2}
							strokeDasharray="4 3"
							data-testid="sound-check-peak-line"
						/>
						<text
							x={geo.measuredX * width + (geo.measuredX * width > width - 90 ? -3 : 3)}
							textAnchor={geo.measuredX * width > width - 90 ? 'end' : 'start'}
							y={10}
							fontSize={10}
							fill="var(--pr-text-primary)"
						>
							{t('Sound {0} ms', `${offsetMs! >= 0 ? '+' : '−'}${Math.abs(offsetMs!).toFixed(1)}`)}
						</text>
					</>
				) : null}
			</svg>
			<p className="m-0 text-pr-small text-pr-muted">{error ? t('No waveform: {0}', error) : summary}</p>
		</div>
	);
}
