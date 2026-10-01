// Compositions of the fixture project: 1920×1080 @ 30 fps, transparent backgrounds.
import { Composition } from 'remotion';
import { Badge, type BadgeProps } from './Badge.tsx';
import { titleSchema } from './jasper-schemas.ts';
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
