// Register the service worker only in production web builds. If another tab activates a waiting
// update, reload once it controls this page.
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

export function registerServiceWorker(): void {
	if (
		!import.meta.env?.PROD ||
		(typeof window !== 'undefined' && !!window.jasperDesktop) ||
		typeof navigator === 'undefined' ||
		!('serviceWorker' in navigator)
	)
		return;
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
