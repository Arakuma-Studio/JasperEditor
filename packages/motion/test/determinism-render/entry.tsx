// Remotion entry of the render-parity e2e (S11:ANM-014, REMOTION_E2E=1). Compositions:
// - AnimeScene: the fixture scene (determinism-fixtures.tsx) driven by the current frame (scene.tsx);
// - Sequence: the real SequenceComposition with the parity document (inputProps {doc, options});
// - <name>Reversed / <name>Shuffled: output frame i shows frame order[i] through <Freeze>, so one renderer page
//   visits the frames in that order (the history a reused page accumulates is what the canonical seek defeats).
import type { ComponentType } from 'react';
import { Composition, Freeze, registerRoot, useCurrentFrame } from 'remotion';
import { SequenceComposition } from '../../../compositions/src/SequenceComposition.tsx';
import { SCENE } from '../determinism-fixtures.tsx';
import { reversedOrder, shuffledOrder } from './order.ts';
import { AnimeScene } from './scene.tsx';

type AnyProps = Record<string, unknown>;
const N = SCENE.durationInFrames;

function ordered(Inner: ComponentType<AnyProps>, order: readonly number[]): ComponentType<AnyProps> {
	return function Ordered(props: AnyProps) {
		const frame = useCurrentFrame();
		return (
			<Freeze frame={order[frame] ?? frame}>
				<Inner {...props} />
			</Freeze>
		);
	};
}

const ORDERS: [suffix: string, order: readonly number[] | null][] = [
	['', null],
	['Reversed', reversedOrder(N)],
	['Shuffled', shuffledOrder(N)],
];
const COMPONENTS: [id: string, component: ComponentType<AnyProps>][] = [];
for (const [base, Inner] of [
	['AnimeScene', AnimeScene],
	['Sequence', SequenceComposition],
] as [string, ComponentType<AnyProps>][])
	for (const [suffix, order] of ORDERS)
		COMPONENTS.push([base + suffix, order ? ordered(Inner, order) : Inner]);

function Root() {
	return (
		<>
			{COMPONENTS.map(([id, component]) => (
				<Composition
					key={id}
					id={id}
					component={component}
					width={SCENE.width}
					height={SCENE.height}
					fps={SCENE.fps}
					durationInFrames={N}
					defaultProps={{}}
				/>
			))}
		</>
	);
}

registerRoot(Root);
