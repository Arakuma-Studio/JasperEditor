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

pub fn mix(a: f64, b: f64, p: f64) -> f64 {
    a + (b - a) * p
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn easings_hit_their_endpoints() {
        for f in [ease_out_cubic, ease_in_cubic, ease_in_out_cubic] {
            assert_eq!(f(0.0), 0.0);
            assert_eq!(f(1.0), 1.0);
            assert_eq!(f(-3.0), 0.0);
            assert_eq!(f(7.0), 1.0);
        }
        assert!((ease_in_out_cubic(0.5) - 0.5).abs() < 1e-12);
        assert_eq!(progress(1.0, 1.0, 0.0), 1.0);
        assert_eq!(progress(0.5, 1.0, 0.0), 0.0);
        assert_eq!(progress(1.5, 1.0, 1.0), 0.5);
    }

    #[test]
    fn springs_start_at_zero_and_settle_at_one() {
        for (k, c) in [(180.0, 20.0), (100.0, 20.0), (100.0, 40.0)] {
            assert_eq!(spring(0.0, k, c, 1.0), 0.0);
            assert!(spring(0.01, k, c, 1.0) < 0.05);
            assert!((spring(5.0, k, c, 1.0) - 1.0).abs() < 1e-4, "k={k} c={c}");
        }
        // under-damped springs overshoot
        assert!((0..200).any(|i| spring(f64::from(i) / 100.0, 180.0, 12.0, 1.0) > 1.0));
    }
}
