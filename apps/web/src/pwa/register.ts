// Service worker registration (ARCHITECTURE §12, S05:PWA-004/005): only in production web builds, never in
// Electron (window.jasperDesktop) or dev. When a new worker is waiting, subscribers (the shell's toast
// host) show "Update available · Reload"; reloading is always user-initiated and refused while the
// reload guard reports unsaved work.
import { useSyncExternalStore } from 'react';

export type SwEnv = { prod: boolean; desktop: boolean; supported: boolean };

export function currentSwEnv(): SwEnv {
	return {
		prod: !!import.meta.env?.PROD,
		desktop: typeof window !== 'undefined' && !!(window as { jasperDesktop?: unknown }).jasperDesktop,
		supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
	};
}

/** PROD, not desktop, and the browser supports service workers. */
export function shouldRegisterServiceWorker(env: SwEnv = currentSwEnv()): boolean {
	return env.prod && !env.desktop && env.supported;
}

type UpdateState = { available: boolean };
let state: UpdateState = { available: false };
let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();
let reloadGuard: () => boolean = () => true;
let reloading = false;

function setAvailable(worker: ServiceWorker | null): void {
	waiting = worker;
	state = { available: !!worker };
	for (const l of [...listeners]) l();
}

/** Subscribe to "update available" changes (S05:PWA-005). */
export function onServiceWorkerUpdate(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
export function serviceWorkerUpdateState(): UpdateState {
	return state;
}

/** Return false while there are unsaved changes or running browser jobs (reload is then refused). */
export function setReloadGuard(guard: () => boolean): void {
	reloadGuard = guard;
}

/** Activates the waiting worker and reloads once it controls the page. Returns false if refused. */
export function applyServiceWorkerUpdate(): boolean {
	if (!waiting || !reloadGuard()) return false;
	waiting.postMessage({ type: 'SKIP_WAITING' });
	return true;
}

/** React hook for the shell's toast: `{available, reload}`. */
export function useServiceWorkerUpdate(): { available: boolean; reload: () => boolean } {
	const s = useSyncExternalStore(onServiceWorkerUpdate, serviceWorkerUpdateState, serviceWorkerUpdateState);
	return { available: s.available, reload: applyServiceWorkerUpdate };
}

function watch(reg: ServiceWorkerRegistration): void {
	if (reg.waiting && navigator.serviceWorker.controller) setAvailable(reg.waiting);
	reg.addEventListener('updatefound', () => {
		const installing = reg.installing;
		installing?.addEventListener('statechange', () => {
			// A new worker installed while an old one controls the page → an update is waiting.
			if (installing.state === 'installed' && navigator.serviceWorker.controller) setAvailable(installing);
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
