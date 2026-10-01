// The "New composition project" template (S08:MGC-015, P1): a Remotion 4.0.499 project with one example
// composition (zod schema through jasper-schemas.ts), a jasper.mg.json manifest and the Remotion config.
// Kept as data (not files) so packaged engines ship it inside the engine bundle. `{{name}}` is replaced.
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
- Transparent backgrounds composite over the footage; JasperEditor renders ProRes 4444 masters for exports.

JasperEditor watches \`src/\`, \`public/\`, \`remotion.config.ts\` and \`jasper.mg.json\` and rebuilds on save.
Preview here with \`npx remotion studio\`.
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

export default { LowerThird: lowerThirdSchema };
`,
	'src/Root.tsx': `import { Composition } from 'remotion';
import { lowerThirdSchema } from './jasper-schemas';
import { LowerThird } from './LowerThird';

export const Root = () => (
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
};
