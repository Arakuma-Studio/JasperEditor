import type { PreviewSettings } from '@jasper/api';
import {
	audioPreviewSegments,
	type ProjectDocument,
	previewSettingsOf,
	type RenderAudioPreviewSegment,
	type RenderPreviewSegment,
} from '@jasper/project';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
	cachedSegments,
	playbackSpans,
	type RenderSegment,
	renderBarSpans,
	segmentsOf,
} from '../panels/timeline/model/renderbar.ts';
import { useEngineOrNull } from '../state/engine.tsx';
import { previewStatusStore } from './store.ts';

/** Keeps the shared status store connected to this window's engine and its events. */
export function usePreviewEngine(): void {
	const engine = useEngineOrNull();
	const client = engine?.status === 'connected' ? engine.client : null;
	useEffect(() => {
		if (engine) previewStatusStore.connect(client);
	}, [engine, client]);
	const subscribe = engine?.subscribe;
	useEffect(() => subscribe?.((e) => previewStatusStore.onEvent(e)), [subscribe]);
}

export function previewSettingsFor(doc: ProjectDocument | null, sequenceId: string | null): PreviewSettings {
	const seq = doc && sequenceId ? doc.sequences[sequenceId] : undefined;
	return previewSettingsOf(seq ?? {});
}

/** The sequence's preview settings, stable while they do not change. */
function useSettings(doc: ProjectDocument | null, sequenceId: string | null): PreviewSettings {
	const s = previewSettingsFor(doc, sequenceId);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by value
	return useMemo(() => s, [s.format, s.size, s.quality]);
}

function useStatus(settings: PreviewSettings) {
	const v = useSyncExternalStore(previewStatusStore.subscribe, previewStatusStore.getVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `v` is the store version
	return useMemo(
		() => previewStatusStore.get(settings),
		[v, settings.format, settings.size, settings.quality],
	);
}

const NO_SEGMENTS: RenderPreviewSegment[] = [];

/** Sequences with more clips than this compute their segments after the commit, when the browser is idle. */
const DEFER_SEGMENTS_CLIPS = 200;

const idle = (fn: () => void): (() => void) => {
	const g = globalThis as {
		requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
		cancelIdleCallback?: (h: number) => void;
	};
	if (g.requestIdleCallback && g.cancelIdleCallback) {
		const h = g.requestIdleCallback(fn, { timeout: 300 });
		return () => g.cancelIdleCallback!(h);
	}
	const t = setTimeout(fn, 0);
	return () => clearTimeout(t);
};

/**
 * ui-perf: the preview segments of a committed document. On long sequences they are computed when the browser is
 * idle after the commit (≈ 50–100 ms for 1 000 clips, which made the commit's frame long); meanwhile `segments` are
 * the previous document's and `current` is false (the render bar keeps showing them; the Program monitor plays no
 * preview file until they are current).
 */
function useCommittedSegments(
	doc: ProjectDocument | null,
	sequenceId: string | null,
	enabled: boolean,
): { segments: RenderPreviewSegment[]; current: boolean } {
	const want = enabled && !!doc && !!sequenceId;
	const big = want && Object.keys(doc!.sequences[sequenceId!]?.clips ?? {}).length > DEFER_SEGMENTS_CLIPS;
	const ready = want ? (big ? cachedSegments(doc!, sequenceId!) : segmentsOf(doc!, sequenceId!)) : [];
	const last = useRef<RenderPreviewSegment[]>([]);
	const [, bump] = useState(0);
	useEffect(() => {
		if (ready || !doc || !sequenceId) return;
		return idle(() => {
			segmentsOf(doc, sequenceId);
			bump((n) => n + 1);
		});
	}, [ready, doc, sequenceId]);
	if (ready) last.current = ready;
	return { segments: ready ?? last.current, current: !!ready };
}

/** The render bar spans of a sequence (committed document). */
export function useRenderBar(doc: ProjectDocument, sequenceId: string): RenderSegment[] {
	usePreviewEngine();
	const settings = useSettings(doc, sequenceId);
	const { segments, current } = useCommittedSegments(doc, sequenceId, true);
	const status = useStatus(settings);
	useEffect(() => {
		if (!current) return;
		previewStatusStore.ensure(
			settings,
			segments.map((s) => s.hash),
			[],
		);
	}, [segments, settings, current]);
	return useMemo(() => renderBarSpans(segments, status?.video ?? null), [segments, status]);
}

/**
 * The preview files the Program monitor plays for the committed document (null while a gesture draws a transient
 * document: hashes are only computed for commits).
 */
export function usePlaybackPreviews(
	doc: ProjectDocument | null,
	sequenceId: string | null,
	enabled: boolean,
): {
	video: { start: number; frames: number; url: string }[];
	audio: { start: number; frames: number; url: string }[];
} | null {
	usePreviewEngine();
	const settings = useSettings(doc, sequenceId);
	const status = useStatus(settings);
	const committed = useCommittedSegments(doc, sequenceId, enabled);
	const segments = committed.current ? committed.segments : NO_SEGMENTS;
	// Until the segments of this document are known, nothing plays from a preview file (never a stale picture).
	const segmentsCurrent = !enabled || committed.current;
	const wantAudio = (status?.audioFiles ?? 0) > 0;
	const audioSegments = useMemo<RenderAudioPreviewSegment[]>(() => {
		if (!enabled || !wantAudio || !doc || !sequenceId) return [];
		try {
			return audioPreviewSegments(doc, sequenceId);
		} catch {
			return [];
		}
	}, [enabled, wantAudio, doc, sequenceId]);
	useEffect(() => {
		if (!enabled) return;
		previewStatusStore.ensure(
			settings,
			segments.map((s) => s.hash),
			audioSegments.map((s) => s.hash),
		);
	}, [enabled, segments, audioSegments, settings]);
	return useMemo(() => {
		if (!enabled || !status || !segmentsCurrent) return null;
		const video = playbackSpans(segments, status.video, status.videoUrl);
		const audio = playbackSpans(audioSegments, status.audio, status.audioUrl);
		return video.length || audio.length ? { video, audio } : null;
	}, [enabled, status, segments, audioSegments, segmentsCurrent]);
}
