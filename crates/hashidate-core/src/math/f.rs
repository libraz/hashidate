//! Scalar functions with a result fixed across hosts.
//!
//! The transcendentals come from `libm` so native and wasm builds agree; `hypot`, `js_min`,
//! `js_max`, `js_round` and `js_sign` reproduce the JavaScript results exactly, since they need
//! only arithmetic.

/// `-60 * Math.log(1 - 0.25)`, the elbow's swivel tracking as a per-second rate. The logarithm is
/// the bit pattern V8 and `libm` agree on.
pub const SWIVEL_RATE: f64 = -60.0 * f64::from_bits(0xbfd2_6962_1134_db92);

/// `Math.cbrt(Number.EPSILON)`, the arm path's finite-difference scale.
pub const CBRT_EPSILON: f64 = f64::from_bits(0x3ed9_65fe_a53d_6e3d);

/// `Number.EPSILON ** (2 / 3)`, the arm path's lexical tolerance.
pub const EPSILON_2_3: f64 = f64::from_bits(0x3dc4_28a2_f98d_7292);

/// Sine, from `libm`.
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

/// Cosine, from `libm`.
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}

/// Arc cosine, from `libm`.
pub fn acos(x: f64) -> f64 {
    libm::acos(x)
}

/// Arc sine, from `libm`.
pub fn asin(x: f64) -> f64 {
    libm::asin(x)
}

/// Two-argument arc tangent, from `libm`.
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}

/// Hyperbolic tangent, from `libm`.
pub fn tanh(x: f64) -> f64 {
    libm::tanh(x)
}

/// `exp(x) - 1`, from `libm`.
pub fn expm1(x: f64) -> f64 {
    libm::expm1(x)
}

/// Exponential, from `libm`.
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}

/// Natural logarithm, from `libm`.
pub fn log(x: f64) -> f64 {
    libm::log(x)
}

/// Cube root, from `libm`.
pub fn cbrt(x: f64) -> f64 {
    libm::cbrt(x)
}

/// Correctly rounded square root, the same as `Math.sqrt`.
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

/// `Math.hypot(...values)` as V8's `MathHypot` builtin computes it: scale by the largest
/// magnitude, Kahan-sum the squares in argument order, then `sqrt(sum) * max`. The algorithm does
/// not depend on the argument count.
pub fn hypot(values: &[f64]) -> f64 {
    let mut one_is_nan = false;
    let mut max = 0.0;
    for &value in values {
        if value.is_nan() {
            one_is_nan = true;
        } else {
            let magnitude = value.abs();
            if magnitude > max {
                max = magnitude;
            }
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    } else if one_is_nan {
        return f64::NAN;
    } else if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for &value in values {
        let n = value.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.hypot(a, b, c)`.
pub fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    hypot(&[a, b, c])
}

/// `Math.min(a, b)`: NaN if either is NaN, and `-0` below `+0`.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: NaN if either is NaN, and `+0` above `-0`.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_positive() {
        a
    } else {
        b
    }
}

/// `Math.round(x)`: ties go up, and a result of zero keeps the sign of a negative `x`.
pub fn js_round(x: f64) -> f64 {
    let t = x.floor();
    let rounded = if x - t >= 0.5 { t + 1.0 } else { t };
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `Math.sign(x)`: NaN and the zeros are returned as they are.
pub fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: f64, b: f64) -> bool {
        a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
    }

    #[test]
    fn rig_constants_are_what_libm_computes() {
        assert!(same(SWIVEL_RATE, -60.0 * log(1.0 - 0.25)));
        assert!(same(CBRT_EPSILON, cbrt(f64::EPSILON)));
        assert!(same(EPSILON_2_3, libm::pow(f64::EPSILON, 2.0 / 3.0)));
    }

    #[test]
    fn js_round_follows_math_round() {
        let cases = [
            (0.0, 0.0),
            (-0.0, -0.0),
            (0.5, 1.0),
            (-0.5, -0.0),
            (-0.4, -0.0),
            (0.4, 0.0),
            (1.5, 2.0),
            (2.5, 3.0),
            (-1.5, -1.0),
            (-2.5, -2.0),
            (0.499_999_999_999_999_94, 0.0),
            (4_503_599_627_370_495.5, 4_503_599_627_370_496.0),
            (f64::INFINITY, f64::INFINITY),
            (f64::NEG_INFINITY, f64::NEG_INFINITY),
            (f64::NAN, f64::NAN),
        ];
        for (x, want) in cases {
            assert!(same(js_round(x), want), "round({x}) = {}", js_round(x));
        }
    }

    #[test]
    fn js_sign_follows_math_sign() {
        assert!(same(js_sign(3.5), 1.0));
        assert!(same(js_sign(-3.5), -1.0));
        assert!(same(js_sign(0.0), 0.0));
        assert!(same(js_sign(-0.0), -0.0));
        assert!(same(js_sign(f64::NAN), f64::NAN));
        assert!(same(js_sign(f64::NEG_INFINITY), -1.0));
    }

    #[test]
    fn hypot_takes_any_count_and_keeps_the_three_argument_result() {
        assert!(same(hypot(&[]), 0.0));
        assert!(same(hypot(&[3.0, 4.0]), 5.0));
        assert!(same(hypot(&[-7.0]), 7.0));
        assert!(same(hypot(&[f64::NAN, f64::INFINITY]), f64::INFINITY));
        assert!(same(hypot(&[f64::NAN, 1.0]), f64::NAN));
        let (a, b, c) = (0.3, -1.7e200, 2.9e199);
        assert!(same(hypot3(a, b, c), hypot(&[a, b, c])));
    }
}
