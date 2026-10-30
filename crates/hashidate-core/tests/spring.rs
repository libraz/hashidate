//! The solver through its public builder and update calls.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use hashidate_core::math::{Mat4, Quat, Vec3};
use hashidate_core::scene::graph::{Graph, NO_NODE, RECORD, Shape, flag};
use hashidate_core::secondary::{GroupSpec, Spring};

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

fn allocations() -> usize {
    ALLOCATIONS.with(Cell::get)
}

const STEP: f64 = 1.0 / 60.0;

/// A solver over a body node, a hanging chain of `links` below it and a collider on the body,
/// plus, with `anchored`, a second chain attached to a point on the first.
struct Rig {
    graph: Graph,
    spring: Spring,
    body: u32,
}

/// A graph of bones under a plain top node, given in `traverse` order as parent and position,
/// after `top.updateMatrixWorld(true)`.
fn graph(bones: &[(u32, [f64; 3])]) -> Graph {
    let n = bones.len() + 1;
    let mut g = Graph::new(Shape {
        nodes: n,
        ..Shape::default()
    });
    let auto = flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE;
    g.push_node(NO_NODE, auto, &[0.0; RECORD]);
    for &(parent, _) in bones {
        g.push_node(parent, auto | flag::BONE, &[0.0; RECORD]);
    }
    g.build();
    let identity = Mat4::default().elements;
    for i in 0..n {
        g.quaternion[4 * i + 3] = 1.0;
        g.scale[3 * i..3 * i + 3].copy_from_slice(&[1.0; 3]);
        g.matrix[16 * i..16 * i + 16].copy_from_slice(&identity);
        g.matrix_world[16 * i..16 * i + 16].copy_from_slice(&identity);
    }
    for (i, &(_, p)) in bones.iter().enumerate() {
        g.position[3 * (i + 1)..3 * (i + 1) + 3].copy_from_slice(&p);
    }
    g.update_matrix_world(0, true);
    g
}

fn world_position(graph: &Graph, i: u32) -> Vec3 {
    let e = &graph.matrix_world[16 * i as usize..];
    Vec3::new(e[12], e[13], e[14])
}

fn spec(stiffness: f64, gravity: f64) -> GroupSpec {
    GroupSpec {
        stiffness,
        drag: 0.3,
        gravity,
        gravity_dir: Vec3::new(0.0, -1.0, 0.0),
        radius: 0.02,
    }
}

fn rig(links: usize, stiffness: f64, gravity: f64, anchored: bool) -> Rig {
    let mut bones = Vec::new();
    let mut add = |parent: u32, position: [f64; 3]| {
        bones.push((parent, position));
        bones.len() as u32
    };
    let body = add(0, [0.0, 1.0, 0.0]);
    let mut chain = Vec::new();
    let mut parent = body;
    for i in 0..=links {
        let offset = if i == 0 {
            [0.0, -0.02, 0.03]
        } else {
            [0.0, -0.08, 0.03]
        };
        parent = add(parent, offset);
        chain.push(parent);
    }
    let charm: Vec<u32> = if anchored {
        let mut out = Vec::new();
        let mut p = body;
        for i in 0..3 {
            p = add(
                p,
                if i == 0 {
                    [0.1, 0.0, 0.0]
                } else {
                    [0.0, -0.05, 0.0]
                },
            );
            out.push(p);
        }
        out
    } else {
        Vec::new()
    };
    let mut graph = graph(&bones);
    let mut spring = Spring::new(&graph);

    let collider = spring.add_collider(body, Vec3::new(0.0, -0.15, 0.0), None, 0.05, false);
    spring.begin_group(spec(stiffness, gravity));
    spring.add_group_root(chain[0]);
    assert_eq!(spring.end_group(&mut graph), links);
    spring.add_group_collider(collider);
    if anchored {
        spring.begin_group(spec(0.5, 0.2));
        spring.add_group_root(charm[0]);
        spring.set_group_anchor(charm[0]);
        spring.add_anchor_influence(chain[1], 0.5, Vec3::new(0.0, -0.02, 0.0));
        spring.add_anchor_influence(body, 0.5, Vec3::new(0.1, 0.0, 0.0));
        assert_eq!(spring.end_group(&mut graph), 2);
    }
    spring.build(&mut graph);
    assert!(spring.statuses().is_empty());
    Rig {
        graph,
        spring,
        body,
    }
}

impl Rig {
    /// Swings the body about z and runs one frame, world update first, as the caller does.
    fn frame(&mut self, angle: f64, dt: f64) {
        let mut q = Quat::default();
        q.set_from_axis_angle(&Vec3::new(0.0, 0.0, 1.0), angle);
        let at = 4 * self.body as usize;
        self.graph.quaternion[at..at + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
        self.graph.update_matrix_world(0, true);
        self.spring.update(&mut self.graph, dt);
    }
}

#[test]
fn links_keep_their_length_and_stay_joined() {
    let mut rig = rig(4, 0.6, 0.4, false);
    for frame in 0..300 {
        rig.frame((frame as f64 * 0.11).sin() * 1.2, STEP);
        let joints = &rig.spring.groups()[0].joints;
        for (k, j) in joints.iter().enumerate() {
            let origin = world_position(&rig.graph, j.bone);
            let length = j.cur.distance_to(&origin);
            assert!((length - j.length).abs() < 1e-9, "frame {frame} joint {k}");
            if let Some(next) = joints.get(k + 1) {
                let head = world_position(&rig.graph, next.bone);
                assert!(head.distance_to(&j.cur) < 1e-9, "frame {frame} joint {k}");
            }
        }
    }
}

#[test]
fn a_still_chain_falls_under_gravity_and_rests_without_it() {
    let mut falling = rig(3, 0.0, 2.0, false);
    let mut resting = rig(3, 1.0, 0.0, false);
    falling.frame(0.0, 0.0);
    resting.frame(0.0, 0.0);
    let start = falling.spring.groups()[0].joints[2].cur;
    let rest = resting.spring.groups()[0].joints[2].cur;
    for _ in 0..120 {
        falling.frame(0.0, STEP);
        resting.frame(0.0, STEP);
    }
    let fallen = falling.spring.groups()[0].joints[2].cur;
    assert!(
        fallen.y < start.y - 1e-3,
        "{} against {}",
        fallen.y,
        start.y
    );
    assert!(resting.spring.groups()[0].joints[2].cur.distance_to(&rest) < 1e-9);
    assert_eq!(falling.spring.acc(), 0.0);
}

#[test]
fn caps_a_long_frame_at_four_steps() {
    let mut rig = rig(2, 1.0, 0.0, false);
    rig.frame(0.0, 0.0);
    // Four steps' worth is kept, and spent, of a one-second frame.
    rig.frame(0.3, 1.0);
    assert!(rig.spring.acc() < 1e-12);
    rig.frame(0.3, 0.025);
    assert!((rig.spring.acc() - (0.025 - STEP)).abs() < 1e-12);
}

#[test]
fn nothing_is_allocated_after_construction() {
    let mut rig = rig(4, 0.6, 0.8, true);
    rig.frame(0.0, 0.0);
    let before = allocations();
    for frame in 0..400 {
        let angle = (frame as f64 * 0.17).sin() * 1.5;
        let mut q = Quat::default();
        q.set_from_axis_angle(&Vec3::new(0.0, 0.0, 1.0), angle);
        let at = 4 * rig.body as usize;
        rig.graph.quaternion[at..at + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
        rig.graph.update_matrix_world(0, true);
        if frame == 150 {
            rig.spring.enabled = false;
        }
        if frame == 170 {
            rig.spring.enabled = true;
        }
        if frame == 250 {
            rig.spring.reset();
        }
        rig.spring
            .update(&mut rig.graph, [STEP, 1.0 / 144.0, 0.05, 0.2][frame % 4]);
    }
    assert_eq!(allocations(), before);
}
