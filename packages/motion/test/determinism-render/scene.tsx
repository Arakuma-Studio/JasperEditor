// The fixture scene of the render-parity e2e (S11:ANM-014) as a Remotion component, shared by the renderer entry and
// the Player page: like SequenceComposition, its root is repainted from scratch on every rendered (and paused) frame
// (`FrameRepaint`, packages/compositions/src/repaint.tsx), so the captured pixels never depend on the frames a page
// painted before.
import { useRef } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { FrameRepaint } from '../../../compositions/src/repaint.tsx';
import { FixtureScene } from '../determinism-fixtures.tsx';

export function AnimeScene() {
	const root = useRef<HTMLDivElement>(null);
	return (
		<AbsoluteFill ref={root}>
			<FixtureScene frame={useCurrentFrame()} />
			<FrameRepaint target={root} />
		</AbsoluteFill>
	);
}
