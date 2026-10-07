// The live frame host adapter (M2, S08:MGC-021, D-26): drives an imported Remotion bundle's own page — loaded
// in a same-origin <iframe> from `/mg/bundles/<key>/index.html?jasper-host=1` — frame by frame through the page
// protocol that `@remotion/renderer` 4.0.499 uses for headless renders (read from its public source:
// set-props-and-env.ts, make-page.ts, seek-to-frame.ts, select-composition.ts, and @remotion/studio's
// renderEntry). This module is the ONLY place that knows that protocol; the contract test (e2e/mg-clips.spec.ts)
// fails loudly when a Remotion upgrade changes it (ARCHITECTURE D-19).
//
// Protocol (Remotion 4.0.499, bundle `siteVersion` 11):
//   before the bundle's scripts: window.remotion_puppeteerTimeout (marks a headless page: no Studio UI),
//     process.env.NODE_ENV = 'production' (with the timeout → getRemotionEnvironment().isRendering),
//     remotion_inputProps / remotion_initialFrame / remotion_attempt / remotion_envVariables …
//   remotion_setBundleMode({type: 'evaluation'}) → wait → remotion_calculateComposition(id) (runs
//     calculateMetadata with remotion_inputProps) → remotion_setBundleMode({type: 'composition', …metadata})
//   remotion_setFrame(frame, compositionId, attempt)
//   "ready" = window.remotion_renderReady === true (every delayRender() handle continued) and
//     document.fonts.ready; window.remotion_cancelledError (string stack) = the page failed.
// Pure TypeScript (no React): the engine imports the bootstrap for the HTML it serves.
// M3 (wp-m3-mgtext): the bootstrap also installs the text probe (text-probe.ts: bundle fonts, text layout).

import { TEXT_PROBE_SCRIPT } from './text-probe.ts';

export const MG_HOST_REMOTION_VERSION = '4.0.499';
/** `window.siteVersion` of 4.0.499 bundles (Remotion's `requiredVersion` in set-props-and-env). */
export const MG_HOST_SITE_VERSION = '11';
/** Query parameter that makes the engine inject the bootstrap into a bundle's index.html. */
export const MG_HOST_QUERY = 'jasper-host';
/** delayRender() timeout inside the host page (the page cancels itself after it). */
export const MG_HOST_TIMEOUT_MS = 30_000;

/** Page functions and globals the adapter relies on (checked by `checkHostProtocol`). */
const MG_HOST_REQUIRED_GLOBALS = [
	'remotion_setBundleMode',
	'remotion_calculateComposition',
	'getStaticCompositions',
	'remotion_version',
	'siteVersion',
] as const;

/** URL of the host page of a bundle served at `bundleBase` (`/mg/bundles/<key>/`). */
export function hostPageUrl(bundleBase: string): string {
	const base = bundleBase.endsWith('/') ? bundleBase : `${bundleBase}/`;
	return `${base}index.html?${MG_HOST_QUERY}=1`;
}

/** Serve URL of a bundle (`/mg/bundles/<key>/`). */
export function bundleServeUrl(mediaKey: string): string {
	return `/mg/bundles/${encodeURIComponent(mediaKey)}/`;
}

/**
 * The script the engine injects at the top of `<head>` of a host page (before the bundle's own scripts): the
 * globals `setPropsAndEnv` sets with `evaluateOnNewDocument`, plus a transparent page background, then the
 * text probe (M3, S08:MGC-037/039: it must see the bundle's `new FontFace(…)` calls, so it runs first too).
 */
function hostBootstrapScript(opts: { timeoutMs?: number; logLevel?: string } = {}): string {
	const timeout = Math.max(1000, Math.floor(opts.timeoutMs ?? MG_HOST_TIMEOUT_MS));
	return [
		'(function(){',
		`window.remotion_puppeteerTimeout=${timeout};`,
		'window.remotion_isMainTab=true;',
		'window.remotion_mediaCacheSizeInBytes=null;',
		'window.remotion_initialMemoryAvailable=null;',
		'window.remotion_sampleRate=48000;',
		'if(window.process===undefined){window.process={};}',
		'if(window.process.env===undefined){window.process.env={};}',
		"window.process.env.NODE_ENV='production';",
		"window.remotion_envVariables='{}';",
		"window.remotion_inputProps='{}';",
		'window.remotion_initialFrame=0;',
		'window.remotion_attempt=1;',
		'window.remotion_proxyPort=0;',
		'window.remotion_audioEnabled=false;',
		'window.remotion_videoEnabled=true;',
		`window.remotion_logLevel=${JSON.stringify(opts.logLevel ?? 'error')};`,
		"try{window.remotion_broadcastChannel=new BroadcastChannel('remotion-video-frame-extraction');}catch(e){}",
		'window.alert=function(m){window.remotion_cancelledError=new Error("alert("+(m||"")+") was called").stack;};',
		'window.confirm=function(){return false;};',
		'window.__jasperMgHost=1;',
		'})();',
		TEXT_PROBE_SCRIPT,
	].join('');
}

/** CSS injected with the bootstrap: transparent page, no margins or scrollbars. */
const HOST_PAGE_CSS =
	// `color-scheme: light` on both sides (here and on the <iframe>): a scheme mismatch makes Chrome paint an
	// opaque backdrop behind the frame.
	'html,body{margin:0!important;padding:0!important;background:transparent!important;overflow:hidden!important;color-scheme:light}' +
	'#video-container{position:absolute;left:0;top:0}';

/** Inserts the bootstrap (and CSS) right after `<head>` of a bundle's index.html. */
export function injectHostBootstrap(html: string, opts?: { timeoutMs?: number; logLevel?: string }): string {
	const tag = `<script>${hostBootstrapScript(opts)}</script><style>${HOST_PAGE_CSS}</style>`;
	const m = /<head[^>]*>/i.exec(html);
	if (!m) return `${tag}${html}`;
	return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
}

// ---------------------------------------------------------------- the driver

export type CompositionMetadata = {
	width: number;
	height: number;
	fps: number;
	durationInFrames: number;
	defaultCodec?: unknown;
	defaultOutName?: unknown;
	defaultVideoImageFormat?: unknown;
	defaultPixelFormat?: unknown;
	defaultProResProfile?: unknown;
	defaultSampleRate?: unknown;
	serializedResolvedPropsWithCustomSchema: string;
};

/** The page globals the protocol uses (typed loosely: they belong to another document). */
export type HostWindow = {
	remotion_setBundleMode?: (state: Record<string, unknown>) => void;
	remotion_calculateComposition?: (id: string) => Promise<CompositionMetadata>;
	remotion_getCompositionNames?: () => string[];
	remotion_setFrame?: (frame: number, composition: string, attempt: number) => void;
	remotion_renderReady?: boolean;
	remotion_cancelledError?: string;
	remotion_inputProps?: string;
	remotion_attempt?: number;
	remotion_version?: string;
	siteVersion?: string;
	getStaticCompositions?: () => Promise<unknown[]>;
	document?: { fonts?: { ready?: Promise<unknown> } };
	requestAnimationFrame?: (cb: () => void) => unknown;
	__jasperMgHost?: number;
};

export class MgHostProtocolError extends Error {
	constructor(
		readonly code: 'MG_HOST_PROTOCOL' | 'MG_HOST_TIMEOUT' | 'MG_HOST_CANCELLED' | 'MG_HOST_NO_COMPOSITION',
		message: string,
	) {
		super(message);
		this.name = 'MgHostProtocolError';
	}
}

/** Which protocol pieces a loaded host page has (the contract test asserts all of them). */
export function checkHostProtocol(win: HostWindow): {
	ok: boolean;
	missing: string[];
	remotionVersion: string | null;
	siteVersion: string | null;
} {
	const w = win as Record<string, unknown>;
	const missing: string[] = MG_HOST_REQUIRED_GLOBALS.filter((k) => w[k] === undefined);
	const remotionVersion = typeof win.remotion_version === 'string' ? win.remotion_version : null;
	const siteVersion = typeof win.siteVersion === 'string' ? win.siteVersion : null;
	if (remotionVersion !== null && remotionVersion !== MG_HOST_REMOTION_VERSION)
		missing.push(`remotion_version=${MG_HOST_REMOTION_VERSION} (found ${remotionVersion})`);
	if (siteVersion !== null && siteVersion !== MG_HOST_SITE_VERSION)
		missing.push(`siteVersion=${MG_HOST_SITE_VERSION} (found ${siteVersion})`);
	return { ok: missing.length === 0, missing, remotionVersion, siteVersion };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until the page reports ready (all delayRender handles continued) or cancelled. */
export async function waitForHostReady(win: HostWindow, timeoutMs = MG_HOST_TIMEOUT_MS): Promise<void> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		if (typeof win.remotion_cancelledError === 'string')
			throw new MgHostProtocolError(
				'MG_HOST_CANCELLED',
				win.remotion_cancelledError.split('\n')[0] ?? 'cancelled',
			);
		if (win.remotion_renderReady === true) break;
		if (Date.now() > until)
			throw new MgHostProtocolError(
				'MG_HOST_TIMEOUT',
				`The composition page was not ready after ${timeoutMs} ms`,
			);
		await sleep(8);
	}
	const ready = win.document?.fonts?.ready;
	if (ready) await Promise.race([ready, sleep(2000)]);
}

/**
 * Waits until `remotion_getCompositionNames()` lists `id` (compositions register in effects after the root
 * renders). Resolves anyway after the timeout so `remotion_calculateComposition` reports the real error.
 */
async function waitForComposition(win: HostWindow, id: string, timeoutMs: number): Promise<void> {
	const names = win.remotion_getCompositionNames;
	if (typeof names !== 'function') return;
	const until = Date.now() + Math.min(timeoutMs, 10_000);
	for (;;) {
		try {
			if (names().includes(id)) return;
		} catch {
			// root not registered yet
		}
		if (Date.now() > until) return;
		await sleep(10);
	}
}

export type HostCompositionConfig = {
	compositionId: string;
	/** Effective props (plain JSON). */
	props: Record<string, unknown>;
	/**
	 * Overrides of the calculated metadata: renders and previews run at the sequence rate and the clip's canvas
	 * size (S08:MGC-003/005). Omitted fields keep the composition's own values.
	 */
	override?: Partial<Pick<CompositionMetadata, 'width' | 'height' | 'fps' | 'durationInFrames'>>;
};

/**
 * Drives one host page. Calls are serialized: `configure` (props/metadata) and `seek` (frame) each resolve
 * when the page is ready. `latest` semantics are the caller's (the layer only asks for the newest frame).
 */
export class MgFrameHostDriver {
	private chain: Promise<unknown> = Promise.resolve();
	private evaluated = false;
	private configured: string | null = null;
	private metadata: CompositionMetadata | null = null;
	private frame: number | null = null;

	constructor(
		private readonly win: HostWindow,
		private readonly opts: { timeoutMs?: number } = {},
	) {}

	get current(): { metadata: CompositionMetadata | null; frame: number | null } {
		return { metadata: this.metadata, frame: this.frame };
	}

	private run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(fn, fn);
		this.chain = next.catch(() => undefined);
		return next;
	}

	/** Waits for the bundle's globals (they are defined while its scripts evaluate). */
	async waitForPage(): Promise<void> {
		const until = Date.now() + (this.opts.timeoutMs ?? MG_HOST_TIMEOUT_MS);
		for (;;) {
			const c = checkHostProtocol(this.win);
			if (c.ok) return;
			if (c.remotionVersion && c.remotionVersion !== MG_HOST_REMOTION_VERSION)
				throw new MgHostProtocolError('MG_HOST_PROTOCOL', `Unsupported bundle: ${c.missing.join(', ')}`);
			if (Date.now() > until)
				throw new MgHostProtocolError(
					'MG_HOST_PROTOCOL',
					`The bundle page does not implement the Remotion ${MG_HOST_REMOTION_VERSION} page protocol (missing ${c.missing.join(', ')})`,
				);
			await sleep(10);
		}
	}

	/** Sets props (and metadata overrides) of the composition; resolves with the metadata in effect. */
	configure(cfg: HostCompositionConfig): Promise<CompositionMetadata> {
		return this.run(async () => {
			const key = JSON.stringify([cfg.compositionId, cfg.props, cfg.override ?? null]);
			if (key === this.configured && this.metadata) return this.metadata;
			const w = this.win;
			await this.waitForPage();
			const timeout = this.opts.timeoutMs ?? MG_HOST_TIMEOUT_MS;
			w.remotion_inputProps = JSON.stringify(cfg.props ?? {});
			if (!this.evaluated) {
				w.remotion_setBundleMode!({ type: 'evaluation' });
				await waitForHostReady(w, timeout);
				this.evaluated = true;
			}
			// Compositions register from React effects of the evaluated root: wait until ours is there.
			await waitForComposition(w, cfg.compositionId, timeout);
			let meta: CompositionMetadata;
			try {
				meta = await w.remotion_calculateComposition!(cfg.compositionId);
			} catch (e) {
				throw new MgHostProtocolError(
					'MG_HOST_NO_COMPOSITION',
					e instanceof Error ? e.message.split('\n')[0]! : String(e),
				);
			}
			const o = cfg.override ?? {};
			const resolved: CompositionMetadata = {
				...meta,
				width: o.width ?? meta.width,
				height: o.height ?? meta.height,
				fps: o.fps ?? meta.fps,
				durationInFrames: o.durationInFrames ?? meta.durationInFrames,
			};
			w.remotion_setBundleMode!({
				type: 'composition',
				compositionName: cfg.compositionId,
				serializedResolvedPropsWithSchema: meta.serializedResolvedPropsWithCustomSchema,
				compositionDurationInFrames: resolved.durationInFrames,
				compositionFps: resolved.fps,
				compositionHeight: resolved.height,
				compositionWidth: resolved.width,
				compositionDefaultCodec: meta.defaultCodec ?? 'h264',
				compositionDefaultOutName: meta.defaultOutName ?? null,
				compositionDefaultVideoImageFormat: meta.defaultVideoImageFormat ?? null,
				compositionDefaultPixelFormat: meta.defaultPixelFormat ?? null,
				compositionDefaultProResProfile: meta.defaultProResProfile ?? null,
				compositionDefaultSampleRate: meta.defaultSampleRate ?? 48000,
			});
			await waitForHostReady(w, timeout);
			this.configured = key;
			this.metadata = resolved;
			// A new tree starts at the initial frame: show the last requested frame again.
			if (this.frame !== null) {
				const f = this.frame;
				this.frame = null;
				await this.seekNow(cfg.compositionId, f);
			}
			return resolved;
		});
	}

	private async seekNow(compositionId: string, frame: number): Promise<void> {
		const w = this.win;
		if (!w.remotion_setFrame)
			throw new MgHostProtocolError(
				'MG_HOST_PROTOCOL',
				'remotion_setFrame is missing (no composition mounted)',
			);
		const max = Math.max(0, (this.metadata?.durationInFrames ?? frame + 1) - 1);
		const f = Math.max(0, Math.min(max, Math.round(frame)));
		if (f === this.frame) return;
		w.remotion_setFrame(f, compositionId, 1);
		await waitForHostReady(w, this.opts.timeoutMs ?? MG_HOST_TIMEOUT_MS);
		this.frame = f;
	}

	/** Shows composition frame `frame` (clamped to the composition); resolves when it is drawn. */
	seek(compositionId: string, frame: number): Promise<void> {
		return this.run(() => this.seekNow(compositionId, frame));
	}
}

// M3 (wp-m3-mgtext): the text probe's typed helpers travel with the protocol (`@jasper/compositions/mg-host`).
export {
	type BundleFontSource,
	locateTexts,
	TEXT_PROBE_SCRIPT,
	textProbeOf,
} from './text-probe.ts';
