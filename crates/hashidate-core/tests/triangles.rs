//! The triangle kernel through its public buffers and update.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use hashidate_core::triangles::{
    BONE, FRAME_BIND, FRAME_BIND_INVERSE, FRAME_MESH_WORLD, FRAME_VIEW, Kernel, Outcome, Shape,
};

/// Counts this thread's allocations, so parallel tests do not see each other's.
struct Counting;

thread_local! {
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

// SAFETY: every call is forwarded to `System` unchanged; the count is a thread-local `Cell`
// with a const initialiser, which never allocates.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.with(|n| n.set(n.get() + 1));
        // SAFETY: forwarded with the caller's layout.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: forwarded with the caller's pointer and layout.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.with(|n| n.set(n.get() + 1));
        // SAFETY: forwarded with the caller's arguments.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

fn translation(x: f64, y: f64, z: f64) -> [f64; 16] {
    let mut m = IDENTITY;
    m[12] = x;
    m[13] = y;
    m[14] = z;
    m
}

/// A rigid kernel with identity world and view, so a face's depth is its centroid's z.
fn rigid(vertices: &[[f64; 3]], faces: &[[u32; 3]]) -> Kernel {
    let mut k = Kernel::new(Shape {
        vertices: vertices.len(),
        faces: faces.len(),
        ..Shape::default()
    });
    for (i, v) in vertices.iter().enumerate() {
        k.base[3 * i..3 * i + 3].copy_from_slice(v);
    }
    for (i, f) in faces.iter().enumerate() {
        k.faces[3 * i..3 * i + 3].copy_from_slice(f);
    }
    k.frame[FRAME_MESH_WORLD..FRAME_MESH_WORLD + 16].copy_from_slice(&IDENTITY);
    k.frame[FRAME_VIEW..FRAME_VIEW + 16].copy_from_slice(&IDENTITY);
    k
}

/// One vertex per face, so face `i` sits at depth `z[i]`.
fn at_depths(z: &[f64]) -> Kernel {
    let vertices: Vec<[f64; 3]> = z.iter().map(|&z| [-1.0, -1.0, z]).collect();
    let faces: Vec<[u32; 3]> = (0..z.len() as u32).map(|i| [i, i, i]).collect();
    rigid(&vertices, &faces)
}

#[test]
fn sorts_ascending_with_ties_by_face_index() {
    let mut k = at_depths(&[0.5, -1.0, 0.5, 2.0, -1.0, 0.5]);
    assert_eq!(k.update(), Outcome::Sorted);
    assert_eq!(k.order(), &[1, 4, 0, 2, 5, 3]);
}

#[test]
fn result_does_not_depend_on_the_starting_order() {
    let mut k = at_depths(&[0.25, 0.25, -3.0, 0.25, 7.0, -3.0]);
    k.order_mut().reverse();
    k.update();
    assert_eq!(k.order(), &[2, 5, 0, 1, 3, 4]);
}

#[test]
fn identical_centroids_tie() {
    let vertices = [[0.1, 0.2, 0.3], [0.7, -0.4, 0.9], [-0.6, 0.5, -0.2]];
    let mut k = rigid(&vertices, &[[0, 1, 2], [0, 1, 2], [1, 1, 1], [0, 1, 2]]);
    k.update();
    assert_eq!(k.depths()[0].to_bits(), k.depths()[1].to_bits());
    assert_eq!(k.order(), &[0, 1, 3, 2]);
}

#[test]
fn negative_and_positive_zero_tie() {
    let mut k = at_depths(&[0.0, -0.0, -0.0, 0.0]);
    k.frame[FRAME_MESH_WORLD + 14] = -0.0;
    k.frame[FRAME_VIEW + 14] = -0.0;
    k.update();
    let bits: Vec<u64> = k.depths().iter().map(|d| d.to_bits()).collect();
    assert_eq!(
        bits,
        [0.0f64, -0.0, -0.0, 0.0].map(f64::to_bits),
        "the depths keep their signs"
    );
    assert_eq!(k.order(), &[0, 1, 2, 3]);
}

#[test]
fn infinities_order_and_tie() {
    // Finite centroids whose depths overflow; an infinite centroid would meet a 0 in the world
    // matrix and turn NaN.
    let mut k = at_depths(&[1e300, 1.0, -1e300, 1e300, -1.0]);
    k.frame[FRAME_VIEW + 10] = 1e10;
    k.update();
    assert_eq!(k.depths()[0], f64::INFINITY);
    assert_eq!(k.depths()[2], f64::NEG_INFINITY);
    assert_eq!(k.order(), &[2, 4, 1, 0, 3]);
}

#[test]
fn a_nan_depth_keeps_the_previous_order() {
    let mut k = at_depths(&[3.0, 1.0, 2.0, 0.0]);
    assert_eq!(k.update(), Outcome::Sorted);
    assert_eq!(k.order(), &[3, 1, 2, 0]);
    k.base[8] = f64::NAN;
    k.base[5] = -5.0;
    assert_eq!(k.update(), Outcome::NonFiniteDepth);
    assert_eq!(k.order(), &[3, 1, 2, 0]);
    k.base[8] = 9.0;
    assert_eq!(k.update(), Outcome::Sorted);
    assert_eq!(k.order(), &[1, 3, 0, 2]);
}

#[test]
fn skins_by_weighted_bone_transforms() {
    let mut k = Kernel::new(Shape {
        vertices: 1,
        faces: 1,
        bones: 2,
        skinned: true,
        ..Shape::default()
    });
    k.base.copy_from_slice(&[1.0, 0.0, 0.0]);
    // Index 7 is out of range and has weight 0, so it must never be read.
    k.skin_index.copy_from_slice(&[0, 1, 7, 0]);
    k.skin_weight.copy_from_slice(&[0.5, 0.5, 0.0, 0.0]);
    k.bones[..16].copy_from_slice(&translation(0.0, 1.0, 0.0));
    k.bones[16..32].copy_from_slice(&IDENTITY);
    k.bones[BONE..BONE + 16].copy_from_slice(&translation(0.0, 0.0, 4.0));
    k.bones[BONE + 16..BONE + 32].copy_from_slice(&translation(0.0, 0.0, -2.0));
    k.frame[FRAME_BIND..FRAME_BIND + 16].copy_from_slice(&translation(1.0, 0.0, 0.0));
    k.frame[FRAME_BIND_INVERSE..FRAME_BIND_INVERSE + 16]
        .copy_from_slice(&translation(-1.0, 0.0, 0.0));
    k.frame[FRAME_MESH_WORLD..FRAME_MESH_WORLD + 16].copy_from_slice(&IDENTITY);
    k.frame[FRAME_VIEW..FRAME_VIEW + 16].copy_from_slice(&IDENTITY);
    k.update();
    // Bind moves (1,0,0) to (2,0,0); bone 0 gives (2,1,0), bone 1 gives (2,0,2); half each is
    // (2,0.5,1), and the bind inverse brings it back to (1,0.5,1).
    assert_eq!(k.positions(), &[1.0, 0.5, 1.0]);
    assert_eq!(k.depths(), &[1.0]);
}

#[test]
fn morphs_relative_and_absolute() {
    for (relative, target, influence) in [
        (true, [0.5, 0.0, -1.0], 2.0),
        (false, [3.0, 2.0, -1.0], 0.5),
    ] {
        let mut k = Kernel::new(Shape {
            vertices: 1,
            faces: 1,
            morphs: 2,
            morphed: true,
            relative,
            ..Shape::default()
        });
        k.base.copy_from_slice(&[1.0, 2.0, 3.0]);
        k.morphs[..3].copy_from_slice(&target);
        // A zero influence is skipped, so its NaN target never reaches the sum.
        k.morphs[3..].copy_from_slice(&[f64::NAN; 3]);
        k.influences.copy_from_slice(&[influence, 0.0]);
        k.update();
        assert_eq!(k.positions(), &[2.0, 2.0, 1.0], "relative {relative}");
    }
}

#[test]
fn a_morphed_mesh_adds_its_zero_sum() {
    let mut k = Kernel::new(Shape {
        vertices: 1,
        faces: 1,
        morphed: true,
        ..Shape::default()
    });
    k.base.copy_from_slice(&[-0.0, -0.0, -0.0]);
    k.update();
    assert_eq!(k.positions()[2].to_bits(), 0.0f64.to_bits());
}

#[test]
fn update_allocates_nothing() {
    let mut k = at_depths(&[0.3, -0.2, 0.9, 0.1, 0.1, -4.0, 2.5, 0.0]);
    k.update();
    let before = ALLOCATIONS.with(Cell::get);
    for frame in 0..100 {
        k.frame[FRAME_VIEW + 14] = frame as f64 * 0.01;
        k.base[2] = -(frame as f64);
        k.update();
    }
    assert_eq!(ALLOCATIONS.with(Cell::get), before);
}
