// Media registration, status, derivatives and serving routes (ARCHITECTURE §9.2). Owner: WP-2F. WP-00 stub answering 501 until WP-2F implements it.
import type { FastifyInstance } from 'fastify';
import { registerStubRoutes } from './stub.ts';

export default async function mediaRoutes(app: FastifyInstance): Promise<void> {
	registerStubRoutes(app, [
		'mediaRegister',
		'mediaStatus',
		'mediaDerivatives',
		'mediaFile',
		'mediaProxy',
		'mediaPoster',
		'mediaSpriteIndex',
		'mediaSpriteSheet',
		'mediaPeaksHeader',
		'mediaPeaksStream',
	]);
}
