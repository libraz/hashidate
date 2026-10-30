//! Exports for the triangles module. The functions, buffer layouts and codes are tabled in
//! `src/core/abi/triangles.ts`.

use hashidate_core::triangles::{Binding, Kernel, Shape};

use crate::scene::with_scenes;

const FLAG_SKINNED: u32 = 1;
const FLAG_MORPHED: u32 = 2;
const FLAG_MORPH_RELATIVE: u32 = 4;

const LAYOUT: usize = 11;

/// A kernel, where its mesh sits in the scene graph, and the table of its buffer addresses.
pub struct Handle {
    kernel: Kernel,
    binding: Binding,
    /// The `hd_scene_new` handle the matrices are read from, retained until free.
    scene: u32,
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
/// allocated, for node `mesh` of scene graph `scene` and its skeleton `skeleton` in that graph;
/// registers it as a dependent of that graph.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn hd_tri_new(
    scene: u32,
    mesh: u32,
    skeleton: u32,
    vertices: u32,
    faces: u32,
    morphs: u32,
    bones: u32,
    flags: u32,
) -> *mut Handle {
    let shape = Shape {
        vertices: vertices as usize,
        faces: faces as usize,
        morphs: morphs as usize,
        bones: bones as usize,
        skinned: flags & FLAG_SKINNED != 0,
        morphed: flags & FLAG_MORPHED != 0,
        relative: flags & FLAG_MORPH_RELATIVE != 0,
    };
    let binding = with_scenes(|scenes| {
        let binding = Binding::new(&scenes.get(scene).graph, shape, mesh, skeleton);
        scenes.retain(scene);
        binding
    });
    let mut kernel = Kernel::new(shape);
    let layout = [
        ptr(&kernel.faces),
        ptr(&kernel.base),
        ptr(&kernel.morphs),
        ptr(&kernel.skin_index),
        ptr(&kernel.skin_weight),
        ptr(&kernel.frame),
        ptr(&kernel.influences),
        ptr(kernel.positions()),
        ptr(kernel.centroids()),
        ptr(kernel.depths()),
        ptr(kernel.order_mut()),
    ];
    Box::into_raw(Box::new(Handle {
        kernel,
        binding,
        scene,
        layout,
    }))
}

/// Frees a kernel and every buffer it owns, and releases its graph; a graph already freed is left
/// alone.
///
/// # Safety
/// `h` must come from `hd_tri_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_tri_free(h: *mut Handle) {
    // SAFETY: the caller passes the pointer `Box::into_raw` returned, once.
    let h = unsafe { Box::from_raw(h) };
    with_scenes(|scenes| scenes.release(h.scene));
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

/// Reads the matrices from the graph, then poses, measures and sorts from them and the input
/// buffers; returns the outcome code.
///
/// # Safety
/// As for `hd_tri_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_tri_update(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let outcome = with_scenes(|scenes| {
        h.binding.read(&scenes.get(h.scene).graph, &mut h.kernel);
        h.kernel.update()
    });
    outcome as u32
}

/// 1 if the graph's bone, bone-inverse or bind matrices differ from those the last update read,
/// else 0.
///
/// # Safety
/// As for `hd_tri_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_tri_skin_changed(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    with_scenes(|scenes| {
        u32::from(
            h.binding
                .skin_changed(&scenes.get(h.scene).graph, &h.kernel),
        )
    })
}
