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
import { lottieThumbnail, pdfThumbnail } from '@jasper/compositions';
import { browserPictureNeed, type MediaAsset, mediaLoaderPath } from '@jasper/project';
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

	// ---- imports: interpreted pictures (display PNG of stills a browser cannot show / with a pixel interpretation,
	// interpreted proxy of videos with one). Keyed per asset: two assets of one file may be interpreted differently.
	const variantKeyOf = (m: MediaAsset): string | null => {
		const need = browserPictureNeed(m);
		return need.picture ? `${need.picture}:${need.variant}` : null;
	};
	const requested = new Map<string, string>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const isReady = (id: string, vk: string) => {
		const v = session.getState().media[id]?.variant;
		return v?.key === vk && v.state === 'ready';
	};
	/**
	 * Asks the engine for an interpreted picture; until it is ready the request is repeated (idempotent on the engine)
	 * with a growing delay, so a `media.variant.ready` event that raced the answer or was missed cannot leave the
	 * picture pending. A ready state is never downgraded by a late answer.
	 */
	const askVariant = (
		id: string,
		key: string,
		vk: string,
		kind: 'display' | 'proxy',
		variant: string,
		attempt: number,
	) => {
		engine
			.requestMediaVariant(key, { kind, variant })
			.then((st) => {
				if (disposed || requested.get(id) !== vk || isReady(id, vk)) return;
				session.setMediaRuntime(id, {
					variant: {
						key: vk,
						state: st.state,
						...(st.url ? { url: st.url } : {}),
						...(st.error ? { error: st.error } : {}),
					},
					...(st.state === 'ready' && st.url && kind === 'display' ? { posterUrl: st.url } : {}),
				});
				if ((st.state === 'queued' || st.state === 'running') && attempt < 60) {
					const t = setTimeout(
						() => {
							timers.delete(t);
							if (!disposed && requested.get(id) === vk && !isReady(id, vk))
								askVariant(id, key, vk, kind, variant, attempt + 1);
						},
						Math.min(15_000, 1000 * 1.5 ** attempt),
					);
					timers.add(t);
				}
			})
			.catch((e: unknown) => {
				if (disposed || requested.get(id) !== vk || isReady(id, vk)) return;
				session.setMediaRuntime(id, {
					variant: { key: vk, state: 'failed', error: e instanceof Error ? e.message : String(e) },
				});
			});
	};
	const syncVariants = (ids?: readonly string[]) => {
		if (disposed) return;
		const media = session.getCommitted().media as Record<string, MediaAsset>;
		for (const m of ids
			? ids.map((id) => media[id]).filter((x): x is MediaAsset => !!x)
			: Object.values(media)) {
			const key = mediaKeyOf(m);
			const vk = variantKeyOf(m);
			if (!key || !vk) {
				if (requested.has(m.id)) {
					requested.delete(m.id);
					session.setMediaRuntime(m.id, { variant: undefined });
				}
				continue;
			}
			if (requested.get(m.id) === vk) continue;
			requested.set(m.id, vk);
			const [kind, variant] = [vk.slice(0, vk.indexOf(':')), vk.slice(vk.indexOf(':') + 1)] as [
				'display' | 'proxy',
				string,
			];
			session.setMediaRuntime(m.id, { variant: { key: vk, state: 'queued' } });
			askVariant(m.id, key, vk, kind, variant, 0);
		}
	};
	const onVariantReady = (p: { mediaKey: string; kind: string; variant: string; url: string }) => {
		const vk = `${p.kind}:${p.variant}`;
		for (const id of byKey.get(p.mediaKey) ?? [])
			if (requested.get(id) === vk)
				session.setMediaRuntime(id, {
					variant: { key: vk, state: 'ready', url: p.url },
					// A still's display picture is its poster too (the engine's ffmpeg poster may not read the format).
					...(p.kind === 'display' ? { posterUrl: p.url } : {}),
				});
	};
	// imports: posters of media the engine does not decode — SVG is its own poster, PDF pages and Lottie animations are
	// drawn in the page (pdf.js, the Lottie player).
	const posters = new Map<string, string>();
	const syncPosters = () => {
		if (disposed) return;
		const media = session.getCommitted().media as Record<string, MediaAsset>;
		const base = engine.mediaUrl('k').replace(/\/media\/.*$/, '');
		for (const m of Object.values(media)) {
			const path = mediaLoaderPath(m);
			if (!path) continue;
			const key = `${path}|${m.vector?.page ?? ''}`;
			if (posters.get(m.id) === key) continue;
			posters.set(m.id, key);
			const url = `${base}${path}`;
			const done = (posterUrl: string) => {
				if (!disposed && posters.get(m.id) === key) session.setMediaRuntime(m.id, { posterUrl });
			};
			if (m.vector?.format === 'svg') done(url);
			else if (m.vector?.format === 'pdf')
				void pdfThumbnail(url, m.vector.page ?? 1).then(done, () => undefined);
			else if (m.lottie) void lottieThumbnail(url).then(done, () => undefined);
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
			case 'media.variant.ready':
				onVariantReady(e.payload);
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
	syncVariants();
	syncPosters();
	const offDoc = session.on('doc.changed', (ev) => {
		if (ev.created.some((id) => id.startsWith('med_')) || ev.deleted.some((id) => id.startsWith('med_')))
			syncNew();
		else if (ev.isUndo || ev.isRedo) syncNew();
		// imports: Interpret Footage changed a media (or it was just added): its interpreted picture.
		const touched = [...ev.created, ...ev.changed].filter((id) => id.startsWith('med_'));
		if (touched.length || ev.isUndo || ev.isRedo) {
			syncVariants(ev.isUndo || ev.isRedo ? undefined : touched);
			syncPosters();
		}
	});
	const offEvents = subscribe ? subscribe(onEvent) : () => undefined;

	return {
		dispose() {
			disposed = true;
			for (const t of timers) clearTimeout(t);
			timers.clear();
			offDoc();
			offEvents();
		},
	};
}
