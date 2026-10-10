// Language epoch for React (workstream polish): a view keyed on it remounts when the UI language changes, so every
// string below it is looked up again; a component that only reads it re-renders its own strings.
import { useSyncExternalStore } from 'react';
import { languageEpoch, subscribeLanguage } from './runtime.ts';

export function useLanguageEpoch(): number {
	return useSyncExternalStore(subscribeLanguage, languageEpoch, languageEpoch);
}
