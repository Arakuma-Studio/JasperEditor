// Mounted Project panel instances (multi-instance panel). Project-scope UI commands (Ctrl+B, Ctrl+PgUp…)
// act on the focused instance, else the most recently used one.

export type ProjectViewMode = 'list' | 'icon';

export interface ProjectPanelHandle {
	readonly instanceId: string;
	/** The bin shown by the panel (null = project root); imports and New Bin go here. */
	getBinId(): string | null;
	setView(mode: ProjectViewMode): void;
	toggleView(): void;
	zoom(delta: number): void;
	toggleHoverScrub(): void;
	newBin(): void;
	newSequence(): void;
	renameSelection(): void;
	deleteSelection(): void;
	openSelection(): void;
	importIntoBin(): void;
	/** wp-clipboard-2 (Reveal in Project): shows the item's bin, unfiltered, scrolled to the item. */
	reveal?(itemId: string): void;
}

const handles = new Map<string, { handle: ProjectPanelHandle; at: number }>();
let seq = 0;

export function registerProjectPanel(handle: ProjectPanelHandle): () => void {
	handles.set(handle.instanceId, { handle, at: ++seq });
	return () => {
		if (handles.get(handle.instanceId)?.handle === handle) handles.delete(handle.instanceId);
	};
}

/** Marks an instance as the most recently used (pointer/focus inside it). */
export function touchProjectPanel(instanceId: string): void {
	const e = handles.get(instanceId);
	if (e) e.at = ++seq;
}

export function getProjectPanel(instanceId?: string | null): ProjectPanelHandle | null {
	if (instanceId && handles.has(instanceId)) return handles.get(instanceId)!.handle;
	let best: { handle: ProjectPanelHandle; at: number } | null = null;
	for (const e of handles.values()) if (!best || e.at > best.at) best = e;
	return best?.handle ?? null;
}

/** The bin new imports land in (current bin of the active Project panel, else the root). */
export function activeProjectBin(): string | null {
	return getProjectPanel()?.getBinId() ?? null;
}
