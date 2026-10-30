//! The solver through its public builder and update calls.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use hashidate_core::math::{Quat, Vec3};
use hashidate_core::scene::Node;
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
    spring: Spring,
    body: u32,
}

fn node(parent: u32, position: [f64; 3]) -> Node {
    let mut n = Node {
        parent,
        is_bone: true,
        ..Node::default()
    };
    n.position.set(position[0], position[1], position[2]);
    n
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
    let mut spring = Spring::new(0);
    let top = spring.add_node(Node::default());
    let body = spring.add_node(node(top, [0.0, 1.0, 0.0]));
    let mut chain = Vec::new();
    let mut parent = body;
    for i in 0..=links {
        let offset = if i == 0 {
            [0.0, -0.02, 0.03]
        } else {
            [0.0, -0.08, 0.03]
        };
        parent = spring.add_node(node(parent, offset));
        chain.push(parent);
    }
    let charm: Vec<u32> = if anchored {
        let mut out = Vec::new();
        let mut p = body;
        for i in 0..3 {
            p = spring.add_node(node(
                p,
                if i == 0 {
                    [0.1, 0.0, 0.0]
                } else {
                    [0.0, -0.05, 0.0]
                },
            ));
            out.push(p);
        }
        out
    } else {
        Vec::new()
    };
    let all: Vec<u32> = (0..spring.scene().len() as u32).collect();
    spring.scene_mut().update_matrix_world_forced(&all);

    let collider = spring.add_collider(body, Vec3::new(0.0, -0.15, 0.0), None, 0.05, false);
    spring.begin_group(spec(stiffness, gravity));
    spring.add_group_root(chain[0]);
    assert_eq!(spring.end_group(), links);
    spring.add_group_collider(collider);
    if anchored {
        spring.begin_group(spec(0.5, 0.2));
        spring.add_group_root(charm[0]);
        spring.set_group_anchor(charm[0]);
        spring.add_anchor_influence(chain[1], 0.5, Vec3::new(0.0, -0.02, 0.0));
        spring.add_anchor_influence(body, 0.5, Vec3::new(0.1, 0.0, 0.0));
        assert_eq!(spring.end_group(), 2);
    }
    spring.build();
    assert!(spring.statuses().is_empty());
    Rig { spring, body }
}

impl Rig {
    /// Swings the body about z and runs one frame, world update first, as the caller does.
    fn frame(&mut self, angle: f64, dt: f64) {
        let mut q = Quat::default();
        q.set_from_axis_angle(&Vec3::new(0.0, 0.0, 1.0), angle);
        self.spring.scene_mut().node_mut(self.body).quaternion = q;
        let nodes = self.spring.write_nodes().to_vec();
        self.spring.scene_mut().update_matrix_world_forced(&nodes);
        self.spring.update(dt);
    }
}

#[test]
fn links_keep_their_length_and_stay_joined() {
    let mut rig = rig(4, 0.6, 0.4, false);
    for frame in 0..300 {
        rig.frame((frame as f64 * 0.11).sin() * 1.2, STEP);
        let joints = &rig.spring.groups()[0].joints;
        for (k, j) in joints.iter().enumerate() {
            let origin = rig.spring.scene().world_position(j.bone);
            let length = j.cur.distance_to(&origin);
            assert!((length - j.length).abs() < 1e-9, "frame {frame} joint {k}");
            if let Some(next) = joints.get(k + 1) {
                let head = rig.spring.scene().world_position(next.bone);
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
    let nodes = rig.spring.write_nodes().to_vec();
    let before = allocations();
    for frame in 0..400 {
        let angle = (frame as f64 * 0.17).sin() * 1.5;
        let mut q = Quat::default();
        q.set_from_axis_angle(&Vec3::new(0.0, 0.0, 1.0), angle);
        rig.spring.scene_mut().node_mut(rig.body).quaternion = q;
        rig.spring.scene_mut().update_matrix_world_forced(&nodes);
        if frame == 150 {
            rig.spring.enabled = false;
        }
        if frame == 170 {
            rig.spring.enabled = true;
        }
        if frame == 250 {
            rig.spring.reset();
        }
        rig.spring.update([STEP, 1.0 / 144.0, 0.05, 0.2][frame % 4]);
    }
    assert_eq!(allocations(), before);
}
