// S04:IN-013: while an upload (or another client-side job) runs, closing the tab triggers the browser's
// "leave page?" confirmation. Engine-side jobs keep running on the server and need no guard.

export type UnloadGuard = { begin(): () => void };

export function createUnloadGuard(
	target: {
		addEventListener(t: string, cb: (e: Event) => void): void;
		removeEventListener(t: string, cb: (e: Event) => void): void;
	} | null = typeof window !== 'undefined' ? window : null,
): UnloadGuard {
	let active = 0;
	const onBeforeUnload = (e: Event) => {
		e.preventDefault();
		(e as unknown as { returnValue: string }).returnValue = '';
	};
	return {
		begin() {
			if (active++ === 0) target?.addEventListener('beforeunload', onBeforeUnload);
			let done = false;
			return () => {
				if (done) return;
				done = true;
				if (--active === 0) target?.removeEventListener('beforeunload', onBeforeUnload);
			};
		},
	};
}

export const uploadUnloadGuard = createUnloadGuard();
