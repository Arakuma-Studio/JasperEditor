// Remotion bundles as clips (M2, S08, ARCHITECTURE §19.3). Owner: wp-m2-mg. Stubs answer 501 until implemented.
// Also where the work package registers the `mg` native extension (composition pre-renders; hybrid text).
import type { FastifyInstance } from 'fastify';
import { registerStubRoutes } from './stub.ts';

export default async function mgBundleRoutes(app: FastifyInstance): Promise<void> {
	registerStubRoutes(app, [
		'mgBundleImport',
		'mgBundleRebuild',
		'mgBundlePrerender',
		'mgBundlePrerenderGet',
		'mgBundleFiles',
	]);
}
