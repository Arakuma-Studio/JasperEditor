import type { MediaHandle } from '../render/snapshot.ts';
import type { MediaAsset } from '../schema/media.ts';

// Agent queries evaluate snapshots from metadata without loading media URLs.
export function queryMediaHandle(asset: MediaAsset): MediaHandle {
	const vs = asset.probe.streams.find((s) => s.type === 'video');
	return {
		url: '',
		proxyUrl: null,
		kind: asset.kind,
		width: vs?.width ?? null,
		height: vs?.height ?? null,
		durationFlicks: asset.probe.durationFlicks,
		hasAudio: asset.probe.streams.some((s) => s.type === 'audio'),
		rotation: asset.probe.rotationDegrees,
	};
}
