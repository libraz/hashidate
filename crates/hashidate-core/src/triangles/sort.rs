//! Face order: ascending depth, equal depths by face index.

use std::cmp::Ordering;

/// Whether any depth is NaN, which `sortAndApply`'s comparator cannot order.
pub fn has_nan(depths: &[f64]) -> bool {
    depths.iter().any(|d| d.is_nan())
}

/// `sortAndApply`'s comparator. `+ 0.0` folds −0 into +0, so the two tie as they do under `<`;
/// on every other non-NaN value `total_cmp` agrees with `<`. It is a total order on any input,
/// so the sort cannot panic.
fn compare(depths: &[f64], left: u32, right: u32) -> Ordering {
    let a = depths[left as usize] + 0.0;
    let b = depths[right as usize] + 0.0;
    a.total_cmp(&b).then(left.cmp(&right))
}

/// Sorts `order` in place. No two faces compare equal, so the result does not depend on the
/// starting order or the sort's stability; the unstable sort is used because it never allocates.
pub fn sort_faces(order: &mut [u32], depths: &[f64]) {
    order.sort_unstable_by(|&l, &r| compare(depths, l, r));
}
