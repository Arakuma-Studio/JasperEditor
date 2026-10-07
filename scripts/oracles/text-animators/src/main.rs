// Oracle generator for packages/project/test/fixtures/text-selectors-oracle.json (workstream text-animators).
// Copy `crates/text/src/selectors.rs` and `crates/text/src/path_text.rs` from EffectCraft
// (https://github.com/storytold/effectcraft, MIT OR Apache-2.0) into `src/`, then
// `cargo run --release > ../../../packages/project/test/fixtures/text-selectors-oracle.json`.
mod selectors;
mod path_text;
use selectors::*;
use serde_json::{json, Value};

fn main() {
    let shapes = [Shape::Square, Shape::RampUp, Shape::RampDown, Shape::Triangle, Shape::Round, Shape::Smooth];
    let shape_names = ["square", "rampUp", "rampDown", "triangle", "round", "smooth"];
    let mut range_cases: Vec<Value> = vec![];
    let params = [
        (0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0),
        (0.0, 0.375, 0.0, 1.0, 1.0, 0.0, 0.0),
        (0.0, 0.375, 0.0, 1.0, 0.0, 0.0, 0.0),
        (0.2, 0.6, 0.1, 0.8, 0.5, 0.3, -0.4),
        (0.7, 0.2, -0.3, -0.5, 0.25, -1.0, 1.0),
        (0.5, 0.5, 0.0, 1.0, 1.0, 0.0, 0.0),
        (-1.0, 0.0, 0.6, 1.0, 1.0, 0.5, 0.5),
    ];
    for (si, sh) in shapes.iter().enumerate() {
        for p in params.iter() {
            let r = Range { start: p.0, end: p.1, offset: p.2, amount: p.3, shape: *sh, smoothness: p.4, ease_high: p.5, ease_low: p.6 };
            for n in [1usize, 4, 7] {
                let vals: Vec<f64> = (0..n).map(|i| range_value(&r, i, n)).collect();
                range_cases.push(json!({"start": p.0, "end": p.1, "offset": p.2, "amount": p.3, "shape": shape_names[si], "smoothness": p.4, "easeHigh": p.5, "easeLow": p.6, "n": n, "values": vals}));
            }
        }
    }
    let mut ease_cases = vec![];
    for (h, l) in [(1.0, 1.0), (0.0, 1.0), (1.0, 0.0), (-1.0, 0.5), (0.3, -0.7)] {
        let vals: Vec<f64> = (0..=10).map(|i| ease(i as f64 / 10.0, h, l)).collect();
        ease_cases.push(json!({"high": h, "low": l, "values": vals}));
    }
    let mut splits = vec![];
    for x in [0u64, 1, 42, 0xDEADBEEF, u64::MAX] {
        splits.push(json!({"x": x.to_string(), "out": splitmix(x).to_string()}));
    }
    let mut orders = vec![];
    for (n, seed) in [(5usize, 0u64), (20, 7), (20, 8), (13, 0x1234_5678_9ABC)] {
        orders.push(json!({"n": n, "seed": seed.to_string(), "perm": random_order(n, seed)}));
    }
    let mut noises = vec![];
    for (x, seed, ch) in [(0.0, 0u64, 0u64), (1.25, 3, 1), (-2.7, 99, 2), (10.5, 0xABCDEF, 5)] {
        noises.push(json!({"x": x, "seed": seed.to_string(), "channel": ch.to_string(), "v": noise1(x, seed, ch)}));
    }
    let mut wigglies = vec![];
    let ws = [
        Wiggly { seed: 3, ..Default::default() },
        Wiggly { seed: 3, correlation: 1.0, ..Default::default() },
        Wiggly { seed: 77, correlation: 0.0, lock_dimensions: true, min: 0.0, max: 1.0, wiggles_per_second: 5.0, temporal_phase: 45.0, spatial_phase: 90.0 },
    ];
    for w in ws.iter() {
        let mut samples = vec![];
        for (t, i, d) in [(0.0, 0usize, 0usize), (1.234, 5, 0), (1.234, 5, 1), (0.7, 9, 2), (3.3, 2, 1)] {
            samples.push(json!({"t": t, "i": i, "dim": d, "v": wiggly_value(w, t, i, d)}));
        }
        wigglies.push(json!({"max": w.max, "min": w.min, "wigglesPerSecond": w.wiggles_per_second, "correlation": w.correlation, "temporalPhase": w.temporal_phase, "spatialPhase": w.spatial_phase, "lockDimensions": w.lock_dimensions, "seed": w.seed.to_string(), "samples": samples}));
    }
    let mut combines = vec![];
    let modes = [Mode::Add, Mode::Subtract, Mode::Intersect, Mode::Min, Mode::Max, Mode::Difference];
    let mode_names = ["add", "subtract", "intersect", "min", "max", "difference"];
    for (mi, m) in modes.iter().enumerate() {
        for (a, v) in [(0.5, 0.75), (1.0, 0.25), (0.3, 0.6), (-0.4, 0.9), (0.9, -0.9)] {
            combines.push(json!({"mode": mode_names[mi], "initial": m.initial(), "acc": a, "v": v, "out": m.combine(a, v)}));
        }
    }
    // path text
    let mut p = kurbo::BezPath::new();
    p.move_to((0.0, 0.0));
    p.line_to((100.0, 0.0));
    p.line_to((100.0, 50.0));
    let m = path_text::PathMeasure::new(&p, false);
    let r = path_text::PathMeasure::new(&p, true);
    let mut path_samples = vec![];
    for s in [-10.0, 0.0, 30.0, 100.0, 120.0, 160.0] {
        let (q, t) = m.at(s);
        let (qr, tr) = r.at(s);
        let (pp, ang) = path_text::place(&m, s, 10.0, true);
        let (pn, angn) = path_text::place(&m, s, 10.0, false);
        path_samples.push(json!({"s": s, "p": [q.x, q.y], "t": [t.x, t.y], "pr": [qr.x, qr.y], "tr": [tr.x, tr.y], "place": [pp.x, pp.y, ang], "placeFlat": [pn.x, pn.y, angn]}));
    }
    let mut arcs = vec![];
    let xs = [0.0, 10.0, 20.0, 35.0];
    for (align, fm, lm, force) in [(0u8, 5.0, 0.0, false), (1, 0.0, 0.0, false), (2, 0.0, 10.0, false), (0, 10.0, 10.0, true), (1, 3.0, 7.0, true)] {
        arcs.push(json!({"align": align, "first": fm, "last": lm, "force": force, "out": path_text::arc_positions(&xs, [0.0, 40.0], align, 100.0, fm, lm, force)}));
    }
    let out = json!({"range": range_cases, "ease": ease_cases, "splitmix": splits, "randomOrder": orders, "noise": noises, "wiggly": wigglies, "combine": combines, "path": {"samples": path_samples, "arcs": arcs, "xs": xs}});
    println!("{}", serde_json::to_string(&out).unwrap());
}
