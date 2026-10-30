//! Exports for the spring module. The functions, buffer layouts and codes are tabled in
//! `src/core/abi/spring.ts`.

use hashidate_core::math::{Quat, Vec3};
use hashidate_core::scene::graph::Graph;
use hashidate_core::secondary::{GroupSpec, Spring};

use crate::scene::with_scenes;

/// f64 per joint: cur, prev, solvedQ, prevSolvedQ, swing.
const JOINT_OUT: usize = 17;
/// f64 per group: targetWorld, rootWorld, error.
const DIAGNOSTICS: usize = 7;
/// f64 per pooled collider: a, b.
const COLLIDER_OUT: usize = 6;
/// u32 per status: kind, group key, node, other group key.
const STATUS: usize = 4;
/// f64 ahead of the per-group flags in the control buffer.
const CONTROL_HEAD: usize = 4;
const LAYOUT: usize = 10;
/// f64 the info calls write; the longest is JOINT_INFO.
const SCRATCH: usize = 11;

/// A solver over a scene graph and the buffers it is synchronised through.
pub struct Handle {
    spring: Spring,
    /// The `hd_scene_new` handle the solver reads and writes, retained until free.
    scene: u32,
    scratch: [f64; SCRATCH],
    control: Vec<f64>,
    drives: Vec<f64>,
    joint_states: Vec<f64>,
    group_states: Vec<u32>,
    diagnostics: Vec<f64>,
    collider_states: Vec<f64>,
    statuses: Vec<u32>,
    layout: [u32; LAYOUT],
}

fn q4(s: &[f64]) -> Quat {
    Quat::new(s[0], s[1], s[2], s[3])
}

fn put(out: &mut [f64], values: &[f64]) {
    out[..values.len()].copy_from_slice(values);
}

fn ptr<T>(v: &[T]) -> u32 {
    v.as_ptr() as usize as u32
}

impl Handle {
    /// Runs `f` on the solver and the graph it was created on.
    fn with_graph<R>(&mut self, f: impl FnOnce(&mut Spring, &mut Graph) -> R) -> R {
        let scene = self.scene;
        with_scenes(|scenes| f(&mut self.spring, &mut scenes.get(scene).graph))
    }

    /// Copies the caller's inputs in: switches, scales and drives.
    fn load(&mut self) {
        let spring = &mut self.spring;
        spring.enabled = self.control[0] != 0.0;
        spring.stiffness_scale = self.control[1];
        spring.inertia_scale = self.control[2];
        spring.gravity_scale = self.control[3];
        let mut joint = 0;
        for (g, group) in spring.groups_mut().iter_mut().enumerate() {
            group.enabled = self.control[CONTROL_HEAD + g] != 0.0;
            for j in &mut group.joints {
                if j.driven {
                    j.drive = q4(&self.drives[4 * joint..]);
                }
                joint += 1;
            }
        }
    }

    /// Copies the solver's state that is not on the graph out for the caller to read.
    fn publish(&mut self) {
        let spring = &self.spring;
        let mut joint = 0;
        for (g, group) in spring.groups().iter().enumerate() {
            for j in &group.joints {
                let out = &mut self.joint_states[JOINT_OUT * joint..];
                let (c, p, s, r, w) = (&j.cur, &j.prev, &j.solved_q, &j.prev_solved_q, &j.swing);
                put(out, &[c.x, c.y, c.z, p.x, p.y, p.z, s.x, s.y, s.z, s.w]);
                put(&mut out[10..], &[r.x, r.y, r.z, r.w, w.x, w.y, w.z]);
                joint += 1;
            }
            self.group_states[2 * g] = u32::from(group.enabled);
            self.group_states[2 * g + 1] = u32::from(group.anchor.is_some());
            if let Some(a) = &group.anchor {
                let (t, r) = (&a.target_world, &a.root_world);
                put(
                    &mut self.diagnostics[DIAGNOSTICS * g..],
                    &[t.x, t.y, t.z, r.x, r.y, r.z, a.error],
                );
            }
        }
        for (k, c) in spring.colliders().iter().enumerate() {
            put(
                &mut self.collider_states[COLLIDER_OUT * k..],
                &[c.a.x, c.a.y, c.a.z, c.b.x, c.b.y, c.b.z],
            );
        }
        for (k, s) in spring.statuses().iter().enumerate() {
            put_u32(
                &mut self.statuses[STATUS * k..],
                &[s.kind as u32, s.group, s.node, s.other],
            );
        }
    }
}

fn put_u32(out: &mut [u32], values: &[u32]) {
    out[..values.len()].copy_from_slice(values);
}

/// The handle behind `h`.
///
/// # Safety
/// `h` must come from `hd_spring_new` and not have been passed to `hd_spring_free`.
unsafe fn handle<'a>(h: *mut Handle) -> &'a mut Handle {
    // SAFETY: the caller passes a live pointer from `Box::into_raw` in `hd_spring_new`, and the
    // single-threaded module never holds two references to it at once.
    unsafe { &mut *h }
}

/// Creates a solver over the avatar whose root is node 0 of scene graph `scene`, and registers it
/// as a dependent of that graph.
#[unsafe(no_mangle)]
pub extern "C" fn hd_spring_new(scene: u32) -> *mut Handle {
    let spring = with_scenes(|scenes| {
        let spring = Spring::new(&scenes.get(scene).graph);
        scenes.retain(scene);
        spring
    });
    Box::into_raw(Box::new(Handle {
        spring,
        scene,
        scratch: [0.0; SCRATCH],
        control: Vec::new(),
        drives: Vec::new(),
        joint_states: Vec::new(),
        group_states: Vec::new(),
        diagnostics: Vec::new(),
        collider_states: Vec::new(),
        statuses: Vec::new(),
        layout: [0; LAYOUT],
    }))
}

/// Frees a solver and every buffer it owns, and releases its graph; a graph already freed is
/// left alone.
///
/// # Safety
/// `h` must come from `hd_spring_new` and not have been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_free(h: *mut Handle) {
    // SAFETY: the caller passes the pointer `Box::into_raw` returned, once.
    let h = unsafe { Box::from_raw(h) };
    with_scenes(|scenes| scenes.release(h.scene));
}

/// The scratch record the info calls write.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_scratch(h: *mut Handle) -> *mut f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.scratch.as_mut_ptr()
}

/// Registers a collider and returns its pool index.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_spring_collider(
    h: *mut Handle,
    bone: u32,
    ox: f64,
    oy: f64,
    oz: f64,
    has_tail: u32,
    tx: f64,
    ty: f64,
    tz: f64,
    radius: f64,
    inside: u32,
) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let tail = (has_tail != 0).then(|| Vec3::new(tx, ty, tz));
    h.spring
        .add_collider(bone, Vec3::new(ox, oy, oz), tail, radius, inside != 0) as u32
}

/// Opens a group with the given figures.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_spring_group_begin(
    h: *mut Handle,
    stiffness: f64,
    drag: f64,
    gravity: f64,
    gx: f64,
    gy: f64,
    gz: f64,
    radius: f64,
) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.begin_group(GroupSpec {
        stiffness,
        drag,
        gravity,
        gravity_dir: Vec3::new(gx, gy, gz),
        radius,
    });
}

/// Adds a root to the open group.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_group_root(h: *mut Handle, node: u32) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.add_group_root(node);
}

/// Attaches the open group's root to a skinned point.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_group_anchor(h: *mut Handle, root: u32) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.set_group_anchor(root);
}

/// Adds one influence to the open group's anchor.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_anchor_influence(
    h: *mut Handle,
    bone: u32,
    weight: f64,
    px: f64,
    py: f64,
    pz: f64,
) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .spring
        .add_anchor_influence(bone, weight, Vec3::new(px, py, pz));
}

/// Closes the open group and returns its joint count; a group with none is dropped.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_group_end(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.with_graph(|spring, graph| spring.end_group(graph)) as u32
}

/// Adds a pooled collider to the last group built.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_group_collider(h: *mut Handle, collider: u32) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .spring
        .add_group_collider(collider as usize);
}

/// Finishes construction, allocates every per-frame buffer and returns the status count.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_build(h: *mut Handle) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    h.with_graph(|spring, graph| spring.build(graph));
    let spring = &h.spring;
    let joints = spring.count();
    let groups = spring.groups().len();
    let colliders = spring.colliders().len();
    h.control = vec![1.0; CONTROL_HEAD + groups];
    h.drives = vec![0.0; 4 * joints];
    h.joint_states = vec![0.0; JOINT_OUT * joints];
    h.group_states = vec![0; 2 * groups];
    h.diagnostics = vec![0.0; DIAGNOSTICS * groups];
    h.collider_states = vec![0.0; COLLIDER_OUT * colliders];
    h.statuses = vec![0; STATUS * h.spring.max_statuses()];
    h.publish();
    h.layout = [
        ptr(&h.control),
        ptr(&h.drives),
        ptr(&h.joint_states),
        ptr(&h.group_states),
        ptr(&h.diagnostics),
        ptr(&h.collider_states),
        ptr(&h.statuses),
        joints as u32,
        groups as u32,
        colliders as u32,
    ];
    h.spring.statuses().len() as u32
}

/// The buffer table, valid from `hd_spring_build` until `hd_spring_free`.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_layout(h: *mut Handle) -> *const u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.layout.as_ptr()
}

/// Writes group `g`'s construction facts into scratch.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_group_info(h: *mut Handle, g: u32) {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let group = &h.spring.groups()[g as usize];
    let d = &group.gravity_dir;
    put(
        &mut h.scratch,
        &[
            f64::from(group.key),
            group.joints.len() as f64,
            group.drag,
            d.x,
            d.y,
            d.z,
        ],
    );
}

/// Writes joint `k` of group `g`'s construction facts into scratch.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_joint_info(h: *mut Handle, g: u32, k: u32) {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let j = &h.spring.groups()[g as usize].joints[k as usize];
    let (a, r) = (&j.axis, &j.rest);
    put(
        &mut h.scratch,
        &[
            f64::from(j.bone),
            f64::from(j.parent),
            f64::from(u8::from(j.is_root)),
            j.length,
            a.x,
            a.y,
            a.z,
            r.x,
            r.y,
            r.z,
            r.w,
        ],
    );
}

/// Joint `k` of group `g`'s per-collider clearances, one f32 per collider of the group.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_joint_limits(h: *mut Handle, g: u32, k: u32) -> *const f32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.groups()[g as usize].joints[k as usize]
        .limits
        .as_ptr()
}

/// Joint `k` of group `g`'s per-collider link clearances, one f32 per collider of the group.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_joint_spans(h: *mut Handle, g: u32, k: u32) -> *const f32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.groups()[g as usize].joints[k as usize]
        .spans
        .as_ptr()
}

/// Runs one frame on the graph and the inputs in the buffers and returns the status count.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_update(h: *mut Handle, dt: f64) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    h.load();
    h.with_graph(|spring, graph| spring.update(graph, dt));
    h.publish();
    h.spring.statuses().len() as u32
}

/// Defers a reseed to the next update.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_reset(h: *mut Handle) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.reset();
}

/// The step accumulator.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_acc(h: *mut Handle) -> f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.acc()
}

/// Hands group `g`'s roots to a drive: 0 nothing to drive, 1 refused (attached), 2 done.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_enable_drive(h: *mut Handle, g: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.enable_drive(g as usize) as u32
}

/// Queues one drive pose for `hd_spring_calibrate_drive`.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_drive_pose(h: *mut Handle, x: f64, y: f64, z: f64, w: f64) {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }
        .spring
        .add_drive_pose(Quat::new(x, y, z, w));
}

/// Widens group `g`'s clearances over the queued poses: 0 nothing done, 1 refused, 2 done.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_calibrate_drive(h: *mut Handle, g: u32) -> u32 {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    h.load();
    let outcome = h.with_graph(|spring, graph| spring.calibrate_drive(graph, g as usize));
    h.publish();
    outcome as u32
}

/// Places pooled collider `c` on its bone's current world matrix and refreshes its state.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_collider_place(h: *mut Handle, c: u32) {
    // SAFETY: forwarded from this function's contract.
    let h = unsafe { handle(h) };
    let c = c as usize;
    h.with_graph(|spring, graph| spring.place_collider(graph, c));
    let placed = &h.spring.colliders()[c];
    put(
        &mut h.collider_states[COLLIDER_OUT * c..],
        &[
            placed.a.x, placed.a.y, placed.a.z, placed.b.x, placed.b.y, placed.b.z,
        ],
    );
}

/// Distance from a point to pooled collider `c`'s axis as last placed.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_spring_collider_nearest(
    h: *mut Handle,
    c: u32,
    x: f64,
    y: f64,
    z: f64,
) -> f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.colliders()[c as usize].nearest(&Vec3::new(x, y, z))
}

/// Distance from pooled collider `c`'s axis, as last placed, to a segment.
///
/// # Safety
/// As for `hd_spring_free`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_spring_collider_link_distance(
    h: *mut Handle,
    c: u32,
    x0: f64,
    y0: f64,
    z0: f64,
    x1: f64,
    y1: f64,
    z1: f64,
) -> f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { handle(h) }.spring.colliders()[c as usize]
        .link_distance(&Vec3::new(x0, y0, z0), &Vec3::new(x1, y1, z1))
}
