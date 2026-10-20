// Vector shapes (wp shapes): the high-level API at the package root; the geometry kernel and path operators as
// namespaces (`shapeGeom`, `shapeOps`, `shapeBoolean`) so their short helper names stay out of the root namespace.
export * as shapeBoolean from './boolean.ts';
export * from './defaults.ts';
export * from './evaluate.ts';
export type { Affine as ShapeAffine, BezPath, Bounds, SubPath } from './geom.ts';
export * as shapeGeom from './geom.ts';
export * from './input.ts';
export * as shapeOps from './ops.ts';
export * from './presets.ts';
export * from './primitives.ts';
export * from './properties.ts';
export * from './render-plan.ts';
export * from './summary.ts';
export * from './svg-import.ts';
export * from './svg-path.ts';
export * from './trim-animate.ts';
export * from './values.ts';
