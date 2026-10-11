import { useRef, useState } from 'react';

export function useDialogClose<T>(close: (result?: T) => void) {
	const [open, setOpen] = useState(true);
	const finished = useRef(false);
	return {
		open,
		finish(result?: T) {
			if (finished.current) return;
			finished.current = true;
			setOpen(false);
			close(result);
		},
	};
}
