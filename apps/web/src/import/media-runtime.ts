// Media runtime status (S01:LIFE-050): per asset availability, playback/proxy/poster/sprite/peaks URLs and
// derivative progress, never in the document. Fed by `GET /api/media/:key` on attach/import and by the
// engine events `derivative.ready`, `media.updated` and `job.*` (ARCHITECTURE §9.2).
import type {
	DerivativeStatus as ApiDerivativeStatus,
	DerivativeKind,
	EngineJob,
	MediaStatus,
	TypedEvent,
} from '@jasper/api';
import { TERMINAL_JOB_STATES } from '@jasper/api';
import { type EngineClient, EngineError } from '@jasper/engine-client';
import type { MediaAsset } from '@jasper/project';
import type { DerivativeStatus, EditorSession, MediaRuntime } from '@jasper/session';
import { mediaKeyOf } from './assets.ts';

type Subscribe = (listener: (e: TypedEvent | null) => void) => () => void;

type Slot = 'proxy' | 'thumbs' | 'peaks' | 'poster';

const SLOT_OF_KIND: Partial<Record<DerivativeKind, Slot>> = {
	poster: 'poster',
	sprite: 'thumbs',
	peaks: 'peaks',
	'proxy-720': 'proxy',
	'proxy-540': 'proxy',
};
const SLOT_OF_JOB: Partial<Record<EngineJob['kind'], Slot>> = {
	poster: 'poster',
	sprite: 'thumbs',
	peaks: 'peaks',
	proxy: 'proxy',
};

type ProxyKind = 'proxy-720' | 'proxy-540';
type ProxyTiers = Partial<Record<ProxyKind, { status: DerivativeStatus; url?: string }>>;
const PROXY_STATE_RANK: Record<DerivativeStatus['state'], number> = {
	ready: 4,
	running: 3,
	queued: 2,
	failed: 1,
	none: 0,
};

/** The proxy tier the runtime reports: a ready one (720 first), else the one that is furthest along. */
function bestProxyTier(tiers: ProxyTiers): { status: DerivativeStatus; url?: string } {
	let best: { status: DerivativeStatus; url?: string } = { status: { state: 'none', progress: 0 } };
	for (const kind of ['proxy-720', 'proxy-540'] as const) {
		const t = tiers[kind];
		if (t && PROXY_STATE_RANK[t.status.state] > PROXY_STATE_RANK[best.status.state]) best = t;
	}
	return best;
}

/** Keeps `session.state.media` in sync with the engine. */
export function createMediaRuntimeSync(
	session: EditorSession,
	engine: EngineClient,
	subscribe: Subscribe | null,
): { dispose(): void } {
	/** mediaKey → media ids (several assets may share a key after "import again" in other projects). */
	let byKey = new Map<string, string[]>();
	let byFingerprint = new Map<string, string[]>();
	/** media id → the engine key it was resolved with (a relink to another file resolves again). */
	const known = new Map<string, string | null>();
	/** mediaKey → last reported status of each proxy tier. */
	const proxyTiers = new Map<string, ProxyTiers>();
	let disposed = false;

	const reindex = () => {
		const media = session.getCommitted().media;
		byKey = new Map();
		byFingerprint = new Map();
		for (const m of Object.values(media) as MediaAsset[]) {
			const key = mediaKeyOf(m);
			if (key) byKey.set(key, [...(byKey.get(key) ?? []), m.id]);
			byFingerprint.set(m.fingerprint, [...(byFingerprint.get(m.fingerprint) ?? []), m.id]);
		}
		return media;
	};

	const patchKey = (key: string, patch: Partial<MediaRuntime>) => {
		if (disposed) return;
		for (const id of byKey.get(key) ?? []) session.setMediaRuntime(id, patch);
	};

	const applyDerivative = (key: string, kind: DerivativeKind, status: DerivativeStatus, url?: string) => {
		const slot = SLOT_OF_KIND[kind];
		if (!slot || disposed || !byKey.has(key)) return;
		const ready = status.state === 'ready';
		switch (slot) {
			case 'poster':
				patchKey(key, ready ? { posterUrl: url ?? engine.mediaUrl(key, 'poster') } : {});
				break;
			case 'thumbs':
				patchKey(key, {
					thumbs: status,
					...(ready ? { spriteUrl: url ?? engine.mediaUrl(key, 'sprite.json') } : {}),
				});
				break;
			case 'peaks':
				patchKey(key, {
					peaks: status,
					...(ready ? { peaksUrl: url ?? engine.mediaUrl(key, 'peaks.json') } : {}),
				});
				break;
			case 'proxy': {
				// Both tiers share the runtime's one proxy slot: a tier that was never made ("none") must not
				// hide the other tier's ready proxy (the mandatory proxy of ProRes media is the 720 one).
				const tiers = proxyTiers.get(key) ?? {};
				tiers[kind as ProxyKind] = {
					status,
					...(ready
						? { url: url ?? engine.mediaUrl(key, { proxy: kind === 'proxy-540' ? '540' : '720' }) }
						: {}),
				};
				proxyTiers.set(key, tiers);
				const best = bestProxyTier(tiers);
				patchKey(key, { proxy: best.status, ...(best.url ? { proxyUrl: best.url } : {}) });
			}
		}
	};

	const applyStatus = (s: Pick<MediaStatus, 'mediaKey' | 'status' | 'derivatives'>) => {
		const availability: MediaRuntime['availability'] =
			s.status === 'missing' ? 'offline' : s.status === 'error' ? 'error' : 'online';
		patchKey(s.mediaKey, { availability, playbackUrl: engine.mediaUrl(s.mediaKey) });
		for (const [kind, d] of Object.entries(s.derivatives ?? {}) as [DerivativeKind, ApiDerivativeStatus][]) {
			applyDerivative(
				s.mediaKey,
				kind,
				{ state: d.state, progress: d.progress, ...(d.error ? { error: d.error } : {}) },
				d.url,
			);
		}
	};

	const resolve = (key: string) => {
		patchKey(key, { availability: 'resolving', playbackUrl: engine.mediaUrl(key) });
		engine
			.mediaStatus(key)
			.then((s) => applyStatus(s))
			.catch((e) => {
				if (e instanceof EngineError && (e.code === 'ASSET_NOT_FOUND' || e.code === 'NOT_FOUND'))
					patchKey(key, { availability: 'offline' });
				else if (e instanceof EngineError && e.code === 'NETWORK')
					patchKey(key, { availability: 'needs-engine' });
				// Older/stub engines: assume the original is served and wait for events.
				else patchKey(key, { availability: 'online' });
			});
	};

	const syncNew = () => {
		const media = reindex();
		for (const m of Object.values(media) as MediaAsset[]) {
			const key = mediaKeyOf(m);
			if (known.has(m.id) && known.get(m.id) === key) continue;
			known.set(m.id, key);
			if (key) resolve(key);
			// wp interchange: an imported placeholder has no file yet (Link Media links it).
			else if (m.fingerprint.startsWith('pending:interchange:'))
				session.setMediaRuntime(m.id, { availability: 'offline' });
			else session.setMediaRuntime(m.id, { availability: 'needs-engine' });
		}
	};

	const jobTargets = (job: EngineJob): string[] => {
		const keys: string[] = [];
		if (job.assetId && byKey.has(job.assetId)) keys.push(job.assetId);
		const fp = job.dedupeKey?.split(':').slice(2).join(':');
		if (!keys.length && fp) {
			for (const id of byFingerprint.get(fp) ?? []) {
				const key = mediaKeyOf(session.getCommitted().media[id] as MediaAsset | undefined);
				if (key) keys.push(key);
			}
		}
		return keys;
	};

	const onEvent = (e: TypedEvent | null) => {
		if (!e || disposed) return;
		switch (e.type) {
			case 'derivative.ready':
				applyDerivative(e.payload.mediaKey, e.payload.kind, { state: 'ready', progress: 1 }, e.payload.url);
				break;
			case 'media.updated':
				applyStatus({
					mediaKey: e.payload.mediaKey,
					status: e.payload.status,
					derivatives: e.payload.derivatives ?? ({} as MediaStatus['derivatives']),
				});
				break;
			case 'job.created':
			case 'job.updated':
			case 'job.finished': {
				const job = e.payload;
				const slot = SLOT_OF_JOB[job.kind];
				if (!slot || slot === 'poster') break;
				const state: DerivativeStatus['state'] =
					job.state === 'queued'
						? 'queued'
						: job.state === 'succeeded'
							? 'ready'
							: TERMINAL_JOB_STATES.has(job.state)
								? 'failed'
								: 'running';
				if (state === 'ready') break; // derivative.ready carries the URL
				const kind: DerivativeKind = slot === 'thumbs' ? 'sprite' : slot === 'peaks' ? 'peaks' : 'proxy-720';
				for (const key of jobTargets(job))
					applyDerivative(key, kind, {
						state,
						progress: job.progress ?? 0,
						...(job.error ? { error: job.error.message } : {}),
					});
				break;
			}
		}
	};

	syncNew();
	const offDoc = session.on('doc.changed', (ev) => {
		if (ev.created.some((id) => id.startsWith('med_')) || ev.deleted.some((id) => id.startsWith('med_')))
			syncNew();
		else if (ev.isUndo || ev.isRedo) syncNew();
	});
	const offEvents = subscribe ? subscribe(onEvent) : () => undefined;

	return {
		dispose() {
			disposed = true;
			offDoc();
			offEvents();
		},
	};
}
