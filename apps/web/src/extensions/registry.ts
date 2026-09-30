// Tiny ordered registry used by the M2 UI extension points (ARCHITECTURE §19.10). Registration happens at
// module load of the owning work package's `commands/<area>.ts` (imported by `commands/index.ts` at start-up),
// so no shared list has to be edited when a feature adds an editor, section, overlay or menu entry.
export type Registry<T extends { id: string; order?: number }> = {
	register(entry: T): () => void;
	list(): readonly T[];
	get(id: string): T | undefined;
	/** Subscribe to (un)registrations (HMR, tests). */
	subscribe(cb: () => void): () => void;
};

export function createRegistry<T extends { id: string; order?: number }>(): Registry<T> {
	let entries: T[] = [];
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const l of listeners) l();
	};
	return {
		register(entry) {
			entries = [...entries.filter((e) => e.id !== entry.id), entry].sort(
				(a, b) => (a.order ?? 100) - (b.order ?? 100),
			);
			emit();
			return () => {
				entries = entries.filter((e) => e !== entry);
				emit();
			};
		},
		list: () => entries,
		get: (id) => entries.find((e) => e.id === id),
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
}
