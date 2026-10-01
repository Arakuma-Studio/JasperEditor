//! Easing and spring math. Mirrored 1:1 by `core.ts` in `@jasper/mg-templates`.
//!
//! The templates evaluate their animation here instead of through `fframes::timeline!` so that the
//! TypeScript twin can reproduce the exact same curves (fframes' own easing lives in Rust only).

pub fn clamp01(x: f64) -> f64 {
    if x.is_nan() { 0.0 } else { x.clamp(0.0, 1.0) }
}

/// Linear progress of `t` through `[start, start + duration]`, clamped to `0..=1`.
pub fn progress(t: f64, start: f64, duration: f64) -> f64 {
    if duration <= 0.0 {
        return if t >= start { 1.0 } else { 0.0 };
    }
    clamp01((t - start) / duration)
}

pub fn ease_out_cubic(p: f64) -> f64 {
    let q = 1.0 - clamp01(p);
    1.0 - q * q * q
}

pub fn ease_in_cubic(p: f64) -> f64 {
    let p = clamp01(p);
    p * p * p
}

pub fn ease_in_out_cubic(p: f64) -> f64 {
    let p = clamp01(p);
    if p < 0.5 {
        4.0 * p * p * p
    } else {
        let q = -2.0 * p + 2.0;
        1.0 - q * q * q / 2.0
    }
}

/// Position of a damped spring released at `t = 0` from 0 towards 1 with zero velocity.
/// Closed form of `m·x'' + c·x' + k·(x − 1) = 0` (under-, critically and over-damped).
pub fn spring(t: f64, stiffness: f64, damping: f64, mass: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    let w0 = (stiffness / mass).sqrt();
    let zeta = damping / (2.0 * (stiffness * mass).sqrt());
    if (zeta - 1.0).abs() < 1e-9 {
        return 1.0 - (-w0 * t).exp() * (1.0 + w0 * t);
    }
    if zeta < 1.0 {
        let wd = w0 * (1.0 - zeta * zeta).sqrt();
        let decay = (-zeta * w0 * t).exp();
        return 1.0 - decay * ((wd * t).cos() + (zeta * w0 / wd) * (wd * t).sin());
    }
    let s = w0 * (zeta * zeta - 1.0).sqrt();
    let r1 = -zeta * w0 + s;
    let r2 = -zeta * w0 - s;
    1.0 - (r2 * (r1 * t).exp() - r1 * (r2 * t).exp()) / (r2 - r1)
}
