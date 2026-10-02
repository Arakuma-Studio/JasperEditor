// The "New composition project" template (S08:MGC-015, P1): a Remotion 4.0.499 project with example
// compositions (zod schemas through jasper-schemas.ts), a jasper.mg.json manifest and the Remotion config.
// Kept as data (not files) so packaged engines ship it inside the engine bundle. `{{name}}` is replaced.
// M2 (S11:ANM-016, wp-m2-anime-core): `AnimeTitle` shows anime.js driven by the frame (paused timeline over
// plain objects, canonical seek, no autoplay/timers/randomness) and the README explains the rule.
export const TEMPLATE_FILES: Record<string, string> = {
	'package.json': `{
  "name": "{{name}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Motion graphics for JasperEditor (Remotion 4.0.499). Edit src/, JasperEditor rebuilds on save.",
  "scripts": {
    "studio": "remotion studio",
    "bundle": "remotion bundle"
  },
  "jasper": {
    "schemas": "./src/jasper-schemas.ts"
  },
  "dependencies": {
    "@remotion/cli": "4.0.499",
    "animejs": "4.5.0",
    "react": "19.2.0",
    "react-dom": "19.2.0",
    "remotion": "4.0.499",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "typescript": "~5.9.3"
  }
}
`,
	'remotion.config.ts': `import { Config } from '@remotion/cli/config';

Config.setEntryPoint('src/index.ts');
// PNG frames keep the alpha channel: JasperEditor composites these clips over footage.
Config.setVideoImageFormat('png');
`,
	'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "remotion.config.ts"]
}
`,
	'.gitignore': `node_modules/
out/
build/
`,
	'jasper.mg.json': `{
  "compositions": {
    "LowerThird": {
      "category": "Titles",
      "thumbnailFrame": 30,
      "ui": {
        "accent": { "control": "color" }
      },
      "texts": {
        "name": { "label": "Name", "maxChars": 28 },
        "role": { "label": "Role", "maxChars": 40 }
      }
    },
    "AnimeTitle": {
      "category": "Titles",
      "thumbnailFrame": 45,
      "ui": {
        "color": { "control": "color" }
      }
    }
  }
}
`,
	'README.md': `# {{name}}

Motion graphics for JasperEditor, as a Remotion 4.0.499 project.

- \`src/Root.tsx\` registers the compositions (keep \`remotion\` and every \`@remotion/*\` package at exactly 4.0.499).
- \`src/jasper-schemas.ts\` exports one zod schema per composition id: JasperEditor turns it into the props form.
- \`jasper.mg.json\` adds form hints (\`color\`, \`textarea\`, \`slider\`…), a category and the poster frame.
- Texts: string props become text layers JasperEditor edits in Properties ▸ Composition ▸ Text and on canvas
  (double-click). \`texts\` in \`jasper.mg.json\` sets labels, \`maxChars\` / \`maxLines\`, a safe \`box\` and the
  props that style each text (\`"style": {"color": "nameColor", "fontSize": "nameSize"}\`); a text object
  \`{text, color, fontSize, fontFamily, align}\` or prefixed props (\`nameColor\`, \`nameSize\`) are found
  without it. Fonts you load in the bundle (\`@remotion/fonts\`, \`FontFace\`) are offered in the font menu.
- Transparent backgrounds composite over the footage; JasperEditor renders ProRes 4444 masters for exports.

JasperEditor watches \`src/\`, \`public/\`, \`remotion.config.ts\` and \`jasper.mg.json\` and rebuilds on save.
Preview here with \`npx remotion studio\`.

## Animating with anime.js

JasperEditor renders frames in any order, in parallel and one at a time (scrubbing, stills, exports), so a
composition must be a pure function of its frame. \`src/AnimeTitle.tsx\` shows how to use anime.js 4 that way:
build a timeline with \`autoplay: false\` over plain objects, move it only with the canonical seek of
\`src/anime/title-timeline.ts\` (\`seek(duration)\`, \`seek(0)\`, then \`seek(frame * 1000 / fps)\`, callbacks muted:
a plain \`seek\` depends on the previously visited time) and render inline styles from the values. Never call
\`animate()\`, \`play()\`, timers, \`requestAnimationFrame\`, \`Date.now()\` or \`Math.random()\` (use a seeded
generator), and do not let anime.js write into elements React renders. Keep \`animejs\` pinned exactly.
`,
	'src/index.ts': `import { registerRoot } from 'remotion';
import { Root } from './Root';

registerRoot(Root);
`,
	'src/jasper-schemas.ts': `import { z } from 'zod';

export const lowerThirdSchema = z.object({
	name: z.string().min(1).max(60),
	role: z.string().max(80),
	accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export type LowerThirdProps = z.infer<typeof lowerThirdSchema>;

export const animeTitleSchema = z.object({
	title: z.string().min(1).max(60),
	color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export type AnimeTitleProps = z.infer<typeof animeTitleSchema>;

export default { LowerThird: lowerThirdSchema, AnimeTitle: animeTitleSchema };
`,
	'src/Root.tsx': `import { Composition } from 'remotion';
import { AnimeTitle } from './AnimeTitle';
import { animeTitleSchema, lowerThirdSchema } from './jasper-schemas';
import { LowerThird } from './LowerThird';

export const Root = () => (
	<>
		<Composition
			id="LowerThird"
			component={LowerThird}
			schema={lowerThirdSchema}
			width={1920}
			height={1080}
			fps={30}
			durationInFrames={120}
			defaultProps={{ name: 'Jane Doe', role: 'Director', accent: '#3e99f5' }}
		/>
		<Composition
			id="AnimeTitle"
			component={AnimeTitle}
			schema={animeTitleSchema}
			width={1920}
			height={1080}
			fps={30}
			durationInFrames={90}
			defaultProps={{ title: 'Hello anime.js', color: '#ffffff' }}
		/>
	</>
);
`,
	'src/LowerThird.tsx': `import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { LowerThirdProps } from './jasper-schemas';

export const LowerThird = ({ name, role, accent }: LowerThirdProps) => {
	const frame = useCurrentFrame();
	const { fps, durationInFrames } = useVideoConfig();
	const enter = spring({ frame, fps, config: { damping: 200 } });
	const exit = interpolate(frame, [durationInFrames - 12, durationInFrames], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});
	return (
		<AbsoluteFill style={{ backgroundColor: 'transparent' }}>
			<div
				style={{
					position: 'absolute',
					left: 120,
					bottom: 140,
					padding: '24px 40px',
					borderRadius: 16,
					background: 'rgba(12, 18, 32, 0.72)',
					borderLeft: \`10px solid \${accent}\`,
					color: 'white',
					fontFamily: 'sans-serif',
					opacity: enter * (1 - exit),
					transform: \`translateX(\${(1 - enter) * -60}px)\`,
				}}
			>
				<div style={{ fontSize: 64, fontWeight: 800 }}>{name}</div>
				<div style={{ fontSize: 36, opacity: 0.85 }}>{role}</div>
			</div>
		</AbsoluteFill>
	);
};
`,
	'src/anime/title-timeline.ts': `// anime.js driven by the frame: a paused timeline over plain objects, moved only by the canonical seek.
import { createTimeline, type Timeline } from 'animejs/timeline';
import { stagger } from 'animejs/utils';

export type Glyph = { y: number; opacity: number; rotate: number };

/** One paused timeline over fresh plain objects (one per character); pure, rebuild when the text changes. */
export function buildTitleTimeline(count: number): { timeline: Timeline; glyphs: Glyph[] } {
	const glyphs = Array.from({ length: count }, () => ({ y: 60, opacity: 0, rotate: -12 }));
	const timeline = createTimeline({ autoplay: false });
	if (count > 0)
		timeline.add(
			glyphs,
			{ y: [60, 0], opacity: [0, 1], rotate: [-12, 0], duration: 700, delay: stagger(45), ease: 'outBack' },
			0,
		);
	return { timeline, glyphs };
}

/** History-independent seek: the values depend on \`ms\` only, never on the frames visited before. */
export function seekCanonical(timeline: Timeline, ms: number): void {
	timeline.seek(timeline.duration, true);
	timeline.seek(0, true);
	timeline.seek(ms, true);
}
`,
	'src/AnimeTitle.tsx': `import { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { buildTitleTimeline, seekCanonical } from './anime/title-timeline';
import type { AnimeTitleProps } from './jasper-schemas';

/** Characters as the user sees them (emoji and accents stay whole). */
const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);

export const AnimeTitle = ({ title, color }: AnimeTitleProps) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const chars = useMemo(() => graphemes(title), [title]);
	const built = useMemo(() => buildTitleTimeline(chars.length), [chars]);
	// Seek during render and copy the values: the frame is the only input.
	seekCanonical(built.timeline, (frame * 1000) / fps);
	const glyphs = built.glyphs.map((g) => ({ ...g }));
	return (
		<AbsoluteFill style={{ backgroundColor: 'transparent', justifyContent: 'center', alignItems: 'center' }}>
			<div style={{ color, fontFamily: 'sans-serif', fontSize: 120, fontWeight: 800, whiteSpace: 'pre' }}>
				{chars.map((c, i) => (
					<span
						key={i}
						style={{
							display: 'inline-block',
							opacity: glyphs[i]!.opacity,
							transform: \`translateY(\${glyphs[i]!.y}px) rotate(\${glyphs[i]!.rotate}deg)\`,
						}}
					>
						{c}
					</span>
				))}
			</div>
		</AbsoluteFill>
	);
};
`,
};
