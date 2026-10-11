// the Effects panel's custom bins as the keymap sees them (`effects.newCustomBin` Ctrl+/,
// `effects.deleteCustomItem` Backspace — Premiere's Effects panel commands). The Presets bin registers itself here.

/** Reference of a user bin in the Effects panel's focus state (presets use `preset:<id>`). */
export const BIN_REF_PREFIX = 'preset-bin:';

interface CustomBinsHandle {
	/** Creates a bin (inside the picked bin, else at the top of Presets); false when the library is not available. */
	newBin(): boolean;
	/** The user preset or bin that is picked, if any. */
	focusedCustomItem(): { kind: 'bin' | 'preset'; name: string } | null;
	/** Asks to delete the picked user preset or bin; false when nothing of the user's is picked. */
	deleteFocused(): boolean;
}

let current: CustomBinsHandle | null = null;

export function registerCustomBins(handle: CustomBinsHandle): () => void {
	current = handle;
	return () => {
		if (current === handle) current = null;
	};
}

export function getCustomBins(): CustomBinsHandle | null {
	return current;
}
