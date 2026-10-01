// Native clipboard events that did not come from our shortcuts (browser Edit menu, the macOS app menu roles of
// Electron, assistive tech): outside text fields they run the Edit commands of the focused panel, with the event
// so a copy writes into it and a paste reads from it (S01:CLB-002). Text fields keep their native behaviour.
import { classifyTarget } from '../shell/keymap/dispatcher.ts';
import { readClipboardEvent } from './system.ts';

export function installClipboardEvents(
	win: Window,
	run: (commandId: string, args: unknown) => void,
): () => void {
	const handler = (id: 'edit.copy' | 'edit.cut' | 'edit.paste') => (e: Event) => {
		const ce = e as ClipboardEvent;
		if (ce.defaultPrevented) return;
		const kind = classifyTarget(ce.target);
		if (kind === 'editable' || kind === 'overlay') return;
		if (id === 'edit.paste') {
			ce.preventDefault();
			run(id, { clipboard: readClipboardEvent(ce) });
		} else run(id, { event: ce });
	};
	const copy = handler('edit.copy');
	const cut = handler('edit.cut');
	const paste = handler('edit.paste');
	win.addEventListener('copy', copy);
	win.addEventListener('cut', cut);
	win.addEventListener('paste', paste);
	return () => {
		win.removeEventListener('copy', copy);
		win.removeEventListener('cut', cut);
		win.removeEventListener('paste', paste);
	};
}
