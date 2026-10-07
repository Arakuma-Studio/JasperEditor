// edit-structure: show children at a fixed frame of their own axis. Remotion's <Freeze frame> sets an absolute
// timeline frame, which is clamped to the composition's range (a 1-frame still, or a nested sequence longer than
// the parent, would show the wrong frame). This keeps the absolute frame where it is and shifts the children's axis
// with a <Sequence> instead. `frame` must be ≥ 0 (children before their axis start are not shown by Sequences).
import type { ReactNode } from 'react';
import { Freeze, Sequence, useCurrentFrame } from 'remotion';

export function ShowFrame({ frame, children }: { frame: number; children?: ReactNode }) {
	const cur = useCurrentFrame();
	return (
		<Freeze frame={cur}>
			<Sequence from={cur - frame} layout="none" name="Frame">
				{children}
			</Sequence>
		</Freeze>
	);
}
