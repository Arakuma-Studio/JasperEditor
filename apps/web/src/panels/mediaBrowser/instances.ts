// Mounted Media Browser panels (one instance): File ▸ Import from Media Browser and the panel menu act on it.

export interface MediaBrowserHandle {
	/** Absolute paths of the selected files (folders excluded). */
	selectedFiles(): string[];
	/** Imports the selected files into the active bin; resolves with the number imported. */
	importSelected(): Promise<number>;
	goUp(): void;
	refresh(): void;
	toggleAllFiles(): void;
	showsAllFiles(): boolean;
}

let current: MediaBrowserHandle | null = null;

export function registerMediaBrowser(handle: MediaBrowserHandle): () => void {
	current = handle;
	return () => {
		if (current === handle) current = null;
	};
}

export function getMediaBrowser(): MediaBrowserHandle | null {
	return current;
}
