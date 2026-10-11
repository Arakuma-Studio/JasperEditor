// Freeze maps output frames to a reordered scene frame sequence on one renderer page,
// exposing state that persists between seeks.
import type { ComponentType } from 'react';
import { Composition, Freeze, registerRoot, useCurrentFrame } from 'remotion';
import { SequenceComposition } from '../../../compositions/src/SequenceComposition.tsx';
import { PARITY_SCENE, parityDoc } from './doc.ts';
import { reversedOrder, shuffledOrder } from './order.ts';
import type { ParityProps } from './types.ts';

const N = PARITY_SCENE.durationInFrames;

function ordered(Inner: ComponentType<ParityProps>, order: readonly number[]): ComponentType<ParityProps> {
	return function Ordered(props: ParityProps) {
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
const COMPONENTS: [id: string, component: ComponentType<ParityProps>][] = [];
for (const [suffix, order] of ORDERS)
	COMPONENTS.push([`Sequence${suffix}`, order ? ordered(SequenceComposition, order) : SequenceComposition]);

function Root() {
	return (
		<>
			{COMPONENTS.map(([id, component]) => (
				<Composition
					key={id}
					id={id}
					component={component}
					width={PARITY_SCENE.width}
					height={PARITY_SCENE.height}
					fps={PARITY_SCENE.fps}
					durationInFrames={N}
					defaultProps={{
						doc: parityDoc(),
						options: { isPreview: false, useProxies: false, transparentBackground: false },
					}}
				/>
			))}
		</>
	);
}

registerRoot(Root);
