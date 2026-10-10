// esbuild options shared by scripts/build.mjs and test/bundle.test.ts (the bundle must load: wp fixups).
export const BUILD_OPTIONS = {
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: false,
	legalComments: 'none',
	banner: {
		js: "#!/usr/bin/env node\nimport { createRequire as __jasperCreateRequire } from 'node:module'; const require = __jasperCreateRequire(import.meta.url);",
	},
};
