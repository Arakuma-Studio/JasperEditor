import type { MediaRuntime, SequenceViewState, SessionToggles } from './types.ts';

export function defaultSequenceView(): SequenceViewState {
	return {
		playhead: 0,
		pxPerFrame: 2,
		scrollFrame: 0,
		scrollYVideo: 0,
		scrollYAudio: 0,
		dividerRatio: 0.5,
		trackHeights: {},
		collapsed: {},
		targeting: { video: [], audio: [] },
		sourcePatching: {},
		keyframeDisplay: {},
		display: { thumbnails: 'continuous', waveforms: true, clipNames: true },
	};
}

export function defaultToggles(): SessionToggles {
	return {
		linkedSelection: true,
		snapping: true,
		useProxies: false,
		previewQuality: 'full',
		activeTool: 'selection',
		rippleMarkers: true,
	};
}

export function defaultMediaRuntime(): MediaRuntime {
	const none = { state: 'none' as const, progress: 0 };
	return {
		availability: 'resolving',
		playbackUrl: null,
		proxyUrl: null,
		posterUrl: null,
		spriteUrl: null,
		peaksUrl: null,
		proxy: { ...none },
		thumbs: { ...none },
		peaks: { ...none },
		derived: null,
		ingest: null,
	};
}
