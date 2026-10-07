// three-d: the Program monitor's 3D views (After Effects' View ▸ Switch 3D View): per sequence, the current view,
// the previous one (Switch to Last 3D View) and the edited view cameras (orbit / pan / dolly in a non-camera view).
// View state, not the document: not undoable, persisted in localStorage.
import { defaultViewCam, VIEWS_3D, type View3D, type ViewCam } from '@jasper/project';
import { createStore } from 'zustand/vanilla';

export type SequenceViews = { view: View3D; last: View3D; cams: Partial<Record<View3D, ViewCam>> };
export type ThreeDViewState = { bySequence: Record<string, SequenceViews> };

const KEY = 'jasper.program.views3d.v1';
const EMPTY: SequenceViews = { view: 'activeCamera', last: 'activeCamera', cams: {} };

function load(): ThreeDViewState {
	try {
		const raw = globalThis.localStorage?.getItem(KEY);
		if (!raw) return { bySequence: {} };
		const v = JSON.parse(raw) as ThreeDViewState;
		const out: ThreeDViewState = { bySequence: {} };
		for (const [id, s] of Object.entries(v.bySequence ?? {})) {
			if (!s || !VIEWS_3D.includes(s.view)) continue;
			out.bySequence[id] = {
				view: s.view,
				last: VIEWS_3D.includes(s.last) ? s.last : 'activeCamera',
				cams: Object.fromEntries(
					Object.entries(s.cams ?? {}).filter(([k, c]) => VIEWS_3D.includes(k as View3D) && validCam(c)),
				),
			};
		}
		return out;
	} catch {
		return { bySequence: {} };
	}
}

function validCam(c: unknown): c is ViewCam {
	const v = c as ViewCam;
	const vec = (x: unknown) => Array.isArray(x) && x.length === 3 && x.every((n) => Number.isFinite(n));
	return !!v && vec(v.eye) && vec(v.poi) && vec(v.down) && Number.isFinite(v.zoom) && v.zoom > 0;
}

export const threeDViews = createStore<ThreeDViewState>(() => load());
threeDViews.subscribe((s) => {
	try {
		globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
	} catch {
		// view state is best-effort
	}
});

export function viewsOf(sequenceId: string | null | undefined): SequenceViews {
	return (sequenceId && threeDViews.getState().bySequence[sequenceId]) || EMPTY;
}

/** The camera of a view (edited or default) for a w×h sequence; null for the active camera view. */
export function viewCamOf(sequenceId: string, view: View3D, w: number, h: number): ViewCam | null {
	if (view === 'activeCamera') return null;
	return viewsOf(sequenceId).cams[view] ?? defaultViewCam(view, w, h);
}

export function switchView(sequenceId: string, view: View3D): void {
	threeDViews.setState((s) => {
		const cur = s.bySequence[sequenceId] ?? EMPTY;
		if (cur.view === view) return s;
		return { bySequence: { ...s.bySequence, [sequenceId]: { ...cur, view, last: cur.view } } };
	});
}

export function setViewCam(sequenceId: string, view: View3D, cam: ViewCam): void {
	if (view === 'activeCamera') return;
	threeDViews.setState((s) => {
		const cur = s.bySequence[sequenceId] ?? EMPTY;
		return { bySequence: { ...s.bySequence, [sequenceId]: { ...cur, cams: { ...cur.cams, [view]: cam } } } };
	});
}

/** View ▸ Reset 3D View: the current view's camera back to its default. */
export function resetView(sequenceId: string): void {
	threeDViews.setState((s) => {
		const cur = s.bySequence[sequenceId] ?? EMPTY;
		const { [cur.view]: _drop, ...cams } = cur.cams;
		return { bySequence: { ...s.bySequence, [sequenceId]: { ...cur, cams } } };
	});
}
