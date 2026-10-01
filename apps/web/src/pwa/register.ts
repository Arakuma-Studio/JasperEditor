// Register the service worker only in production web builds. If another tab activates a waiting
// update, reload once it controls this page.
export type SwEnv = { prod: boolean; desktop: boolean; supported: boolean };

function currentSwEnv(): SwEnv {
	return {
		prod: !!import.meta.env?.PROD,
		desktop: typeof window !== 'undefined' && !!(window as { jasperDesktop?: unknown }).jasperDesktop,
		supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
	};
}

/** PROD, not desktop, and the browser supports service workers. */
function shouldRegisterServiceWorker(env: SwEnv = currentSwEnv()): boolean {
	return env.prod && !env.desktop && env.supported;
}

let waiting: ServiceWorker | null = null;
let reloading = false;

function watch(reg: ServiceWorkerRegistration): void {
	if (reg.waiting && navigator.serviceWorker.controller) waiting = reg.waiting;
	reg.addEventListener('updatefound', () => {
		const installing = reg.installing;
		installing?.addEventListener('statechange', () => {
			// A new worker installed while an old one controls the page → an update is waiting.
			if (installing.state === 'installed' && navigator.serviceWorker.controller) waiting = installing;
		});
	});
}

export function registerServiceWorker(env: SwEnv = currentSwEnv()): void {
	if (!shouldRegisterServiceWorker(env)) return;
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (reloading || !waiting) return;
		reloading = true;
		window.location.reload();
	});
	const register = () => {
		navigator.serviceWorker
			.register('/sw.js')
			.then(watch)
			.catch(() => undefined); // failure degrades to a plain web app
	};
	if (document.readyState === 'complete') register();
	else window.addEventListener('load', register, { once: true });
}
