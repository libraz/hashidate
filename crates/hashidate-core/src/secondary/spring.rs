//! The Verlet solver: joints, frame inputs, the fixed-step drive and what it writes.
//!
//! Construction, calibration and the structural lists the step walks are in `build.rs`; this file
//! is everything a frame runs.

use super::anchor::SkinPointAnchor;
use super::collider::{Cluster, Collider, Far, cull, refit_clusters};
use super::{CULL_MARGIN, MAX_STEPS, STEP, Status};
use crate::math::f::{js_max, js_min, sqrt};
use crate::math::{Mat4, Quat, Vec3};
use crate::scene::{NONE, Scene};

/// One simulated joint.
///
/// The tail is stored in world space rather than as an angle. Angles need a reference frame, and
/// the reference frame here is a bone that is itself moving — the whole point of the exercise. A
/// world-space point needs none, and falls out of the constraint that the bone cannot stretch.
#[derive(Clone, Debug)]
pub struct Joint {
    pub bone: u32,
    /// What the bone hangs from. Fixed at construction; see the chain walk.
    pub parent: u32,
    pub rest: Quat,
    pub driven: bool,
    pub drive: Quat,
    pub axis: Vec3,
    pub length: f64,
    pub cur: Vec3,
    pub prev: Vec3,
    /// Local rotation solved by the last step, and by the one before it.
    pub solved_q: Quat,
    pub prev_solved_q: Quat,
    /// World axis of the last swing toward the tail, zero until there is one.
    pub swing: Vec3,
    /// A direction square to `axis`, in this bone's own coordinates.
    pub side: Vec3,
    pub valid: bool,
    /// Clearance per collider of this joint's group, filled in by calibration.
    pub limits: Vec<f32>,
    /// The same for the whole link, root to tail, against outside colliders.
    pub spans: Vec<f32>,
    /// Squared cull distance per collider, from `limits` and `spans`; see `Collider::beyond`.
    pub reach: Vec<f64>,
    /// Per cluster of the group's colliders, the widest of its members' cull distances,
    /// unsquared.
    pub cluster_reach: Vec<f64>,
    /// The input whose rotation is the parent's, refreshed once per step, if no chain moves the
    /// parent.
    pub parent_quat: Option<usize>,
    /// Whether the bone is one of its group's roots, which a drive may reach.
    pub is_root: bool,
}

impl Joint {
    // spring.ts Joint.restQuat
    //
    // This joint's local rotation at rest, drive included.
    pub fn rest_quat(&self) -> Quat {
        if self.driven {
            let mut out = self.drive;
            out.multiply(&self.rest);
            out
        } else {
            self.rest
        }
    }

    // spring.ts Joint.restDir
    //
    // Rest direction of this bone in world space, given its parent's rotation.
    pub fn rest_dir(&self, parent_q: &Quat) -> Vec3 {
        let mut out = self.axis;
        out.apply_quaternion(&self.rest);
        if self.driven {
            out.apply_quaternion(&self.drive);
        }
        out.apply_quaternion(parent_q);
        out
    }

    /// `joint.restQuat(joint.bone.quaternion)`.
    pub(crate) fn restore_bone(&self, scene: &mut Scene) {
        scene.node_mut(self.bone).quaternion = self.rest_quat();
    }

    // spring.ts Joint.seed
    //
    // Drop the tail back onto the rest pose, killing all velocity.
    pub fn seed(&mut self, scene: &mut Scene) {
        let node = scene.node_mut(self.bone);
        node.quaternion = self.rest_quat();
        node.update_matrix();
        scene.hang(self.bone, self.parent);
        let rotation = scene.world_quat(self.bone);
        let origin = scene.world_position(self.bone);
        self.cur
            .copy(&self.axis)
            .multiply_scalar(self.length)
            .apply_quaternion(&rotation)
            .add(&origin);
        self.prev.copy(&self.cur);
        self.solved_q.copy(&scene.node(self.bone).quaternion);
        self.prev_solved_q.copy(&self.solved_q);
        self.swing.set(0.0, 0.0, 0.0);
    }

    // spring.ts Joint.present
    //
    // Write the rotation `s` of the way from the previous step's result to the last one's. Above
    // 1 it continues past the last result along the same arc.
    pub fn present(&self, scene: &mut Scene, s: f64) {
        let mut solved = Quat::default();
        solved.slerp_quaternions(&self.prev_solved_q, &self.solved_q, s);
        let node = scene.node_mut(self.bone);
        node.quaternion = solved;
        node.update_matrix();
    }

    // spring.ts Joint.fitReach
    //
    // Recompute `reach` and `cluster_reach` after calibration has changed `limits` or `spans`.
    pub fn fit_reach(&mut self, clusters: &[Cluster]) {
        self.reach = self
            .limits
            .iter()
            .zip(&self.spans)
            .map(|(&limit, &span)| {
                let r = (self.length + js_max(f64::from(limit), f64::from(span))) * CULL_MARGIN;
                r * r
            })
            .collect();
        self.cluster_reach = vec![0.0; clusters.len()];
        for (q, cluster) in clusters.iter().enumerate() {
            for &i in &cluster.members {
                self.cluster_reach[q] = js_max(self.cluster_reach[q], sqrt(self.reach[i]));
            }
        }
    }
}

/// A node no chain moves whose world transform a step reads — what a chain hangs from, a
/// collider's bone, an attachment's body side — held for this frame and the last so a step
/// between them can read the body between them.
#[derive(Clone, Debug)]
pub struct Input {
    pub node: u32,
    /// This frame's world matrix, exactly as the frame posed it.
    world: Mat4,
    /// The world matrix a step between the two frames reads.
    between: Mat4,
    /// World rotation of the node's current matrix, refreshed once per step.
    pub quat: Quat,
    pos: Vec3,
    rot: Quat,
    scale: Vec3,
    prev_pos: Vec3,
    prev_rot: Quat,
    prev_scale: Vec3,
}

impl Input {
    pub(crate) fn new(node: u32) -> Self {
        Self {
            node,
            world: Mat4::default(),
            between: Mat4::default(),
            quat: Quat::default(),
            pos: Vec3::default(),
            rot: Quat::default(),
            scale: Vec3::default(),
            prev_pos: Vec3::default(),
            prev_rot: Quat::default(),
            prev_scale: Vec3::default(),
        }
    }

    // spring.ts Input.capture
    //
    // Take this frame's transform, keeping the last one as the start of the interval.
    fn capture(&mut self, scene: &Scene) {
        self.snap();
        self.world.copy(&scene.node(self.node).matrix_world);
        self.world
            .decompose(&mut self.pos, &mut self.rot, &mut self.scale);
    }

    // spring.ts Input.snap
    //
    // Drop the last frame, so nothing is interpolated across a discontinuity.
    pub(crate) fn snap(&mut self) {
        self.prev_pos.copy(&self.pos);
        self.prev_rot.copy(&self.rot);
        self.prev_scale.copy(&self.scale);
    }

    // spring.ts Input.at
    //
    // Pose the node `s` of the way from the last frame to this one.
    fn at(&mut self, scene: &mut Scene, s: f64) {
        let mut ip = Vec3::default();
        let mut iq = Quat::default();
        let mut is = Vec3::default();
        ip.lerp_vectors(&self.prev_pos, &self.pos, s);
        iq.slerp_quaternions(&self.prev_rot, &self.rot, s);
        is.lerp_vectors(&self.prev_scale, &self.scale, s);
        self.between.compose(&ip, &iq, &is);
        scene.node_mut(self.node).matrix_world.copy(&self.between);
    }

    // spring.ts Input.end
    //
    // Put this frame's transform back.
    fn end(&self, scene: &mut Scene) {
        scene.node_mut(self.node).matrix_world.copy(&self.world);
    }
}

/// Each input's `between` matrix by node, for attachments composing from it.
pub struct InputWorld<'a> {
    of_node: &'a [u32],
    inputs: &'a [Input],
}

impl InputWorld<'_> {
    pub(crate) fn get(&self, node: u32) -> Option<&Mat4> {
        let input = self.of_node[node as usize];
        (input != NONE).then(|| &self.inputs[input as usize].between)
    }
}

/// A node hung from its parent by hand, as a world update would.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hung {
    pub node: u32,
    pub parent: u32,
}

/// One simulated chain, with the descriptor's figures resolved onto it.
#[derive(Clone, Debug)]
pub struct Group {
    /// The order the group was registered in, which status codes name it by.
    pub key: u32,
    pub enabled: bool,
    /// Internal edge state, so toggling a group restores or reseeds only its own chain.
    pub(crate) was_enabled: bool,
    pub joints: Vec<Joint>,
    pub stiffness: f64,
    pub drag: f64,
    pub gravity: f64,
    pub gravity_dir: Vec3,
    pub radius: f64,
    /// Indices into the collider pool, in the group's order.
    pub colliders: Vec<usize>,
    /// Optional root placement driven by a skinned point on earlier groups.
    pub anchor: Option<SkinPointAnchor>,
    /// The group's colliders, partitioned for culling; see `Cluster`.
    pub(crate) clusters: Option<Vec<Cluster>>,
    /// The group's colliders on a node a chain moves, placed in turn.
    pub(crate) moving_colliders: Vec<usize>,
    /// Whether `rehang` re-hangs every joint of the group.
    pub(crate) rehung: bool,
}

impl Group {
    /// Positions in `joints` of the group's roots.
    pub fn root_joints(&self) -> impl Iterator<Item = usize> + '_ {
        self.joints
            .iter()
            .enumerate()
            .filter(|(_, j)| j.is_root)
            .map(|(k, _)| k)
    }
}

// spring.ts hungOrigin
//
// Origin of `bone` hung from its parent's world matrix `parent`, formed term for term as
// `updateMatrix` and `multiplyMatrices` would form it. A pivot moves the origin with the rotation,
// so a bone with one returns `None` and is left alone.
fn hung_origin(scene: &Scene, bone: u32, parent: u32) -> Option<Vec3> {
    let node = scene.node(bone);
    if node.pivot.is_some() {
        return None;
    }
    let e = &scene.node(parent).matrix_world.elements;
    let Vec3 { x, y, z } = node.position;
    Some(Vec3::new(
        e[0] * x + e[4] * y + e[8] * z + e[12],
        e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14],
    ))
}

// spring.ts Spring.#rehang
//
// Recompute unattached joints' world matrices from their parents, as a world update would.
fn rehang(scene: &mut Scene, nodes: &[Hung]) {
    for h in nodes {
        scene.hang(h.node, h.parent);
    }
}

/// The secondary-motion solver over one avatar.
#[derive(Clone, Debug)]
pub struct Spring {
    pub(crate) scene: Scene,
    /// The avatar root; nodes before it are its ancestors.
    pub(crate) root: u32,
    pub(crate) colliders: Vec<Collider>,
    pub(crate) groups: Vec<Group>,

    pub enabled: bool,
    pub stiffness_scale: f64,
    pub inertia_scale: f64,
    pub gravity_scale: f64,

    pub(crate) acc: f64,
    pub(crate) pending: bool,
    pub(crate) live: bool,

    /// Every joint currently under an external drive, as `(group, joint)`.
    pub(crate) driven_joints: Vec<(usize, usize)>,
    pub(crate) inputs: Vec<Input>,
    /// Per node, its input, or `NONE`.
    pub(crate) input_of: Vec<u32>,
    /// Unattached joints and bridges, shallowest first, for re-hanging chains on an interpolated
    /// body.
    pub(crate) rebase: Vec<Hung>,
    /// Unsimulated nodes between a simulated joint and something a step reads, such as a chain
    /// hung from a plain node riding on another chain. Shallowest first.
    pub(crate) bridges: Vec<Hung>,
    /// The part of `rebase` a step reads before it re-hangs it itself, and what that hangs from:
    /// a step re-hangs every other entry before anything reads it.
    pub(crate) step_rebase: Vec<Hung>,
    /// Per group, the bridges its pass can move: those hanging from a joint it simulates or
    /// inside the subtree its attachment rewrites. Any other bridge would be re-hung onto an
    /// unchanged parent, to the same matrix.
    pub(crate) bridges_moved_by: Vec<Vec<Hung>>,
    /// Colliders on a node no chain moves, which holds still through a step and so is placed
    /// once per step rather than once per group sharing it, as `(collider, input)`.
    pub(crate) fixed_colliders: Vec<(usize, usize)>,
    pub(crate) far: Far,
    pub(crate) statuses: Vec<Status>,

    /// Every node the solver reads, ascending.
    pub(crate) read_nodes: Vec<u32>,
    /// The read nodes at or below the root: what a world update from the root reaches.
    pub(crate) forced: Vec<u32>,

    pub(crate) next_key: u32,
    pub(crate) draft: Option<super::build::Draft>,
    pub(crate) poses: Vec<Quat>,

    /// A node whose world matrix is refreshed from its ancestors after each anchor placement,
    /// which places without the frame's inputs: a stale-matrix injection for a negative control.
    #[cfg(test)]
    pub(crate) after_place: Option<u32>,
}

impl Spring {
    /// The node table the solver reads and writes.
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    pub fn scene_mut(&mut self) -> &mut Scene {
        &mut self.scene
    }

    pub fn groups(&self) -> &[Group] {
        &self.groups
    }

    pub fn groups_mut(&mut self) -> &mut [Group] {
        &mut self.groups
    }

    pub fn colliders(&self) -> &[Collider] {
        &self.colliders
    }

    pub fn colliders_mut(&mut self) -> &mut [Collider] {
        &mut self.colliders
    }

    /// What the last call reported, in the order it happened.
    pub fn statuses(&self) -> &[Status] {
        &self.statuses
    }

    /// Most statuses one call can report: each group once while anchors are checked and once
    /// more per placement pass.
    pub fn max_statuses(&self) -> usize {
        2 * self.next_key as usize + 1
    }

    /// Places pooled collider `c` on its bone's current world matrix.
    pub fn place_collider(&mut self, c: usize) {
        self.colliders[c].place_on_bone(&self.scene);
    }

    /// The step accumulator.
    pub fn acc(&self) -> f64 {
        self.acc
    }

    /// Every node the solver reads, ascending.
    pub fn read_nodes(&self) -> &[u32] {
        &self.read_nodes
    }

    /// Every node an update may write, ascending: the read nodes at or below the root.
    pub fn write_nodes(&self) -> &[u32] {
        &self.forced
    }

    // spring.ts Spring.active
    //
    // Whether this avatar has any secondary motion at all.
    pub fn active(&self) -> bool {
        !self.groups.is_empty()
    }

    // spring.ts Spring.count
    //
    // Simulated joints, across every group.
    pub fn count(&self) -> usize {
        self.groups.iter().map(|g| g.joints.len()).sum()
    }

    // spring.ts Spring.reset
    //
    // Drop everything back to the rest pose.
    //
    // Deferred to the next update rather than done here, because the caller is usually a button
    // on the panel and the pose at that moment is whatever the last frame left — seeding from it
    // would bake a mid-swing pose in as the thing the hair returns to.
    pub fn reset(&mut self) {
        self.pending = true;
    }

    // spring.ts Spring.#seed
    pub(crate) fn seed(&mut self) {
        self.scene.update_matrix_world_forced(&self.forced);
        for input in &mut self.inputs {
            input.snap();
        }
        for k in 0..self.groups.len() {
            if self.groups[k].enabled {
                self.place(k, false);
                let Self { scene, groups, .. } = self;
                for j in &mut groups[k].joints {
                    j.seed(scene);
                }
            } else {
                let Self { scene, groups, .. } = self;
                for j in &groups[k].joints {
                    j.restore_bone(scene);
                    scene.node_mut(j.bone).update_matrix();
                }
            }
            let g = &mut self.groups[k];
            g.was_enabled = g.enabled;
        }
        // A disabled anchor is placed once more after enabled producers have been
        // reseeded. Its first placement above may have read their pre-reset pose.
        rehang(&mut self.scene, &self.rebase);
        for k in 0..self.groups.len() {
            if self.groups[k].anchor.is_some() && !self.groups[k].enabled {
                self.place(k, false);
            }
        }
    }

    // spring.ts Spring.#place
    //
    // Place a group's anchor. An anchor guards its contract on every placement (a bone's scale
    // can change at runtime), and a violation must not escape into the render loop: the group is
    // switched off and the reason recorded.
    pub(crate) fn place(&mut self, k: usize, with_inputs: bool) {
        #[cfg(test)]
        let after_place = self.after_place;
        #[cfg(test)]
        let with_inputs = with_inputs && after_place.is_none();
        let Self {
            scene,
            groups,
            inputs,
            input_of,
            statuses,
            ..
        } = self;
        let g = &mut groups[k];
        let Some(anchor) = g.anchor.as_mut() else {
            return;
        };
        let world = InputWorld {
            of_node: input_of,
            inputs,
        };
        let placed = anchor.place(scene, with_inputs.then_some(&world));
        #[cfg(test)]
        if let Some(node) = after_place {
            scene.update_world_matrix_parents(node);
        }
        if let Err(failure) = placed {
            statuses.push(Status {
                kind: failure.kind,
                group: g.key,
                node: failure.node,
                other: NONE,
            });
            g.enabled = false;
            g.was_enabled = false;
            g.anchor = None;
        }
    }

    // spring.ts Spring.#placeAnchors
    fn place_anchors(&mut self) {
        for k in 0..self.groups.len() {
            self.place(k, false);
        }
    }

    // spring.ts Spring.#syncGroupToggles
    fn sync_group_toggles(&mut self) {
        // Restore every disabled group on every frame, rather than only on the
        // edge. A driven rest pose can change while a group is off, and its local
        // rotations must follow that drive before an attachment reads its bones.
        let mut rehang_all = false;
        {
            let Self { scene, groups, .. } = self;
            for g in groups.iter() {
                if !g.enabled {
                    for joint in &g.joints {
                        joint.restore_bone(scene);
                        scene.node_mut(joint.bone).update_matrix();
                    }
                    if g.anchor.is_none() {
                        rehang_all = true;
                    }
                }
            }
        }
        if rehang_all {
            rehang(&mut self.scene, &self.rebase);
        }

        for k in 0..self.groups.len() {
            let g = &self.groups[k];
            if g.was_enabled == g.enabled {
                if !g.enabled && g.anchor.is_some() {
                    self.place(k, false);
                }
                continue;
            }
            let enabled = g.enabled;
            self.groups[k].was_enabled = enabled;
            if enabled {
                self.place(k, false);
                let Self { scene, groups, .. } = self;
                for joint in &mut groups[k].joints {
                    joint.seed(scene);
                }
            } else if self.groups[k].anchor.is_some() {
                self.place(k, false);
            }
        }
    }

    // spring.ts Spring.#restore
    //
    // Put every chain back where the model has it and leave it there.
    //
    // Switching the simulation off has to do this. A spring writes local rotations and nothing
    // else writes them back — so simply *stopping* leaves the last solved frame on the bones
    // forever, and what looks like the model's own pose is a mid-swing snapshot. That is worse
    // than either state, and it makes an off/on comparison meaningless.
    fn restore(&mut self) {
        for g in &self.groups {
            for j in &g.joints {
                j.restore_bone(&mut self.scene);
            }
        }
    }

    // spring.ts Spring.update
    //
    // Advance the simulation and write the result onto the bones.
    //
    // Must run after everything else has posed the body for this frame: the input to a spring is
    // where its parent ended up, so anything that moves a shoulder after this has run is a frame
    // of lag the hair never sees. The caller has already run the frame's world update from the
    // root (when enabled) and copied the read nodes in.
    pub fn update(&mut self, dt: f64) {
        self.statuses.clear();
        if self.groups.is_empty() {
            return;
        }

        if !self.enabled {
            if self.live {
                self.restore();
                self.live = false;
            }
            // A drive is animation, not physics, so switching the simulation off must
            // not freeze it — that would make the tail stop dead on a control whose
            // label promises nothing of the kind. Only the driven roots are rewritten;
            // everything below them stays where `restore` left it and the chain moves
            // as one rigid piece, which is the honest picture of the sway being off.
            for &(g, j) in &self.driven_joints {
                self.groups[g].joints[j].restore_bone(&mut self.scene);
            }
            self.place_anchors();
            return;
        }
        // Coming back on, the chains have been standing still while the body moved
        // out from under them. Carrying that stale state forward would read as a
        // flick on the first frame, so the simulation restarts from the pose.
        if !self.live {
            self.live = true;
            self.pending = true;
        }

        // The pose was written into local quaternions and nothing has propagated it
        // yet — the renderer would, but not until after this. Every world position
        // read below would otherwise be one frame stale, which reads as hair that
        // anticipates the head instead of following it. (The caller's world update.)
        for input in &mut self.inputs {
            input.capture(&self.scene);
        }
        self.sync_group_toggles();

        if self.pending {
            self.seed();
            self.pending = false;
            self.acc = 0.0;
            return;
        }

        let start = self.acc;
        self.acc = js_min(self.acc + dt, STEP * MAX_STEPS as f64);
        let span = self.acc - start;
        let mut between = false;
        while self.acc >= STEP {
            self.acc -= STEP;
            // What is left of the frame after this step says where in it the step
            // falls; a remainder that is only rounding is the frame's end.
            if self.acc > span * 1e-9 {
                let s = 1.0 - self.acc / span;
                for input in &mut self.inputs {
                    input.at(&mut self.scene, s);
                }
                self.step(STEP, true, true);
                between = true;
            } else {
                if between {
                    for input in &self.inputs {
                        input.end(&mut self.scene);
                    }
                }
                self.step(STEP, false, between);
                between = false;
            }
        }
        if between {
            // Hand the frame's own body back, and hang what is drawn on it.
            for input in &self.inputs {
                input.end(&mut self.scene);
            }
        }
        // The solver is up to a step behind the frame. Carry the last step's motion
        // forward by the unspent remainder: nothing moves on a frame that lands on a
        // step, and frames between steps keep moving with the head.
        let carry = 1.0 + self.acc / STEP;
        self.present(carry);
        rehang(&mut self.scene, &self.rebase);
        if carry > 1.0 && self.keep_clear() {
            rehang(&mut self.scene, &self.rebase);
        }
        self.place_anchors();
    }

    // spring.ts Spring.#keepClear
    //
    // Hold back any carried-forward link that would enter a collider, at its solved rotation. The
    // carry is never collision-checked otherwise, and a link swinging in is carried through the
    // surface the next step will stop it at. Returns whether anything was held back.
    fn keep_clear(&mut self) -> bool {
        let mut held = false;
        let mut placed = false;
        for k in 0..self.groups.len() {
            {
                let g = &self.groups[k];
                if !(g.enabled && !g.colliders.is_empty()) || g.anchor.is_some() {
                    continue;
                }
            }
            if !placed {
                self.place_fixed();
                placed = true;
            }
            let Self {
                scene,
                groups,
                colliders,
                far,
                ..
            } = self;
            let g = &mut groups[k];
            for &c in &g.moving_colliders {
                colliders[c].place_on_bone(scene);
            }
            let clusters: &mut [Cluster] = g.clusters.as_deref_mut().unwrap_or(&mut []);
            refit_clusters(clusters, &g.colliders, colliders);
            let rehung = g.rehung;
            for j in &g.joints {
                // An earlier link may have been held back, so hang this one again first.
                // Until one is, `rehang` has just formed this same matrix.
                if held || !rehung {
                    scene.hang(j.bone, j.parent);
                }
                let bp = scene.world_position(j.bone);
                // A link every collider is culled for cannot be held back.
                if !cull(&g.colliders, colliders, clusters, j, &bp, far) {
                    continue;
                }
                let mut next = j.axis;
                next.multiply_scalar(j.length)
                    .apply_quaternion(&scene.world_quat(j.bone))
                    .add(&bp);
                let mut inside = false;
                for (i, &c) in g.colliders.iter().enumerate() {
                    let c = &colliders[c];
                    if !inside && far.marks[i] != 0 {
                        continue;
                    }
                    if c.push(&mut next, f64::from(j.limits[i])) {
                        inside = true;
                    }
                    if c.clear_link(&bp, &mut next, j.length, f64::from(j.spans[i])) {
                        inside = true;
                    }
                }
                if !inside {
                    continue;
                }
                j.present(scene, 1.0);
                scene.hang(j.bone, j.parent);
                held = true;
            }
        }
        held
    }

    // spring.ts Spring.#placeFixed
    //
    // Read every input's rotation off its current matrix, and place the colliders on them.
    fn place_fixed(&mut self) {
        for input in &mut self.inputs {
            input.quat = self.scene.world_quat(input.node);
        }
        for &(c, input) in &self.fixed_colliders {
            self.colliders[c].place(&self.scene, &self.inputs[input].quat);
        }
    }

    // spring.ts Spring.#present
    //
    // Write every running group's rotations at `s`; see `Joint::present`.
    fn present(&mut self, s: f64) {
        for g in &self.groups {
            if !g.enabled {
                continue;
            }
            for j in &g.joints {
                j.present(&mut self.scene, s);
            }
        }
    }

    // spring.ts Spring.#step
    //
    // `with_inputs`: place attachments from the interpolated body, for a step before the frame's
    // last. `rebase`: re-hang unattached chains on the body this step reads, as the frame's own
    // world update does before its first step.
    fn step(&mut self, dt: f64, with_inputs: bool, rebase: bool) {
        if rebase {
            rehang(&mut self.scene, &self.step_rebase);
        }
        self.place_fixed();
        for k in 0..self.groups.len() {
            // A group may hang from a node an earlier group just moved: the first
            // re-hangs every bridge, each later one what the group before could move.
            let hung = if k == 0 {
                &self.bridges
            } else {
                &self.bridges_moved_by[k - 1]
            };
            rehang(&mut self.scene, hung);
            // Place after prior cloth/producer groups in this same fixed step, even
            // when this accessory group itself is switched off.
            self.place(k, with_inputs);
            let (stiffness_scale, gravity_scale, inertia_scale) =
                (self.stiffness_scale, self.gravity_scale, self.inertia_scale);
            let Self {
                scene,
                groups,
                colliders,
                inputs,
                far,
                ..
            } = self;
            let g = &mut groups[k];
            if !g.enabled {
                // An ordinary disabled group can still be a producer for an attached
                // group later in this pass. Keep its world matrices on its current
                // parent after an earlier group has solved it.
                if g.anchor.is_none() {
                    for j in &g.joints {
                        scene.hang(j.bone, j.parent);
                    }
                }
                continue;
            }
            for &c in &g.moving_colliders {
                colliders[c].place_on_bone(scene);
            }
            let clusters: &mut [Cluster] = g.clusters.as_deref_mut().unwrap_or(&mut []);
            refit_clusters(clusters, &g.colliders, colliders);

            let stiffness = g.stiffness * stiffness_scale * dt;
            let gravity = g.gravity * gravity_scale * dt;
            // Velocity retained per step. Scaled rather than the drag itself so the
            // control reads the way it behaves: more is a longer swing.
            let retain = js_min(0.995, js_max(0.0, (1.0 - g.drag) * inertia_scale));
            let anchor_root = g.anchor.as_ref().map(|a| a.root);
            let anchored = anchor_root.is_some();

            for j in &mut g.joints {
                let bone = j.bone;
                let parent = j.parent;
                // Every joint may have a solved parent from the preceding link. Read
                // this bone's origin from that fresh parent before integrating it;
                // only an attached root keeps the placement written by its anchor.
                // Nothing reads the rest of its world matrix before the end of this
                // link rewrites it, so only the origin is formed.
                let bp = if anchor_root == Some(bone) {
                    scene.world_position(bone)
                } else if let Some(origin) = hung_origin(scene, bone, parent) {
                    origin
                } else {
                    scene.node_mut(bone).update_matrix();
                    scene.hang(bone, parent);
                    scene.world_position(bone)
                };
                let mut pq = match j.parent_quat {
                    Some(input) => inputs[input].quat,
                    None => scene.world_quat(parent),
                };
                if anchored {
                    pq.normalize();
                }
                let mut dir = j.rest_dir(&pq);
                if anchored {
                    dir.normalize();
                }

                let mut vel = Vec3::default();
                vel.sub_vectors(&j.cur, &j.prev);
                let mut next = j.cur;
                next.add_scaled_vector(&vel, retain)
                    .add_scaled_vector(&dir, stiffness)
                    .add_scaled_vector(&g.gravity_dir, gravity);

                // The bone cannot stretch, so the tail is only ever allowed to change
                // direction. Everything above is a force; this is the constraint.
                let mut to = Vec3::default();
                to.sub_vectors(&next, &bp);
                if to.length_sq() < 1e-12 {
                    to.copy(&dir);
                }
                next.copy(&bp).add_scaled_vector(to.normalize(), j.length);

                if !g.colliders.is_empty() {
                    // Both passes below test from the same root, so each pair is culled once.
                    cull(&g.colliders, colliders, clusters, j, &bp, far);
                    // A moved tip is off its length, which `beyond` assumes, so the
                    // rest of the joint's colliders are tested in full.
                    let mut moved = false;
                    for (i, &c) in g.colliders.iter().enumerate() {
                        if !moved && far.marks[i] != 0 {
                            continue;
                        }
                        if colliders[c].push(&mut next, f64::from(j.limits[i])) {
                            moved = true;
                            #[cfg(test)]
                            {
                                far.contacts += 1;
                            }
                        }
                    }
                    // Collision moved the point off the sphere the length constraint put
                    // it on, so the constraint is reapplied. Doing it once at the end
                    // rather than after every collider costs a little accuracy where two
                    // colliders overlap and saves a square root per collider per joint.
                    to.sub_vectors(&next, &bp);
                    if to.length_sq() > 1e-12 {
                        next.copy(&bp).add_scaled_vector(to.normalize(), j.length);
                    }
                    // Then the rest of the link. This swing keeps the length by itself.
                    moved = false;
                    for (i, &c) in g.colliders.iter().enumerate() {
                        if !moved && far.marks[i] != 0 {
                            continue;
                        }
                        if colliders[c].clear_link(&bp, &mut next, j.length, f64::from(j.spans[i]))
                        {
                            moved = true;
                            #[cfg(test)]
                            {
                                far.contacts += 1;
                            }
                        }
                    }
                }

                j.prev.copy(&j.cur);
                j.cur.copy(&next);

                // Rotate the bone from where it rests to where its tail ended up. The
                // rest rotation is carried through rather than replaced, so a bone with
                // an axis that is not its local Y — which is most of them — is handled
                // without knowing anything about how the rig was built.
                to.sub_vectors(&j.cur, &bp).normalize();
                let mut aim = Quat::default();
                let mut ax = Vec3::default();
                if dir.dot(&to) < -0.999 {
                    // Nearly a half turn, where the shortest swing's axis is the cross of two
                    // almost opposite vectors and spins with any wobble, rolling the bone.
                    // Keep the last axis (or the rest pose's side) and flip about it instead.
                    ax.copy(&j.swing)
                        .add_scaled_vector(&dir, -j.swing.dot(&dir));
                    if ax.length_sq() < 1e-12 {
                        ax.copy(&j.side).apply_quaternion(&j.rest);
                        if j.driven {
                            ax.apply_quaternion(&j.drive);
                        }
                        ax.apply_quaternion(&pq);
                    }
                    j.swing.copy(ax.normalize());
                    let mut back = dir;
                    back.negate();
                    let mut flip = Quat::default();
                    flip.set_from_unit_vectors(&back, &to);
                    aim.set_from_axis_angle(&ax, std::f64::consts::PI)
                        .premultiply(&flip);
                } else {
                    aim.set_from_unit_vectors(&dir, &to);
                    ax.cross_vectors(&dir, &to);
                    if ax.length_sq() > 1e-12 {
                        j.swing.copy(ax.normalize());
                    }
                }
                let mut q = pq;
                if j.driven {
                    q.multiply(&j.drive);
                }
                q.multiply(&j.rest).premultiply(&aim);
                let mut solved = pq;
                solved.invert().multiply(&q);
                if anchored {
                    solved.normalize();
                }
                scene.node_mut(bone).quaternion = solved;
                j.prev_solved_q.copy(&j.solved_q);
                j.solved_q.copy(&solved);

                // The next joint down reads this bone's world matrix, and three will not
                // refresh it until render. Propagating one link by hand is cheaper than
                // an `updateMatrixWorld` per joint, which would walk the whole subtree
                // once per joint and turn a linear pass into a quadratic one.
                // The next joint reads this fresh world matrix, including the solved
                // origin and orientation of this link.
                scene.node_mut(bone).update_matrix();
                scene.hang(bone, parent);
            }
        }
    }

    // spring.ts Spring.enableDrive
    //
    // Hand a group's roots to a layer that wants to *drive* them.
    //
    // Secondary motion is defined by what nothing drives, so this is a deliberate hole in that
    // definition rather than an oversight. A tail is the case that needs it: it is a swinging
    // chain like the hair, but its only parent is the hips, and a standing character's hips
    // barely move — so left purely passive it is not slow, it is *still*. Hair gets away with
    // being passive because it hangs off a head that looks around.
    //
    // Driving the rest pose rather than the bone is what keeps the two layers from fighting. The
    // base is posed, the simulation still runs underneath it, and the rest of the chain arrives
    // late and overshoots exactly as it would if the body had swung the tail. The authored
    // stiffness and drag keep meaning what they meant.
    pub fn enable_drive(&mut self, group: usize) -> DriveOutcome {
        let g = &mut self.groups[group];
        if g.root_joints().next().is_none() {
            return DriveOutcome::None;
        }
        if g.anchor.is_some() {
            return DriveOutcome::Anchored;
        }
        for (k, j) in g.joints.iter_mut().enumerate() {
            if !j.is_root || j.driven {
                continue;
            }
            j.driven = true;
            self.driven_joints.push((group, k));
        }
        DriveOutcome::Done
    }
}

/// What `enable_drive` and `calibrate_drive` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum DriveOutcome {
    /// Nothing: the group has nothing a drive reaches, or nothing to calibrate.
    None = 0,
    /// Refused: an attached group's root cannot be driven.
    Anchored = 1,
    Done = 2,
}
