// Per-entity last-changed revisions per project, for the headless fast-forward rule (S01:AGT-010).
// The engine learns about changes from headless commits and from `doc.changed` events the editor
// forwards over WS /agent. The map is only trusted back to the first revision it saw continuously; an
// older `expectedRevision` (or a gap, e.g. after an engine restart) is rejected as stale.

type Track = { base: number; last: number; revisions: Map<string, number> };

export class RevisionTracker {
	private readonly projects = new Map<string, Track>();

	/** Records a commit that produced `revision` and touched `ids`. */
	observe(projectId: string, revision: number, ids: readonly string[]): void {
		let t = this.projects.get(projectId);
		if (!t || revision !== t.last + 1) {
			// First sighting or a gap: everything before this commit is unknown.
			t = { base: revision - 1, last: revision - 1, revisions: new Map() };
			this.projects.set(projectId, t);
		}
		for (const id of ids) t.revisions.set(id, revision);
		t.last = revision;
	}

	/** Aligns with the stored revision before a headless apply (resets when changes were missed). */
	sync(projectId: string, storedRevision: number): void {
		const t = this.projects.get(projectId);
		if (!t || t.last !== storedRevision)
			this.projects.set(projectId, { base: storedRevision, last: storedRevision, revisions: new Map() });
	}

	/** The revision map if it covers `expectedRevision`, else undefined (→ stale rejection). */
	mapFor(projectId: string, expectedRevision: number | undefined): ReadonlyMap<string, number> | undefined {
		const t = this.projects.get(projectId);
		if (!t) return undefined;
		if (expectedRevision !== undefined && expectedRevision < t.base) return undefined;
		return t.revisions;
	}
}
