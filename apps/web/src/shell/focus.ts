// Focus model (S05 §7, FO-001…007): exactly one focused panel instance per window. Focus moves on
// pointerdown anywhere inside a panel (capture phase, before the panel's handlers), on focusin from
// keyboard navigation, when a tab is activated and through focus commands. Menus, dialogs, popovers and
// toasts are portaled outside panels, so opening them never moves panel focus (FO-004).
import { PANEL_KINDS, type PanelKind } from '../panels/types.ts';

export type FocusState = {
	instanceId: string | null;
	kind: PanelKind | null;
	/** Last focused instance per kind ("last Timeline", "last monitor"; FO-006). */
	lastByKind: Partial<Record<PanelKind, string>>;
	/** Last focused monitor kind (program/source). */
	lastMonitor: 'program' | 'source' | null;
};

export const PANEL_INSTANCE_ATTR = 'data-panel-instance';
export const PANEL_KIND_ATTR = 'data-panel-kind';

const KINDS = new Set<string>(PANEL_KINDS);

export class FocusStore {
	private state: FocusState = { instanceId: null, kind: null, lastByKind: {}, lastMonitor: null };
	private readonly listeners = new Set<() => void>();

	getState = (): FocusState => this.state;
	subscribe = (l: () => void): (() => void) => {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	};

	focus(instanceId: string | null, kind: PanelKind | null): void {
		if (instanceId === this.state.instanceId && kind === this.state.kind) return;
		const lastByKind =
			kind && instanceId ? { ...this.state.lastByKind, [kind]: instanceId } : this.state.lastByKind;
		const lastMonitor = kind === 'program' || kind === 'source' ? kind : this.state.lastMonitor;
		this.state = { instanceId, kind, lastByKind, lastMonitor };
		for (const l of [...this.listeners]) l();
	}

	clear(): void {
		this.focus(null, null);
	}
}

/** The window's focus store. */
export const focusStore = new FocusStore();

/** Finds the panel instance an element belongs to (dock content or tab). */
export function panelFromElement(el: Element | null): { instanceId: string; kind: PanelKind } | null {
	const host = el?.closest?.(`[${PANEL_INSTANCE_ATTR}]`);
	if (!host) return null;
	const instanceId = host.getAttribute(PANEL_INSTANCE_ATTR);
	const kind = host.getAttribute(PANEL_KIND_ATTR);
	if (!instanceId || !kind || !KINDS.has(kind)) return null;
	return { instanceId, kind: kind as PanelKind };
}

/** Last pointer position (for "maximize the group under the pointer", DK-040). */
export const pointer = { x: -1, y: -1 };

/**
 * Installs the capture-phase focus listeners on a document (FO-001). Returns the uninstaller.
 */
export function installFocusTracking(doc: Document, store: FocusStore = focusStore): () => void {
	const onPointer = (e: Event) => {
		const hit = panelFromElement(e.target as Element | null);
		if (hit) store.focus(hit.instanceId, hit.kind);
	};
	const onMove = (e: PointerEvent) => {
		pointer.x = e.clientX;
		pointer.y = e.clientY;
	};
	doc.addEventListener('pointerdown', onPointer, true);
	doc.addEventListener('focusin', onPointer, true);
	doc.addEventListener('pointermove', onMove, { capture: true, passive: true });
	return () => {
		doc.removeEventListener('pointerdown', onPointer, true);
		doc.removeEventListener('focusin', onPointer, true);
		doc.removeEventListener('pointermove', onMove, true);
	};
}

/** Panel under the last known pointer position. */
export function panelUnderPointer(doc: Document = document): { instanceId: string; kind: PanelKind } | null {
	if (pointer.x < 0 || typeof doc.elementFromPoint !== 'function') return null;
	return panelFromElement(doc.elementFromPoint(pointer.x, pointer.y));
}
