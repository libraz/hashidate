//! Exports for the scene graph. The functions, buffer layouts and codes are tabled in
//! `src/core/abi/scene.ts`.

use std::cell::RefCell;

use hashidate_core::math::Mat4;
use hashidate_core::scene::graph::{Graph, RECORD, Registry, Shape};

const LAYOUT: usize = 21;
const SCRATCH: usize = RECORD;

/// A graph and the table of its buffer addresses.
pub struct Scene {
    pub graph: Graph,
    scratch: [f64; SCRATCH],
    layout: [u32; LAYOUT],
}

thread_local! {
    static SCENES: RefCell<Registry<Scene>> = const { RefCell::new(Registry::new()) };
}

/// Runs `f` on the registry of live scene graphs; dependents retain and release through it.
pub fn with_scenes<R>(f: impl FnOnce(&mut Registry<Scene>) -> R) -> R {
    SCENES.with_borrow_mut(f)
}

fn with_scene<R>(h: u32, f: impl FnOnce(&mut Scene) -> R) -> R {
    with_scenes(|scenes| f(scenes.get(h)))
}

fn ptr<T>(v: &[T]) -> u32 {
    v.as_ptr() as usize as u32
}

fn scratch_mat4(scratch: &[f64], at: usize) -> Mat4 {
    let mut elements = [0.0; 16];
    elements.copy_from_slice(&scratch[at..at + 16]);
    Mat4::from_elements(elements)
}

/// Creates a graph sized for `nodes` nodes, `meshes` SkinnedMeshes, `skeletons` skeletons and
/// `bones` bone slots over all of them, with every buffer allocated.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_new(nodes: u32, meshes: u32, skeletons: u32, bones: u32) -> u32 {
    let graph = Graph::new(Shape {
        nodes: nodes as usize,
        meshes: meshes as usize,
        skeletons: skeletons as usize,
        bones: bones as usize,
    });
    with_scenes(|scenes| {
        let h = scenes.insert(Scene {
            graph,
            scratch: [0.0; SCRATCH],
            layout: [0; LAYOUT],
        });
        // The scene is boxed in the registry, so the scratch address taken here stays put.
        let s = scenes.get(h);
        let g = &s.graph;
        s.layout = [
            ptr(&g.position),
            ptr(&g.quaternion),
            ptr(&g.scale),
            ptr(&g.pivot),
            ptr(&g.matrix),
            ptr(&g.matrix_world),
            ptr(&g.flags),
            ptr(&g.force),
            ptr(&g.parent),
            ptr(&g.child_offsets),
            ptr(&g.children),
            ptr(&g.mesh_nodes),
            ptr(&g.bind_matrix),
            ptr(&g.bind_matrix_inverse),
            ptr(&g.skeleton_offsets),
            ptr(&g.bone_nodes),
            ptr(&g.bone_inverses),
            ptr(&g.bone_matrices),
            ptr(&g.ancestors),
            ptr(&g.ancestor_flags),
            ptr(&s.scratch),
        ];
        h
    })
}

/// Frees a graph; traps while a dependent created on it is still alive.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_free(h: u32) {
    with_scenes(|scenes| scenes.free(h));
}

/// Frees a graph whatever still depends on it; for the finaliser.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_free_orphan(h: u32) {
    with_scenes(|scenes| scenes.free_orphan(h));
}

/// The buffer address table, valid until the graph is freed.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_layout(h: u32) -> *const u32 {
    with_scene(h, |s| s.layout.as_ptr())
}

/// Registers the next node in `traverse` order from the record in scratch; returns its index.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_node(h: u32, parent: u32, flags: u32) -> u32 {
    let flags = u8::try_from(flags).expect("node flags exceed a byte");
    with_scene(h, |s| s.graph.push_node(parent, flags, &s.scratch))
}

/// Registers `node` as the next SkinnedMesh from bindMatrix and bindMatrixInverse in scratch.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_mesh(h: u32, node: u32) -> u32 {
    with_scene(h, |s| {
        let bind = scratch_mat4(&s.scratch, 0);
        let inverse = scratch_mat4(&s.scratch, 16);
        s.graph.push_mesh(node, &bind, &inverse)
    })
}

/// Opens the next skeleton and returns its index.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_skeleton(h: u32) -> u32 {
    with_scene(h, |s| s.graph.push_skeleton())
}

/// Appends a bone slot to the open skeleton from the boneInverse in scratch; returns the slot's
/// index within the skeleton.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_bone(h: u32, node: u32) -> u32 {
    with_scene(h, |s| {
        let inverse = scratch_mat4(&s.scratch, 0);
        s.graph.push_bone(node, &inverse)
    })
}

/// Closes construction and fills the children table.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_build(h: u32) {
    with_scene(h, |s| s.graph.build());
}

/// Sets (1) or clears (0) whether `node` has children outside the table.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_plain_children(h: u32, node: u32, on: u32) {
    with_scene(h, |s| s.graph.set_plain_children(node, on != 0));
}

/// Sets how many ancestor levels the mirror holds.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_ancestors(h: u32, count: u32) {
    with_scene(h, |s| s.graph.set_ancestors(count as usize));
}

/// `node.updateMatrix()`.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_update_matrix(h: u32, node: u32) {
    with_scene(h, |s| s.graph.update_matrix(node));
}

/// `node.updateMatrixWorld(force)`.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_update_matrix_world(h: u32, node: u32, force: u32) {
    with_scene(h, |s| s.graph.update_matrix_world(node, force != 0));
}

/// `node.updateWorldMatrix(updateParents, updateChildren, force)`.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_update_world_matrix(
    h: u32,
    node: u32,
    update_parents: u32,
    update_children: u32,
    force: u32,
) {
    with_scene(h, |s| {
        s.graph
            .update_world_matrix(node, update_parents != 0, update_children != 0, force != 0)
    });
}

/// `skeleton.update()` into the bone matrices buffer.
#[unsafe(no_mangle)]
pub extern "C" fn hd_scene_skeleton_update(h: u32, skeleton: u32) {
    with_scene(h, |s| s.graph.skeleton_update(skeleton));
}
