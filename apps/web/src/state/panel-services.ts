// Cross-panel services (S05:SH-005): panels publish handles (Program player, timeline viewport…)
// keyed by service name and instance id. Callers must tolerate "not mounted".

/** Panels extend this map through declaration merging. */
export interface PanelServiceMap {
	programPlayer: {
		seekTo(frame: number): void;
		play(): void;
		pause(): void;
		getContainer(): HTMLElement | null;
	};
	sourcePlayer: { seekTo(frame: number): void; play(): void; pause(): void };
	timelineViewport: {
		scrollToFrame(frame: number): void;
		frameAtClientX(x: number): number;
		getScrollContainer(): HTMLElement | null;
	};
}
export type PanelServiceName = keyof PanelServiceMap;

type Entries = { [K in PanelServiceName]?: { instanceId: string; service: PanelServiceMap[K] }[] };

export class PanelServices {
	private readonly map: Entries = {};

	/** Publishes a service; returns the unregister function (call it on unmount). */
	register<K extends PanelServiceName>(name: K, instanceId: string, service: PanelServiceMap[K]): () => void {
		const list = (this.map[name] ?? []).filter((e) => e.instanceId !== instanceId);
		const entry = { instanceId, service };
		list.push(entry);
		this.map[name] = list;
		return () => {
			const cur = this.map[name];
			if (!cur) return;
			const next = cur.filter((e) => e !== entry);
			if (next.length) this.map[name] = next;
			else delete this.map[name];
		};
	}

	/** A specific instance, or the most recently mounted one; null when not mounted. */
	get<K extends PanelServiceName>(name: K, instanceId?: string): PanelServiceMap[K] | null {
		const list = this.map[name];
		if (!list?.length) return null;
		const e = instanceId ? list.find((x) => x.instanceId === instanceId) : list.at(-1);
		return e?.service ?? null;
	}
}
