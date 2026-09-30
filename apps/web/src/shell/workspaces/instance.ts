// The window's workspace store (one per window; survives editor remounts so layouts are not reloaded).
import { browserStorage, type ShellStorage } from './storage.ts';
import { WorkspaceStore } from './store.ts';

let instance: WorkspaceStore | null = null;

export function getWorkspaceStore(): WorkspaceStore {
	instance ??= new WorkspaceStore(browserStorage());
	return instance;
}

/** Test helper: replaces the window store (e.g. with memory storage). */
export function resetWorkspaceStore(storage?: ShellStorage | null): WorkspaceStore {
	instance = new WorkspaceStore(storage === undefined ? browserStorage() : storage);
	return instance;
}
