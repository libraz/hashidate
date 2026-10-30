//! Exports for the triangles module. The functions, buffer layouts and codes are tabled in
//! `src/core/abi/triangles.ts`.

use hashidate_core::triangles::{Kernel, Shape};

const FLAG_SKINNED: u32 = 1;
const FLAG_MORPHED: u32 = 2;
const FLAG_MORPH_RELATIVE: u32 = 4;

const LAYOUT: usize = 12;

/// A kernel and the table of its buffer addresses.
pub struct Handle {
    kernel: Kernel,
    layout: [u32; LAYOUT],
}

fn ptr<T>(v: &[T]) -> u32 {
    v.as_ptr() as usize as u32
}

/// The handle behind `h`.
///
/// # Safety
/// `h` must come from `hd_tri_new` and not have been passed to `hd_tri_free`.
unsafe fn handle<'a>(h: *mut Handle) -> &'a mut Handle {
    // SAFETY: the caller passes a live pointer from `Box::into_raw` in `hd_tri_new`, and the
    // single-threaded module never holds two references to it at once.
    unsafe { &mut *h }
}

/// Creates a kernel over `vertices` referenced vertices and `faces` faces, with every buffer
/// allocated.
#[unsafe(no_mangle)]
pub extern "C" fn hd_tri_new(
    vertices: u32,
    faces: u32,
    morphs: u32,
    bones: u32,
    flags: u32,
) -> *mut Handle {
    let mut kernel = Kernel::new(Shape {
        vertices: vertices as usize,
        faces: faces as usize,
        morphs: morphs as usize,
        bones: bones as usize,
        skinned: flags & FLAG_SKINNED != 0,
        morphed: flags & FLAG_MORPHED != 0,
        relative: flags & FLAG_MORPH_RELATIVE != 0,
    });
    let layout = [
        ptr(&kernel.faces),
        ptr(&kernel.base),
        ptr(&kernel.morphs),
        ptr(&kernel.skin_index),
        ptr(&kernel.skin_weight),
        ptr(&kernel.bones),
        ptr(&kernel.frame),
        ptr(&kernel.influences),
        ptr(kernel.positions()),
        ptr(kernel.centroids()),
        ptr(kernel.depths()),
        ptr(kernel.order_mut()),
    ];
    Box::into_raw(Box::new(Handle { kernel, layout }))
}

/// Frees a kernel and every buffer it owns.
///
/// # Safety
/// `h` must come from `hd_tri_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_tri_free(h: *mut Handle) {
    // SAFETY: the caller passes the pointer `Box::into_raw` returned, once.
    drop(unsafe { Box::from_raw(h) });
}

/// The buffer address table, valid until `hd_tri_free`.
///
/// # Safety
/// As for `hd_tri_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_tri_layout(h: *mut Handle) -> *const u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.layout.as_ptr()
}

/// Poses, measures and sorts from the input buffers; returns the outcome code.
///
/// # Safety
/// As for `hd_tri_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_tri_update(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.kernel.update() as u32
}
