// Vite plugin of the UI-6 i18n transform (apps/web/i18n/transform.mjs): web app and UI kit sources, before React.
import { fileURLToPath } from 'node:url';
import { transformI18n } from './transform.mjs';

const RUNTIME = fileURLToPath(new URL('../src/i18n/runtime.ts', import.meta.url));
const INCLUDE = /[\\/](apps[\\/]web[\\/]src|packages[\\/]ui[\\/]src)[\\/].*\.(tsx|ts)$/;
const EXCLUDE = /[\\/]i18n[\\/]|\.test\.|\.d\.ts$|\.tokens\.ts$/;

export function jasperI18n() {
	return {
		name: 'jasper-i18n',
		enforce: 'pre',
		transform(code, id) {
			const file = id.split('?')[0];
			if (!INCLUDE.test(file) || EXCLUDE.test(file)) return null;
			const out = transformI18n(code, file, RUNTIME);
			return out ? { code: out, map: null } : null;
		},
	};
}
