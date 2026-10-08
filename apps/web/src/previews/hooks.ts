// Render previews in the editor (workstream `previews`): the render bar of the Timeline and the preview files the
// Program monitor plays, from the committed document and the engine's answers (store.ts).
import type { PreviewSettings } from '@jasper/api';
import {
	audioPreviewSegments,
	type ProjectDocument,
	previewSettingsOf,
	type RenderAudioPreviewSegment,
} from '@jasper/project';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
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

/** The render bar spans of a sequence (committed document). */
export function useRenderBar(doc: ProjectDocument, sequenceId: string): RenderSegment[] {
	usePreviewEngine();
	const settings = useSettings(doc, sequenceId);
	const segments = useMemo(() => segmentsOf(doc, sequenceId), [doc, sequenceId]);
	const status = useStatus(settings);
	useEffect(() => {
		previewStatusStore.ensure(
			settings,
			segments.map((s) => s.hash),
			[],
		);
	}, [segments, settings]);
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
	const segments = useMemo(
		() => (enabled && doc && sequenceId ? segmentsOf(doc, sequenceId) : []),
		[enabled, doc, sequenceId],
	);
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
		if (!enabled || !status) return null;
		const video = playbackSpans(segments, status.video, status.videoUrl);
		const audio = playbackSpans(audioSegments, status.audio, status.audioUrl);
		return video.length || audio.length ? { video, audio } : null;
	}, [enabled, status, segments, audioSegments]);
}
