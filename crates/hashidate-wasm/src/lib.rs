//! WebAssembly exports of the core. Every export is `extern "C"` with a `hd_` prefix.

use std::alloc::{Layout, alloc, dealloc};

mod math;
mod spring;
mod triangles;

/// Version of the export surface; bumped on any incompatible change.
const ABI_VERSION: u32 = 1;

/// Returns the ABI version this module was built with.
#[unsafe(no_mangle)]
pub extern "C" fn hd_abi_version() -> u32 {
    ABI_VERSION
}

/// Allocates `len` bytes aligned to 8 and returns the pointer, or null on failure.
#[unsafe(no_mangle)]
pub extern "C" fn hd_alloc(len: usize) -> *mut u8 {
    let Ok(layout) = Layout::from_size_align(len.max(1), 8) else {
        return std::ptr::null_mut();
    };
    // SAFETY: the layout has a non-zero size.
    unsafe { alloc(layout) }
}

/// Frees a block returned by `hd_alloc` with the same `len`.
///
/// # Safety
/// `ptr` must come from `hd_alloc(len)` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let Ok(layout) = Layout::from_size_align(len.max(1), 8) else {
        return;
    };
    // SAFETY: the caller passes a pointer from `hd_alloc` with the same length, so the layout
    // matches the original allocation.
    unsafe { dealloc(ptr, layout) }
}
