import type { AutomationMode } from '@jasper/project';

export const MODE_LABELS: Record<AutomationMode, string> = {
	off: 'Off',
	read: 'Read',
	latch: 'Latch',
	touch: 'Touch',
	write: 'Write',
};
