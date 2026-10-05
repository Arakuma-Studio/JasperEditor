// The window's workspace store (one per window; survives editor remounts so layouts are not reloaded).
import { browserStorage } from './storage.ts';
import { WorkspaceStore } from './store.ts';

let instance: WorkspaceStore | null = null;

export function getWorkspaceStore(): WorkspaceStore {
	instance ??= new WorkspaceStore(browserStorage());
	return instance;
}
