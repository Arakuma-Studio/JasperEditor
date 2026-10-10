// Constants of the renderer-page protocol (protocol.ts) shared with the host agent script (agent.ts).

export const MG_HOST_REMOTION_VERSION = '4.0.499';
/** `window.siteVersion` of 4.0.499 bundles (Remotion's `requiredVersion` in set-props-and-env). */
export const MG_HOST_SITE_VERSION = '11';
/** Query parameter that makes the engine inject the bootstrap into a bundle's index.html. */
export const MG_HOST_QUERY = 'jasper-host';
/** delayRender() timeout inside the host page (the page cancels itself after it). */
export const MG_HOST_TIMEOUT_MS = 30_000;

/** Page functions and globals the adapter relies on (checked by the host agent's `check`). */
export const MG_HOST_REQUIRED_GLOBALS = [
	'remotion_setBundleMode',
	'remotion_calculateComposition',
	'getStaticCompositions',
	'remotion_version',
	'siteVersion',
] as const;

/**
 * The `sandbox` attribute of a host iframe (security review MG-1): scripts only. No `allow-same-origin` (the page
 * gets an opaque origin: no cookies, no storage, no access to the editor), no forms, popups, top navigation,
 * modals, downloads, pointer lock or presentation.
 */
export const MG_HOST_SANDBOX = 'allow-scripts';
