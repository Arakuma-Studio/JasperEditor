// The Content-Security-Policy of the files of an imported bundle (security review MG-1), shared by the sandboxed
// `/mg/sandbox/…` route and the engine's own loopback server for HTML composition renders.

/**
 * The Content-Security-Policy of a bundle's files (security review MG-1).
 *  - `sandbox allow-scripts`: the document gets an opaque origin wherever it is loaded (the editor's iframe has
 *    the same sandbox attribute; a tab opened on the URL is sandboxed by this header). No cookies, storage,
 *    same-origin access, forms, popups, top navigation or downloads.
 *  - sources: the bundle's own files (`base`, path-scoped: not the rest of the engine), inline and eval'd script
 *    and inline style (Remotion's index.html and many libraries need them; the sandbox is the boundary, not the
 *    script policy), `data:` / `blob:`, and `https:` for what compositions fetch (web fonts, remote media, data).
 *    Plain `http:` is not allowed: no other loopback port, no device on the local network.
 *  - `frame-ancestors`: only the editor may embed the page.
 *  - `remoteScripts` (HTML compositions): `https:` scripts too (pages commonly load GSAP from a CDN). The engine's
 *    headless renders serve those pages with the same policy, so preview and export load the same things.
 */
export function mgHostCsp(opts: { base: string; ancestors: string[]; remoteScripts?: boolean }): string {
	const own = opts.base;
	return [
		'sandbox allow-scripts',
		`default-src ${own} data: blob:`,
		`script-src ${own} 'unsafe-inline' 'unsafe-eval' blob: data:${opts.remoteScripts ? ' https:' : ''}`,
		`style-src ${own} 'unsafe-inline' https:`,
		`font-src ${own} data: blob: https:`,
		`img-src ${own} data: blob: https:`,
		`media-src ${own} data: blob: https:`,
		`connect-src ${own} data: blob: https:`,
		`worker-src ${own} blob:`,
		"frame-src 'none'",
		"object-src 'none'",
		"form-action 'none'",
		`base-uri ${own}`,
		`frame-ancestors ${opts.ancestors.join(' ') || "'none'"}`,
	].join('; ');
}
