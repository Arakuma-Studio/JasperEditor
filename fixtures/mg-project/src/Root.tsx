// Compositions of the fixture project: 1920×1080 @ 30 fps, transparent backgrounds.
import { Composition } from 'remotion';
import { Badge, type BadgeProps } from './Badge.tsx';
import { lowerThirdSchema, titleSchema } from './jasper-schemas.ts';
import { LowerThird } from './LowerThird.tsx';
import { Title } from './Title.tsx';

export const Root = () => (
	<>
		<Composition
			id="Title"
			component={Title}
			schema={titleSchema}
			width={1920}
			height={1080}
			fps={30}
			durationInFrames={90}
			defaultProps={{ title: 'Hello Jasper', accent: '#ff3366', delay: 6 }}
		/>
		<Composition
			id="LowerThird"
			component={LowerThird}
			schema={lowerThirdSchema}
			width={1920}
			height={1080}
			fps={30}
			durationInFrames={120}
			defaultProps={{
				name: {
					text: 'Ada Lovelace',
					color: '#ffffff',
					fontSize: 84,
					fontFamily: 'Inter',
					fontWeight: 700,
					align: 'left' as const,
				},
				role: 'Mathematician',
				roleColor: '#ffcc33',
				roleSize: 44,
				quote: 'The Analytical Engine weaves algebraic patterns\njust as the Jacquard loom weaves flowers.',
				accent: '#3366ff',
			}}
		/>
		<Composition
			id="Badge"
			component={Badge}
			width={640}
			height={360}
			fps={30}
			durationInFrames={60}
			defaultProps={
				{
					label: 'NEW',
					color: '#22aaff',
					size: 96,
					rounded: true,
					tags: ['fixture', 'badge'],
				} satisfies BadgeProps
			}
		/>
	</>
);
