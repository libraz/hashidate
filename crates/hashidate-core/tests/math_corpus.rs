//! The math corpus hashes to the constant the wasm build is also checked against.

use hashidate_core::math::corpus::corpus_hash;

/// Shared with `tests/core/math-parity.test.ts`; both builds must produce it.
const EXPECTED: u64 = 0x3c38_dd49_d0d1_8fb7;

#[test]
fn corpus_hash_is_fixed() {
    assert_eq!(
        corpus_hash(),
        EXPECTED,
        "corpus hash {:#018x}",
        corpus_hash()
    );
}
