import type { SessionState } from '@jasper/session';

export const EMPTY_SESSION_STORE = {
	getState: (): SessionState | null => null,
	subscribe: () => () => {},
};
