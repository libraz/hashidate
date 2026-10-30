//! Scalar functions with a result fixed across hosts.
//!
//! The transcendentals come from `libm` so native and wasm builds agree; `hypot3`, `js_min` and
//! `js_max` reproduce the JavaScript results exactly, since they need only arithmetic.

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

/// Correctly rounded square root, the same as `Math.sqrt`.
pub fn sqrt(x: f64) -> f64 {
    x.sqrt()
}

/// `Math.hypot(a, b, c)` as V8's `MathHypot` builtin computes it: scale by the largest magnitude,
/// Kahan-sum the squares in argument order, then `sqrt(sum) * max`.
pub fn hypot3(a: f64, b: f64, c: f64) -> f64 {
    let values = [a, b, c];
    let mut abs = [0.0; 3];
    let mut one_is_nan = false;
    let mut max = 0.0;
    for (slot, &value) in abs.iter_mut().zip(values.iter()) {
        if value.is_nan() {
            one_is_nan = true;
        } else {
            let magnitude = value.abs();
            *slot = magnitude;
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
    for magnitude in abs {
        let n = magnitude / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
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
