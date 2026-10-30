//! `anatomy/volume.ts`: a body part as a collision surface, and the query on it.
//!
//! `measureVolume` and `partSkin`, which bin the mesh into the table, stay in TS; their result
//! arrives as [`MeasuredVolume`] in the profile.

use core::f64::consts::PI;

use crate::math::f::{js_max, js_min};

/// A body part as a collision surface: a radius per (height band, angular
/// sector) in some frame of its own, plus the height range that grid spans.
///
/// `r` is `None` on a fallback volume that was never measured off the mesh — the
/// plain cylinder of `radius` the trunk falls back to when a rig has no usable
/// skin weights. `bands` and `sectors` are not read in that case.
///
/// `bands` and `sectors` are counts but stay `f64`, as in TS, because the query does its index
/// arithmetic in floating point.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MeasuredVolume {
    pub r: Option<Vec<f32>>,
    pub bands: f64,
    pub sectors: f64,
    pub top: f64,
    pub bottom: f64,
    pub radius: f64,
}

/// Derivatives of the radius table in metres per height metre and per radian.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SurfaceGradient {
    pub height: f64,
    pub bearing: f64,
}

/// `tr[i]` as a JS `Float32Array` reads it: `undefined`, so NaN, off the table.
fn cell(tr: &[f32], i: f64) -> f64 {
    if i >= 0.0 && i < tr.len() as f64 && i == i.trunc() {
        f64::from(tr[i as usize])
    } else {
        f64::NAN
    }
}

// volume.ts surfaceOf
//
// Radius of one volume at a height and bearing in its own frame.
pub fn surface_of(
    t: &MeasuredVolume,
    h: f64,
    theta: f64,
    gradient: Option<&mut SurfaceGradient>,
) -> f64 {
    let Some(tr) = &t.r else {
        if let Some(gradient) = gradient {
            gradient.height = 0.0;
            gradient.bearing = 0.0;
        }
        return t.radius;
    };
    let raw_band = ((h - t.bottom) / (t.top - t.bottom)) * t.bands - 0.5;
    let fb = js_min(t.bands - 1.0, js_max(0.0, raw_band));
    let b0 = fb.floor();
    let b1 = js_min(t.bands - 1.0, b0 + 1.0);
    let tb = fb - b0;
    let mut a = theta / (PI * 2.0);
    a -= a.floor();
    let fs = a * t.sectors - 0.5;
    let s0 = ((fs.floor() % t.sectors) + t.sectors) % t.sectors;
    let s1 = (s0 + 1.0) % t.sectors;
    let ts = fs - fs.floor();
    // The cell's four corners, read once rather than through a per-call closure.
    let r00 = cell(tr, b0 * t.sectors + s0);
    let r01 = cell(tr, b0 * t.sectors + s1);
    let r10 = cell(tr, b1 * t.sectors + s0);
    let r11 = cell(tr, b1 * t.sectors + s1);
    if let Some(gradient) = gradient {
        // The selected cell also fixes the one-sided derivative at a table knot.
        // Clamped half-bands have constant radius in height.
        gradient.height = if raw_band > 0.0 && raw_band < t.bands - 1.0 {
            ((r10 * (1.0 - ts) + r11 * ts - (r00 * (1.0 - ts) + r01 * ts)) * t.bands)
                / (t.top - t.bottom)
        } else {
            0.0
        };
        gradient.bearing = (((r01 - r00) * (1.0 - tb) + (r11 - r10) * tb) * t.sectors) / (PI * 2.0);
    }
    (r00 * (1.0 - ts) + r01 * ts) * (1.0 - tb) + (r10 * (1.0 - ts) + r11 * ts) * tb
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus_replay::Corpus;

    fn close(a: f64, b: f64, digits: i32) {
        let tolerance = 10f64.powi(-digits) / 2.0;
        assert!((a - b).abs() < tolerance, "{a} is not close to {b}");
    }

    #[test]
    fn keeps_table_derivatives_periodic_height_clamped_and_neutral_for_a_cylinder() {
        let volume = MeasuredVolume {
            r: Some(vec![1.0, 2.0, 4.0, 3.0, 2.0, 3.0, 5.0, 4.0]),
            bands: 2.0,
            sectors: 4.0,
            bottom: 0.0,
            top: 2.0,
            radius: 3.0,
        };
        let mut gradient = SurfaceGradient {
            height: f64::NAN,
            bearing: f64::NAN,
        };
        let mut repeated = gradient;
        for height in [0.0, 0.5, 1.0, 1.5, 2.0] {
            let radius = surface_of(&volume, height, -0.2, Some(&mut gradient));
            close(
                surface_of(&volume, height, PI * 2.0 - 0.2, Some(&mut repeated)),
                radius,
                12,
            );
            close(repeated.height, gradient.height, 12);
            close(repeated.bearing, gradient.bearing, 12);
            let expected = if height > 0.5 && height < 1.5 {
                1.0
            } else {
                0.0
            };
            assert_eq!(gradient.height, expected, "{height}");
        }
        let cylinder = MeasuredVolume { r: None, ..volume };
        assert_eq!(surface_of(&cylinder, 1.0, 0.3, Some(&mut gradient)), 3.0);
        assert_eq!(gradient, SurfaceGradient::default());
    }

    #[test]
    fn replays_its_corpus_bit_for_bit() {
        let corpus = Corpus::load("surfaceOf");
        for case in corpus.iter() {
            let present = case.scalar("t.r.present", false) == 1.0;
            let t = MeasuredVolume {
                // The recorded radii are the f32 table widened, so narrowing restores it.
                r: present.then(|| case.input("t.r").iter().map(|&x| x as f32).collect()),
                bands: case.scalar("t.bands", false),
                sectors: case.scalar("t.sectors", false),
                top: case.scalar("t.top", false),
                bottom: case.scalar("t.bottom", false),
                radius: case.scalar("t.radius", false),
            };
            if let Some(r) = &t.r {
                for (&narrow, &wide) in r.iter().zip(case.input("t.r")) {
                    assert_eq!(f64::from(narrow).to_bits(), wide.to_bits());
                }
            }
            let with_gradient = case.scalar("gradient.present", false) == 1.0;
            let mut gradient = SurfaceGradient {
                height: case.scalar("gradient.height", false),
                bearing: case.scalar("gradient.bearing", false),
            };
            let got = surface_of(
                &t,
                case.scalar("h", false),
                case.scalar("theta", false),
                with_gradient.then_some(&mut gradient),
            );
            assert_eq!(got.to_bits(), case.scalar("return", true).to_bits());
            if with_gradient {
                assert_eq!(
                    gradient.height.to_bits(),
                    case.scalar("gradient.height", true).to_bits()
                );
                assert_eq!(
                    gradient.bearing.to_bits(),
                    case.scalar("gradient.bearing", true).to_bits()
                );
            }
        }
    }
}
