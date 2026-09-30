//! Design canvases and fitting a design canvas into an arbitrary output size.

/// Canvases every template is designed for (16:9, 9:16, 1:1). Other output sizes use the canvas with
/// the closest aspect ratio, scaled uniformly and centered ("contain").
pub const CANVASES: [(u32, u32); 3] = [(1920, 1080), (1080, 1920), (1080, 1080)];

/// `"1920x1080"`-style labels used by `jasper-mg schema` and the TS catalog.
pub fn canvas_labels() -> Vec<String> {
    CANVASES.iter().map(|(w, h)| format!("{w}x{h}")).collect()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    /// Output size in pixels.
    pub out_w: f64,
    pub out_h: f64,
    /// Chosen design canvas.
    pub design_w: f64,
    pub design_h: f64,
    /// Design → output transform: `translate(offset) scale(scale)`.
    pub scale: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

/// Picks the design canvas for an output size (smallest |ln(aspect ratio) difference|, first wins
/// ties) and computes the uniform "contain" transform. TS: `fitCanvas()`.
pub fn fit_canvas(out_w: u32, out_h: u32) -> Fit {
    let (ow, oh) = (f64::from(out_w), f64::from(out_h));
    let ar = (ow / oh).ln();
    let mut best = CANVASES[0];
    let mut best_d = f64::INFINITY;
    for c in CANVASES {
        let d = (ar - (f64::from(c.0) / f64::from(c.1)).ln()).abs();
        if d < best_d - 1e-12 {
            best = c;
            best_d = d;
        }
    }
    let (dw, dh) = (f64::from(best.0), f64::from(best.1));
    let scale = (ow / dw).min(oh / dh);
    Fit {
        out_w: ow,
        out_h: oh,
        design_w: dw,
        design_h: dh,
        scale,
        offset_x: (ow - dw * scale) / 2.0,
        offset_y: (oh - dh * scale) / 2.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_canvases_are_identity() {
        for (w, h) in CANVASES {
            let f = fit_canvas(w, h);
            assert_eq!((f.design_w, f.design_h), (f64::from(w), f64::from(h)));
            assert_eq!((f.scale, f.offset_x, f.offset_y), (1.0, 0.0, 0.0));
        }
    }

    #[test]
    fn other_sizes_scale_and_center() {
        let f = fit_canvas(1280, 720);
        assert_eq!((f.design_w, f.design_h), (1920.0, 1080.0));
        assert!((f.scale - 2.0 / 3.0).abs() < 1e-12);
        let f = fit_canvas(1200, 1080); // 10:9 is closest to 1:1
        assert_eq!((f.design_w, f.design_h), (1080.0, 1080.0));
        assert_eq!(f.scale, 1.0);
        assert_eq!(f.offset_x, 60.0);
        let f = fit_canvas(1440, 1080); // 4:3 is exactly between 16:9 and 1:1: the first canvas wins
        assert_eq!((f.design_w, f.design_h), (1920.0, 1080.0));
        assert_eq!(f.scale, 0.75);
        assert_eq!(f.offset_y, 135.0);
        let f = fit_canvas(720, 1280);
        assert_eq!(f.design_h, 1920.0);
    }
}
