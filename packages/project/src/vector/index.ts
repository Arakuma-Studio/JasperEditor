// Vector shapes (wp shapes): the high-level API at the package root; the geometry kernel and path operators as
// namespaces (`shapeGeom`, `shapeOps`, `shapeBoolean`) so their short helper names stay out of the root namespace.
export * as shapeBoolean from './boolean.ts';
export * from './defaults.ts';
export * from './evaluate.ts';
export * as shapeGeom from './geom.ts';
export type { Affine, BezPath, Bounds, Cubic, SubPath } from './geom.ts';
export * as shapeOps from './ops.ts';
export * from './primitives.ts';
export * from './values.ts';
export * from './input.ts';
export * from './properties.ts';
export * from './svg-path.ts';
export * from './presets.ts';
export * from './summary.ts';
