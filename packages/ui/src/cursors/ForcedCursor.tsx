// Forced-cursor layer (S05:IC-011, SH-004): while a gesture (trim, drag, scrub, splitter resize) is
// active, its cursor is forced on the whole window through a transparent layer at z 300 so it does not
// flicker when the pointer crosses other elements. Gestures use pointer capture, so the layer never
// steals their events. The layer is removed on pointerup/cancel/blur.
import { useSyncExternalStore } from 'react';
import { CURSORS, type CursorId, cursorCss } from './index.ts';

type Entry = { token: number; cursor: string };
let stack: Entry[] = [];
let nextToken = 1;
const listeners = new Set<() => void>();
let autoReleaseInstalled = false;

function emit() {
	for (const l of [...listeners]) l();
}

function installAutoRelease() {
	if (autoReleaseInstalled || typeof window === 'undefined') return;
	autoReleaseInstalled = true;
	const clear = () => {
		if (stack.length) {
			stack = [];
			emit();
		}
	};
	window.addEventListener('pointerup', clear);
	window.addEventListener('pointercancel', clear);
	window.addEventListener('blur', clear);
}

/**
 * Forces a cursor (a `CursorId` or any CSS cursor value) until `release()` is called or the gesture ends
 * (pointerup/pointercancel/blur). Nested calls stack; the newest wins.
 */
export function forceCursor(cursor: CursorId | (string & {})): () => void {
	installAutoRelease();
	const css = cursor in CURSORS ? cursorCss(cursor as CursorId) : cursor;
	const token = nextToken++;
	stack = [...stack, { token, cursor: css }];
	emit();
	return () => {
		const before = stack.length;
		stack = stack.filter((e) => e.token !== token);
		if (stack.length !== before) emit();
	};
}

/** The currently forced CSS cursor, or null. */
export function getForcedCursor(): string | null {
	return stack.at(-1)?.cursor ?? null;
}

function subscribe(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}

/** Mount once per window (S05:SH-004). */
export function ForcedCursorLayer() {
	const cursor = useSyncExternalStore(subscribe, getForcedCursor, getForcedCursor);
	if (!cursor) return null;
	return (
		<div
			aria-hidden
			data-testid="forced-cursor"
			className="fixed inset-0 z-[var(--pr-z-forced-cursor)]"
			style={{ cursor }}
		/>
	);
}
