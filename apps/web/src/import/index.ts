// Import pipeline (client side): see service.ts. Public surface for panels and commands.
import { useSyncExternalStore } from 'react';
import { getImportService, type ImportService, subscribeImportService } from '../state/services.ts';

export * from './assets.ts';
export * from './client-jobs.ts';
export * from './desktop.ts';
export * from './media-runtime.ts';
export * from './prompts.ts';
export * from './service.ts';
export * from './transaction.ts';
export * from './unload-guard.ts';

/** The ImportService of the open project (null on Home). */
export function useImportService(): ImportService | null {
	return useSyncExternalStore(subscribeImportService, getImportService, getImportService);
}
