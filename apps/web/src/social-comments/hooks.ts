// Session reads shared by the social-comment controls: the static params of every selected clip (sibling values such
// as `timeUnit` can differ between clips even when the row's own value does not) and the project's media.
import type { MediaAsset, ProjectDocument } from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import type { Params } from './params.ts';

const NO_SESSION_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };
const EMPTY: readonly Params[] = [];
const NO_MEDIA: Readonly<Record<string, MediaAsset>> = {};

const sameList = (a: readonly Params[], b: readonly Params[]) =>
	a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

const isRecord = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v);

function paramsIn(doc: ProjectDocument, activeSequenceId: string | null, clipId: string): Params | null {
	const active = activeSequenceId ? doc.sequences[activeSequenceId] : undefined;
	const clip = active?.clips[clipId] ?? Object.values(doc.sequences).find((s) => s.clips[clipId])?.clips[clipId];
	const p = (clip as { params?: unknown } | undefined)?.params;
	return isRecord(p) ? p : null;
}

/** The static params of `clipIds` (clips that are gone are left out); `fallback` without a session. */
export function useClipsParams(clipIds: readonly string[], fallback: Params): readonly Params[] {
	const session = useSessionOrNull();
	const key = clipIds.join(',');
	const list = useStoreSelector(
		session?.store ?? NO_SESSION_STORE,
		(st: SessionState | null) => {
			if (!st) return EMPTY;
			const out: Params[] = [];
			for (const id of key ? key.split(',') : []) {
				const p = paramsIn(st.document, st.activeSequenceId, id);
				if (p) out.push(p);
			}
			return out;
		},
		sameList,
	);
	return list.length ? list : [fallback];
}

/** The value of `name` shared by every params object, or `mixed`. */
export function shared(list: readonly Params[], name: string): { mixed: boolean; value: unknown } {
	const first = list[0]?.[name];
	const same = (a: unknown, b: unknown) => {
		if (Object.is(a, b)) return true;
		try {
			return JSON.stringify(a) === JSON.stringify(b);
		} catch {
			return false;
		}
	};
	const mixed = list.some((p) => !same(p[name], first));
	return { mixed, value: mixed ? null : first };
}

/** The project's media assets (empty without a session). */
export function useProjectMedia(): Readonly<Record<string, MediaAsset>> {
	const session = useSessionOrNull();
	return useStoreSelector(session?.store ?? NO_SESSION_STORE, (st: SessionState | null) =>
		st ? st.document.media : NO_MEDIA,
	);
}

/** The project document (null without a session). */
export function useProjectDocument(): ProjectDocument | null {
	const session = useSessionOrNull();
	return useStoreSelector(session?.store ?? NO_SESSION_STORE, (st: SessionState | null) => st?.document ?? null);
}
