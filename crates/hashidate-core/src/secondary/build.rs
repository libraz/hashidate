//! Construction: the builder calls, the chain walk, the structural lists a step walks, and
//! calibration.
//!
//! The caller creates the solver over a built scene graph, registers colliders, then each group
//! between `begin_group` and `end_group`, then calls `build`. Nodes are the graph's indices.

use super::anchor::SkinPointAnchor;
use super::collider::{Collider, cluster_colliders};
use super::spring::{DriveOutcome, Group, Hung, Input, Joint, Spring};
use super::tree::Tree;
use super::{Status, StatusKind};
use crate::math::f::{js_max, js_min};
use crate::math::{Quat, Vec3};
use crate::scene::graph::{Graph, NO_NODE};

/// A group's figures, with the descriptor defaults already applied by the caller.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GroupSpec {
    /// Restoring force toward the rest direction.
    pub stiffness: f64,
    /// Fraction of velocity lost per step, clamped to 0..0.99 here.
    pub drag: f64,
    /// Constant acceleration along `gravity_dir`.
    pub gravity: f64,
    /// Normalised here.
    pub gravity_dir: Vec3,
    /// The swinging tail's own radius, for collision.
    pub radius: f64,
}

/// A group between `begin_group` and `end_group`.
#[derive(Clone, Debug)]
pub(crate) struct Draft {
    spec: GroupSpec,
    roots: Vec<u32>,
    anchor: Option<u32>,
    influences: Vec<(u32, f64, Vec3)>,
}

/// One link of a chain: a bone, and the children the run continues into.
type RunLink = (u32, Vec<u32>);

// spring.ts collectRuns
//
// Walk a chain from `root`, collecting one array of joints per unbranched run.
//
// A branch ends the run it is in — the bone that branches is still simulated, aiming at the
// average of its children — and each branch continues as a run of its own. Without this a forked
// chain would simulate down one arbitrary side and leave the rest rigid, which is exactly what a
// skirt hem is.
fn collect_runs(scene: &Tree, root: u32, out: &mut Vec<Vec<RunLink>>) {
    let mut run = Vec::new();
    let mut bone = root;
    loop {
        let kids: Vec<u32> = scene.bone_children(bone).collect();
        if kids.is_empty() {
            break;
        }
        run.push((bone, kids.clone()));
        if kids.len() > 1 {
            out.push(run);
            for k in kids {
                collect_runs(scene, k, out);
            }
            return;
        }
        bone = kids[0];
    }
    if !run.is_empty() {
        out.push(run);
    }
}

impl Joint {
    // spring.ts Joint.constructor
    fn new(scene: &mut Tree, bone: u32, parent: u32, kids: &[u32]) -> Self {
        let rest = scene.quaternion(bone);

        // Where the chain continues, in this bone's own coordinates. A branch point
        // aims at the average of its children, which is the only answer that does
        // not privilege one branch over another.
        let mut tail = Vec3::default();
        for &k in kids {
            tail.add(&scene.position(k));
        }
        tail.divide_scalar(kids.len() as f64);
        let mut axis = tail;

        // Length is measured in world units, not from the local translation. A
        // local translation is in the parent's units and this project has one avatar
        // authored in centimetres under a 0.01 armature scale — see the note in
        // `profile/bones.ts`. The solver works entirely in world space, so this must too.
        scene.update_world_matrix_parents(bone);
        let world = scene.matrix_world(bone);
        let mut p = tail;
        let mut bp = Vec3::default();
        let length = p
            .apply_matrix4(&world)
            .distance_to(bp.set_from_matrix_position(&world));

        let valid = length > 1e-6 && axis.length_sq() > 1e-12;
        if valid {
            axis.normalize();
        }
        let across = if axis.x.abs() < 0.9 {
            Vec3::new(1.0, 0.0, 0.0)
        } else {
            Vec3::new(0.0, 1.0, 0.0)
        };
        let mut side = Vec3::default();
        side.cross_vectors(&axis, &across).normalize();
        Self {
            bone,
            parent,
            rest,
            // An additive rotation an outside layer may put on this joint's rest pose,
            // in the *parent's* frame. Only the root of a driven group carries one —
            // see `enable_drive` — and the flag keeps the extra work off the
            // several hundred joints that are pure secondary motion.
            driven: false,
            drive: Quat::default(),
            axis,
            length,
            cur: Vec3::default(),
            prev: Vec3::default(),
            solved_q: Quat::default(),
            prev_solved_q: Quat::default(),
            swing: Vec3::default(),
            side,
            valid,
            limits: Vec::new(),
            spans: Vec::new(),
            reach: Vec::new(),
            cluster_reach: Vec::new(),
            parent_quat: None,
            is_root: false,
        }
    }
}

/// The deepest node at or above `node` with no simulated node at or above it.
fn outside(scene: &Tree, simulated: &[bool], node: Option<u32>) -> Option<u32> {
    let mut found = None;
    let mut n = node;
    while let Some(i) = n {
        if simulated[i as usize] {
            found = None;
        } else if found.is_none() {
            found = Some(i);
        }
        n = scene.parent(i);
    }
    found
}

fn depth_of(scene: &Tree, node: u32) -> u32 {
    let mut d = 0;
    let mut n = scene.parent(node);
    while let Some(i) = n {
        d += 1;
        n = scene.parent(i);
    }
    d
}

impl Spring {
    // spring.ts Spring.constructor (the numeric part)
    //
    // An empty solver over an avatar whose root is node 0 of the scene graph it is given.
    pub fn new(graph: &Graph) -> Self {
        Self {
            nodes: graph.len() as u32,
            colliders: Vec::new(),
            groups: Vec::new(),
            enabled: true,
            // Operator-facing multipliers over the authored figures. They exist because
            // "does this avatar swing too much" is a judgement made by watching it, and
            // the answer has to be reachable without editing a descriptor and reloading.
            stiffness_scale: 1.0,
            inertia_scale: 1.0,
            gravity_scale: 1.0,
            acc: 0.0,
            pending: false,
            live: false,
            driven_joints: Vec::new(),
            inputs: Vec::new(),
            input_of: Vec::new(),
            rebase: Vec::new(),
            bridges: Vec::new(),
            step_rebase: Vec::new(),
            bridges_moved_by: Vec::new(),
            fixed_colliders: Vec::new(),
            far: Default::default(),
            statuses: Vec::new(),
            forced: Vec::new(),
            next_key: 0,
            draft: None,
            poses: Vec::new(),
            #[cfg(test)]
            after_place: None,
        }
    }

    // spring.ts Collider.constructor
    //
    // Registers a collider whose bone has resolved; returns its pool index.
    pub fn add_collider(
        &mut self,
        bone: u32,
        offset: Vec3,
        tail: Option<Vec3>,
        radius: f64,
        inside: bool,
    ) -> usize {
        assert!(bone < self.nodes, "collider bone {bone} is not a node");
        self.colliders
            .push(Collider::new(bone, offset, tail, radius, inside));
        self.colliders.len() - 1
    }

    pub fn begin_group(&mut self, spec: GroupSpec) {
        assert!(self.draft.is_none(), "a group is already open");
        self.draft = Some(Draft {
            spec,
            roots: Vec::new(),
            anchor: None,
            influences: Vec::new(),
        });
    }

    pub fn add_group_root(&mut self, node: u32) {
        assert!(node < self.nodes, "root {node} is not a node");
        self.draft_mut().roots.push(node);
    }

    /// Attaches the open group's single root to a skinned point.
    pub fn set_group_anchor(&mut self, root: u32) {
        assert!(root < self.nodes, "anchor root {root} is not a node");
        self.draft_mut().anchor = Some(root);
    }

    pub fn add_anchor_influence(&mut self, bone: u32, weight: f64, position: Vec3) {
        assert!(bone < self.nodes, "influence {bone} is not a node");
        self.draft_mut().influences.push((bone, weight, position));
    }

    fn draft_mut(&mut self) -> &mut Draft {
        self.draft.as_mut().expect("no group is open")
    }

    /// Builds the open group's joints and returns how many there are. A group with none is
    /// dropped, and the caller words why.
    pub fn end_group(&mut self, graph: &mut Graph) -> usize {
        let scene = &mut Tree::new(graph);
        let draft = self.draft.take().expect("no group is open");
        let anchor = draft.anchor.map(|root| {
            SkinPointAnchor::new(scene, root, &draft.influences)
                .expect("the anchor's contract was checked when it was resolved")
        });

        let mut runs = Vec::new();
        for &r in &draft.roots {
            collect_runs(scene, r, &mut runs);
        }
        let mut joints = Vec::new();
        for run in runs {
            for (bone, kids) in run {
                // A collected joint always has a parent by construction: every run is
                // walked down from a bone found by traversing the avatar root, so the
                // solver dereferences the parent per step without a check. This is
                // the one place that is established.
                let Some(parent) = scene.parent(bone) else {
                    continue;
                };
                let mut j = Joint::new(scene, bone, parent, &kids);
                // The joints an external drive is allowed to reach. Only the tops of
                // the chains: a drive is a pose for the base of an appendage, and the
                // rest of it is meant to trail behind rather than be posed too.
                j.is_root = draft.roots.contains(&bone);
                if j.valid {
                    joints.push(j);
                }
            }
        }
        if joints.is_empty() {
            return 0;
        }
        let spec = draft.spec;
        let mut gravity_dir = spec.gravity_dir;
        gravity_dir.normalize();
        let count = joints.len();
        self.groups.push(Group {
            key: self.next_key,
            enabled: true,
            was_enabled: true,
            joints,
            stiffness: spec.stiffness,
            drag: js_min(0.99, js_max(0.0, spec.drag)),
            gravity: spec.gravity,
            gravity_dir,
            radius: spec.radius,
            colliders: Vec::new(),
            anchor,
            clusters: None,
            moving_colliders: Vec::new(),
            rehung: false,
        });
        self.next_key += 1;
        count
    }

    /// Adds a pooled collider to the last group built.
    pub fn add_group_collider(&mut self, collider: usize) {
        assert!(
            collider < self.colliders.len(),
            "collider {collider} is not registered"
        );
        self.groups
            .last_mut()
            .expect("no group has been built")
            .colliders
            .push(collider);
    }

    /// Finishes construction. Groups an anchor check removes, and anchors that fail their first
    /// placement, are reported in `statuses`.
    pub fn build(&mut self, graph: &mut Graph) {
        assert!(self.draft.is_none(), "a group is still open");
        let scene = &mut Tree::new(graph);
        self.statuses.clear();
        self.statuses.reserve(self.max_statuses());
        self.validate_anchors(scene);
        self.collect_inputs(scene);
        self.select_nodes(scene);
        let widest = self.groups.iter().map(|g| g.colliders.len()).max();
        self.far.marks.resize(widest.unwrap_or(0), 0);
        self.calibrate(scene);
        self.reset();
    }

    // spring.ts Spring.#validateAnchors
    fn validate_anchors(&mut self, scene: &Tree) {
        if !self.groups.iter().any(|g| g.anchor.is_some()) {
            return;
        }
        let mut owners: Vec<Vec<usize>> = vec![Vec::new(); scene.len()];
        for (k, group) in self.groups.iter().enumerate() {
            for joint in &group.joints {
                owners[joint.bone as usize].push(k);
            }
        }

        let count = self.groups.len();
        let mut removed = vec![false; count];
        let mut earlier = vec![false; count];
        for k in 0..count {
            let Some(anchor) = &self.groups[k].anchor else {
                earlier[k] = true;
                continue;
            };
            let has_other_owner = |node: u32, removed: &[bool]| {
                owners[node as usize]
                    .iter()
                    .any(|&owner| owner != k && !removed[owner])
            };
            let mut problem: Option<(StatusKind, u32, u32)> = None;

            let mut current = Some(anchor.root);
            while let Some(c) = current {
                if has_other_owner(c, &removed) {
                    problem = Some((StatusKind::AncestorSimulated, c, NO_NODE));
                    break;
                }
                current = scene.parent(c);
            }
            if problem.is_none() {
                problem = std::iter::once(anchor.root)
                    .chain(anchor.subtree_nodes())
                    .find(|&node| has_other_owner(node, &removed))
                    .map(|node| (StatusKind::SubtreeSimulated, node, NO_NODE));
            }
            if problem.is_none() {
                'influences: for influence in &anchor.influences {
                    let mut current = Some(influence.bone);
                    while let Some(c) = current {
                        for &owner in &owners[c as usize] {
                            if removed[owner] {
                                continue;
                            }
                            if !earlier[owner] {
                                problem = Some((
                                    StatusKind::SourceDepends,
                                    influence.bone,
                                    self.groups[owner].key,
                                ));
                                break 'influences;
                            }
                        }
                        current = scene.parent(c);
                    }
                }
            }
            if let Some((kind, node, other)) = problem {
                self.statuses.push(Status {
                    kind,
                    group: self.groups[k].key,
                    node,
                    other,
                });
                removed[k] = true;
            }
            earlier[k] = true;
        }
        let mut k = 0;
        self.groups.retain(|_| {
            k += 1;
            !removed[k - 1]
        });
    }

    // spring.ts Spring.#collectInputs
    fn collect_inputs(&mut self, scene: &Tree) {
        let n = scene.len();
        let mut simulated = vec![false; n];
        for g in &self.groups {
            for j in &g.joints {
                simulated[j.bone as usize] = true;
            }
        }
        self.input_of = vec![NO_NODE; n];
        let mut depth: Vec<Option<u32>> = vec![None; n];

        let Self {
            groups,
            colliders,
            inputs,
            input_of,
            bridges,
            rebase,
            fixed_colliders,
            ..
        } = self;
        let mut add = |node: u32, inputs: &mut Vec<Input>| -> usize {
            let known = input_of[node as usize];
            if known != NO_NODE {
                return known as usize;
            }
            inputs.push(Input::new(node));
            input_of[node as usize] = (inputs.len() - 1) as u32;
            inputs.len() - 1
        };
        // Every unsimulated node from `node` up to the simulated joint carrying it.
        let bridge = |node: u32, depth: &mut [Option<u32>], bridges: &mut Vec<Hung>| {
            if outside(scene, &simulated, Some(node)) == Some(node) {
                return;
            }
            let mut n = Some(node);
            while let Some(i) = n {
                if simulated[i as usize] {
                    break;
                }
                n = scene.parent(i);
                let Some(parent) = n else {
                    continue;
                };
                if depth[i as usize].is_some() {
                    continue;
                }
                depth[i as usize] = Some(depth_of(scene, i));
                bridges.push(Hung { node: i, parent });
            }
        };
        for g in groups.iter_mut() {
            let anchored = g.anchor.is_some();
            if !anchored {
                g.rehung = true;
            }
            for j in &mut g.joints {
                if outside(scene, &simulated, Some(j.parent)) == Some(j.parent) {
                    j.parent_quat = Some(add(j.parent, inputs));
                }
                if anchored {
                    continue;
                }
                if !simulated[j.parent as usize] {
                    bridge(j.parent, &mut depth, bridges);
                }
                depth[j.bone as usize] = Some(depth_of(scene, j.bone));
                rebase.push(Hung {
                    node: j.bone,
                    parent: j.parent,
                });
            }
            let mut moving = Vec::new();
            for &c in &g.colliders {
                let bone = colliders[c].bone;
                if outside(scene, &simulated, Some(bone)) == Some(bone) {
                    let input = add(bone, inputs);
                    if !fixed_colliders.iter().any(|&(f, _)| f == c) {
                        fixed_colliders.push((c, input));
                    }
                } else {
                    if !simulated[bone as usize] {
                        bridge(bone, &mut depth, bridges);
                    }
                    moving.push(c);
                }
            }
            g.moving_colliders = moving;
            if let Some(anchor) = &g.anchor {
                if let Some(parent) = outside(scene, &simulated, scene.parent(anchor.root)) {
                    add(parent, inputs);
                }
                for influence in &anchor.influences {
                    if let Some(source) = outside(scene, &simulated, Some(influence.bone)) {
                        add(source, inputs);
                    }
                }
            }
        }
        let depth_key = |h: &Hung| depth[h.node as usize].unwrap_or(0);
        bridges.sort_by_key(depth_key);
        let mut groups_of: Vec<Vec<usize>> = vec![Vec::new(); n];
        for (k, g) in groups.iter().enumerate() {
            for j in &g.joints {
                groups_of[j.bone as usize].push(k);
            }
        }
        self.bridges_moved_by = vec![Vec::new(); groups.len()];
        for &b in bridges.iter() {
            let mut owner = scene.parent(b.node);
            while let Some(o) = owner {
                if simulated[o as usize] {
                    break;
                }
                owner = scene.parent(o);
            }
            let mut movers: Vec<usize> = Vec::new();
            for &k in owner.map_or(&[][..], |o| groups_of[o as usize].as_slice()) {
                if !movers.contains(&k) {
                    movers.push(k);
                }
            }
            for (k, g) in groups.iter().enumerate() {
                let Some(root) = g.anchor.as_ref().map(|a| a.root) else {
                    continue;
                };
                let mut n = Some(b.node);
                while let Some(i) = n {
                    if i == root && !movers.contains(&k) {
                        movers.push(k);
                    }
                    n = scene.parent(i);
                }
            }
            for k in movers {
                self.bridges_moved_by[k].push(b);
            }
        }
        rebase.extend(bridges.iter().copied());
        rebase.sort_by_key(depth_key);
        self.collect_step_rebase(n);
    }

    // spring.ts Spring.#collectStepRebase
    //
    // Walk a step in `step`'s order and keep what is read before it is written. An attached group
    // is taken to write nothing and to read as if running, as either may change at runtime.
    fn collect_step_rebase(&mut self, n: usize) {
        let mut parent_of: Vec<Option<u32>> = vec![None; n];
        for h in &self.rebase {
            parent_of[h.node as usize] = Some(h.parent);
        }
        let mut written = vec![false; n];
        let mut read = vec![false; n];
        let mut read_order = Vec::new();
        let mut reads = |node: u32, written: &[bool], read: &mut [bool]| {
            if parent_of[node as usize].is_some() && !written[node as usize] && !read[node as usize]
            {
                read[node as usize] = true;
                read_order.push(node);
            }
        };
        for g in &self.groups {
            for b in &self.bridges {
                reads(b.parent, &written, &mut read);
                written[b.node as usize] = true;
            }
            for &c in &g.moving_colliders {
                reads(self.colliders[c].bone, &written, &mut read);
            }
            for j in &g.joints {
                reads(j.parent, &written, &mut read);
                if g.anchor.is_none() {
                    written[j.bone as usize] = true;
                }
            }
        }
        for node in read_order {
            let mut p = parent_of[node as usize];
            while let Some(i) = p {
                if parent_of[i as usize].is_none() {
                    break;
                }
                read[i as usize] = true;
                p = parent_of[i as usize];
            }
        }
        self.step_rebase = self
            .rebase
            .iter()
            .copied()
            .filter(|h| read[h.node as usize])
            .collect();
    }

    /// Picks the nodes an update reads: joints and what they hang from, bridges, collider bones,
    /// inputs, and each anchor's paths and subtree, closed over ancestors so a world update over
    /// them forms every matrix from a parent formed in the same pass. The table's share is what
    /// the solver's own world updates reach.
    fn select_nodes(&mut self, scene: &Tree) {
        let mut marked = vec![false; scene.len()];
        let mut mark = |node: u32| marked[node as usize] = true;
        for g in &self.groups {
            for j in &g.joints {
                mark(j.bone);
                mark(j.parent);
            }
            for &c in &g.colliders {
                mark(self.colliders[c].bone);
            }
            if let Some(anchor) = &g.anchor {
                mark(anchor.root);
                anchor.path_nodes().for_each(&mut mark);
                anchor.subtree_nodes().for_each(&mut mark);
            }
        }
        for h in self.rebase.iter().chain(&self.bridges) {
            mark(h.node);
            mark(h.parent);
        }
        for input in &self.inputs {
            mark(input.node);
        }
        // Ascending, so a node's ancestors are closed over before anything below it is reached.
        for i in 0..scene.len() as u32 {
            if !marked[i as usize] {
                continue;
            }
            let mut p = scene.parent(i);
            while let Some(q) = p {
                if marked[q as usize] {
                    break;
                }
                marked[q as usize] = true;
                p = scene.parent(q);
            }
        }
        self.forced = (0..scene.nodes()).filter(|&i| marked[i as usize]).collect();
    }

    /// Clearance for joint `j` of group `g` against each of the group's colliders as placed.
    fn measure(&mut self, scene: &Tree, k: usize, first: bool) {
        let Self {
            groups, colliders, ..
        } = self;
        let g = &mut groups[k];
        let radius = g.radius;
        for j in &mut g.joints {
            let bp = scene.world_position(j.bone);
            for (i, &c) in g.colliders.iter().enumerate() {
                let c = &colliders[c];
                let dist = c.nearest(&j.cur);
                let limit = if first {
                    if c.inside {
                        js_max(c.radius - radius, dist)
                    } else {
                        js_min(c.radius + radius, dist)
                    }
                } else {
                    let limit = f64::from(j.limits[i]);
                    if c.inside {
                        js_max(limit, dist)
                    } else {
                        js_min(limit, dist)
                    }
                };
                j.limits[i] = limit as f32;
                if !c.inside {
                    let span = if first {
                        c.radius + radius
                    } else {
                        f64::from(j.spans[i])
                    };
                    j.spans[i] = js_min(span, c.link_distance(&bp, &j.cur)) as f32;
                }
            }
        }
    }

    // spring.ts Spring.#calibrate
    //
    // Decide, per joint and per collider, how much clearance to actually enforce.
    //
    // The obvious answer is the sum of the two radii, and it is wrong often enough to matter.
    // Both avatars here carry collider sets that were machine-converted from another system —
    // `PhysBone` on one, and on the other a VRM produced by a converter rather than by hand — and
    // a converted collider routinely ends up larger or further forward than the one it stands
    // for. The result is a collider that the model's *own bind pose* is already deep inside: this
    // avatar's apron sits 5 cm inside a 10 cm sphere at the hip, and its tail starts 13 cm inside
    // the 20 cm sphere behind it.
    //
    // Enforced literally, the first frame throws the apron out to the horizontal and stands the
    // tail up. Neither is secondary motion — it is the simulation rejecting the shape the model
    // was drawn in.
    //
    // So the bind pose wins. Where a joint already sits closer than the radii say it may, the
    // clearance for that pair is reduced to exactly where the artist put it. Nothing moves at
    // rest, and the collider still does its job in the direction that matters — the part can
    // swing away freely and cannot swing any further *in* than the model was drawn.
    //
    // Dropping such colliders instead would be simpler and gives up more than it needs to: a hair
    // strand that rests against the skull is not bad data, and it still wants the skull there
    // when the head turns.
    fn calibrate(&mut self, scene: &mut Tree) {
        scene.update_matrix_world_forced(&self.forced);
        for k in 0..self.groups.len() {
            self.place(scene, k, false);
            for j in &mut self.groups[k].joints {
                j.seed(scene);
            }
        }
        for k in 0..self.groups.len() {
            if self.groups[k].colliders.is_empty() {
                continue;
            }
            let Self {
                groups, colliders, ..
            } = self;
            let g = &mut groups[k];
            for &c in &g.colliders {
                colliders[c].place_on_bone(scene);
            }
            let clusters = cluster_colliders(&g.colliders, colliders);
            let n = g.colliders.len();
            for j in &mut g.joints {
                j.limits = vec![0.0; n];
                j.spans = vec![0.0; n];
            }
            g.clusters = Some(clusters);
            self.measure(scene, k, true);
            let g = &mut self.groups[k];
            let clusters = g.clusters.as_deref().unwrap_or(&[]);
            for j in &mut g.joints {
                j.fit_reach(clusters);
            }
        }
    }

    /// Queues one extreme of a drive's range for `calibrate_drive`.
    pub fn add_drive_pose(&mut self, pose: Quat) {
        self.poses.push(pose);
    }

    // spring.ts Spring.calibrateDrive
    //
    // Widen a driven group's clearance to cover the poses it will actually be put in, given as
    // the extremes of the drive's range (queued with `add_drive_pose`, and consumed here).
    //
    // The same argument as `calibrate`, one step further along. That pass lets the bind pose
    // overrule a converted collider because the shape the model was drawn in is not negotiable.
    // A driven range is the same kind of statement: the descriptor says how far this appendage
    // may be posed, and a collider that was machine-converted from another system does not get
    // to veto it.
    //
    // The case that forced it is one avatar's `Tail_C`, a 20 cm sphere the tail already starts
    // 13 cm inside. Calibrated against the bind pose alone, the tail may move away from it and
    // not one millimetre back, so the tail rises for joy exactly as intended and cannot drop for
    // sadness at all — half the performance, silently, on one avatar out of two. Sampling the
    // range instead leaves the collider doing the job it is there for: the tail still cannot be
    // *swung* into the backside by the simulation, it just is not stopped from being *posed*
    // where the avatar data says it may go.
    //
    // Sampled rather than solved. The drive is two rotations at stated maxima, so the corners of
    // that box bound everything between them closely enough, and this runs once at load.
    pub fn calibrate_drive(&mut self, graph: &mut Graph, group: usize) -> DriveOutcome {
        let scene = &mut Tree::new(graph);
        let poses = std::mem::take(&mut self.poses);
        let g = &self.groups[group];
        if g.anchor.is_some() {
            return DriveOutcome::Anchored;
        }
        if !(!g.colliders.is_empty() && g.root_joints().next().is_some() && !poses.is_empty()) {
            return DriveOutcome::None;
        }

        for q in &poses {
            for j in self.groups[group].joints.iter_mut().filter(|j| j.is_root) {
                j.drive.copy(q);
            }
            scene.update_matrix_world_forced(&self.forced);
            let Self {
                groups, colliders, ..
            } = self;
            let g = &mut groups[group];
            for j in &mut g.joints {
                j.seed(scene);
            }
            for &c in &g.colliders {
                colliders[c].place_on_bone(scene);
            }
            self.measure(scene, group, false);
        }

        let g = &mut self.groups[group];
        let clusters = g.clusters.as_deref().unwrap_or(&[]);
        for j in &mut g.joints {
            j.fit_reach(clusters);
        }
        for j in g.joints.iter_mut().filter(|j| j.is_root) {
            j.drive.identity();
        }
        scene.update_matrix_world_forced(&self.forced);
        for g in &mut self.groups {
            for j in &mut g.joints {
                j.seed(scene);
            }
        }
        self.reset();
        DriveOutcome::Done
    }
}
