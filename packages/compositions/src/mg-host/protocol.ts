// The live frame host adapter (M2, S08:MGC-021, D-26; sandboxed by security review MG-1): an imported Remotion
// bundle's own page — loaded in a sandboxed <iframe> (no `allow-same-origin`) from
// `/mg/bundles/<key>/index.html?jasper-host=1`, which the engine redirects to the bundle's capability path
// `/mg/sandbox/<cap>/<key>/` — is driven frame by frame through the page protocol that `@remotion/renderer`
// 4.0.499 uses for headless renders (read from its public source: set-props-and-env.ts, make-page.ts,
// seek-to-frame.ts, select-composition.ts, and @remotion/studio's renderEntry). The protocol runs INSIDE the page
// (agent.ts, the host agent the bootstrap installs); the editor talks to the agent over a MessagePort (remote.ts).
// agent.ts is the ONLY place that knows the page protocol; the contract test (e2e/mg-clips.spec.ts) fails loudly
// when a Remotion upgrade changes it (ARCHITECTURE D-19).
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
// Pure TypeScript (no React, no DOM types): the engine imports the bootstrap for the HTML it serves.
// M3 (wp-m3-mgtext): the bootstrap also installs the text probe (text-probe.ts: bundle fonts, text layout).

import { HOST_AGENT_SCRIPT } from './agent.ts';
import { MG_HOST_QUERY, MG_HOST_TIMEOUT_MS } from './constants.ts';
import { HTML_HOST_AGENT_SCRIPT } from './html-agent.ts';
import { TEXT_PROBE_SCRIPT } from './text-probe.ts';

export { HOST_AGENT_SCRIPT, MG_HOST_CONNECT, MG_HOST_PORT_PROTOCOL } from './agent.ts';
export {
	MG_HOST_QUERY,
	MG_HOST_REMOTION_VERSION,
	MG_HOST_SANDBOX,
	MG_HOST_SITE_VERSION,
	MG_HOST_TIMEOUT_MS,
} from './constants.ts';
export {
	HTML_CONTRACT_GLOBALS,
	HTML_CONTRACT_GRACE_MS,
	HTML_HOST_AGENT_SCRIPT,
	HTML_MAX_DURATION_SEC,
} from './html-agent.ts';

/** URL of the host page of a bundle served at `bundleBase` (`/mg/bundles/<key>/`). */
export function hostPageUrl(bundleBase: string): string {
	const base = bundleBase.endsWith('/') ? bundleBase : `${bundleBase}/`;
	return `${base}index.html?${MG_HOST_QUERY}=1`;
}

/**
 * URL of the host page of an HTML composition served at `bundleBase`: its entry file with the import's query string
 * (the page reads it as `location.search`) and the host marker. The engine's renders load the same URL shape.
 */
export function htmlHostPageUrl(bundleBase: string, page: { entry: string; query: string }): string {
	const base = bundleBase.endsWith('/') ? bundleBase : `${bundleBase}/`;
	return `${base}${encodeURIComponent(page.entry)}?${page.query ? `${page.query}&` : ''}${MG_HOST_QUERY}=1`;
}

/** Serve URL of a bundle (`/mg/bundles/<key>/`). */
export function bundleServeUrl(mediaKey: string): string {
	return `/mg/bundles/${encodeURIComponent(mediaKey)}/`;
}

/**
 * Security review MG-1: a sandboxed page has an opaque origin, where reading `localStorage`, `sessionStorage` or
 * `document.cookie` throws a SecurityError. Remotion's root (and many libraries) read them while they start, so the
 * page would not render at all. Where the real ones throw, the page gets stand-ins that live and die with the
 * document: nothing persists, nothing is shared with the editor or with another bundle. A page that is not
 * sandboxed (the engine's own headless measuring browser) keeps the real ones.
 */
export const SANDBOX_STORAGE_SHIM = `(function(){
function memory() {
	var m = Object.create(null);
	var api = {
		getItem: function (k) { k = String(k); return k in m ? m[k] : null; },
		setItem: function (k, v) { m[String(k)] = String(v); },
		removeItem: function (k) { delete m[String(k)]; },
		clear: function () { m = Object.create(null); },
		key: function (i) { var ks = Object.keys(m); return i >= 0 && i < ks.length ? ks[i] : null; }
	};
	Object.defineProperty(api, 'length', { get: function () { return Object.keys(m).length; } });
	return api;
}
['localStorage', 'sessionStorage'].forEach(function (name) {
	try { void window[name]; }
	catch (e) { try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (e2) {} }
});
try { void document.cookie; }
catch (e) { try { Object.defineProperty(document, 'cookie', { get: function () { return ''; }, set: function () {}, configurable: true }); } catch (e2) {} }
})();`;

/**
 * The script the engine injects at the top of `<head>` of a host page (before the bundle's own scripts): the
 * globals `setPropsAndEnv` sets with `evaluateOnNewDocument`, plus a transparent page background, then the
 * text probe (M3, S08:MGC-037/039: it must see the bundle's `new FontFace(…)` calls, so it runs first too) and
 * the host agent (agent.ts).
 */
export function hostBootstrapScript(opts: { timeoutMs?: number; logLevel?: string } = {}): string {
	const timeout = Math.max(1000, Math.floor(opts.timeoutMs ?? MG_HOST_TIMEOUT_MS));
	return [
		SANDBOX_STORAGE_SHIM,
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
		// Security review MG-1: the editor drives the page through this agent and a MessagePort, never by reaching in.
		HOST_AGENT_SCRIPT,
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

/**
 * The script injected at the top of `<head>` of an HTML composition page (before the page's own scripts): the storage
 * stand-ins of a sandboxed page and the HTML host agent (html-agent.ts). The page's own CSS is kept (its background is
 * the clip's; a page without one is transparent).
 */
export function htmlHostBootstrapScript(): string {
	return [SANDBOX_STORAGE_SHIM, HTML_HOST_AGENT_SCRIPT].join('');
}

/** Inserts the HTML host bootstrap right after `<head>` of an HTML composition page (or first, without a head). */
export function injectHtmlHostBootstrap(html: string): string {
	// `color-scheme: light` like the iframe (a scheme mismatch paints an opaque backdrop); the page may override it.
	const script = htmlHostBootstrapScript();
	const lines = script.split('\n').length - 1;
	const tag = `<script>window.__jasperHtmlLineShift=${lines};${script}</script><style>:root{color-scheme:light}</style>`;
	const m = /<head[^>]*>/i.exec(html);
	if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
	// No <head>: after the doctype, so the page keeps its standards mode.
	const d = /^\s*<!doctype[^>]*>/i.exec(html);
	return d ? html.slice(0, d[0].length) + tag + html.slice(d[0].length) : `${tag}${html}`;
}

/** The metadata in effect for a mounted composition (after overrides). */
export type CompositionMetadata = {
	width: number;
	height: number;
	fps: number;
	durationInFrames: number;
};

export type MgHostErrorCode =
	| 'MG_HOST_PROTOCOL'
	| 'MG_HOST_TIMEOUT'
	| 'MG_HOST_CANCELLED'
	| 'MG_HOST_NO_COMPOSITION';

export class MgHostProtocolError extends Error {
	constructor(
		readonly code: MgHostErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'MgHostProtocolError';
	}
}

/** Which protocol pieces a loaded host page has (the contract test asserts all of them). */
export type HostProtocolCheck = {
	ok: boolean;
	missing: string[];
	remotionVersion: string | null;
	siteVersion: string | null;
};

export type HostCompositionConfig = {
	compositionId: string;
	/** Effective props (plain JSON). */
	props: Record<string, unknown>;
	/**
	 * Overrides of the calculated metadata: renders and previews run at the sequence rate and the clip's canvas
	 * size (S08:MGC-003/005). Omitted fields keep the composition's own values.
	 */
	override?: Partial<CompositionMetadata>;
};

// M3 (wp-m3-mgtext): the text probe's typed helpers travel with the protocol (`@jasper/compositions/mg-host`).
export {
	type BundleFontSource,
	locateTexts,
	TEXT_PROBE_SCRIPT,
	textProbeOf,
} from './text-probe.ts';
