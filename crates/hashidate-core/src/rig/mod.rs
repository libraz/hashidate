//! The rig, ported from `src/engine/rig/`: one module per TS file.

pub mod arm_chain;
pub mod arm_configuration;
pub mod arm_driver;
pub mod arm_path;
pub mod arm_qp;
pub mod arm_route;
pub mod arm_twists;
pub mod elbow;
pub mod finger_axes;
pub mod finger_clearance;
pub mod girdle;
pub mod hand_geometry;
pub mod hands;
pub mod legs;
pub mod point;
pub mod reach;
pub mod skeleton;
pub mod spine;

/// What the rig's tests share: node access, the base avatar in the shapes the TS tests build,
/// and the arm wiring `Rig` gives the reach, elbow and point solvers.
#[cfg(test)]
pub(crate) mod testkit {
    use super::arm_chain::{ArmChain, ArmChainPort};
    use super::arm_configuration::{
        ArmCalibration, ArmConfiguration, ArmForwardContext, ArmForwardResult,
    };
    use super::arm_driver::{ArmDriver, DriverInput};
    use super::arm_twists::ArmTwists;
    use super::elbow::{ElbowContext, ElbowSearch};
    use super::hand_geometry::HandGeometryCalibration;
    use super::hands::FingerSpec;
    use super::hands::Hands;
    use super::point::{PointRequest, PointSolver};
    use super::reach::{ArmSolution, ReachLinks, length, solve_reach};
    use crate::anatomy::arm::ArmAnatomy;
    use crate::anatomy::joints::{FINGER_WIDTH, HAND_CONTACT, JointTable};
    use crate::anatomy::testkit as anatomy;
    use crate::math::{Mat4, Quat, Vec3};
    use crate::profile::{ArmSlot, BoneSlot, Finger, Profile, Side, base};
    use crate::scene::graph::{Graph, NO_NODE, RECORD, Shape, flag};

    /// `new Quaternion().setFromEuler(new Euler(x, y, z))`.
    pub fn euler(x: f64, y: f64, z: f64) -> Quat {
        *Quat::default().set_from_euler_xyz(x, y, z)
    }

    pub fn bone(p: &Profile, slot: BoneSlot) -> u32 {
        p.bone(slot)
            .unwrap_or_else(|| panic!("the base avatar has no {slot:?}"))
    }

    /// Every node's local quaternion as it stands, for a `restOf`.
    pub fn rest_table(g: &Graph) -> Vec<f64> {
        g.quaternion.clone()
    }

    /// `restOf` over a table from [`rest_table`].
    pub fn rest_of(table: &[f64]) -> impl Fn(u32) -> Quat + '_ {
        move |i| {
            let n = 4 * i as usize;
            Quat::new(table[n], table[n + 1], table[n + 2], table[n + 3])
        }
    }

    /// The base avatar with its world matrices current.
    pub fn avatar() -> (Graph, Profile) {
        anatomy::graph_and_profile(0.0, 1.0)
    }

    /// `armatureScale: 0.01`: the root scaled by a hundredth and every other node's offset
    /// stated a hundred times larger, so the world is unchanged and local units are centimetres.
    pub fn centimetre(g: &mut Graph) {
        for s in &mut g.scale[0..3] {
            *s *= 0.01;
        }
        for p in &mut g.position[3..] {
            *p /= 0.01;
        }
        g.update_matrix_world(0, true);
    }

    /// The base avatar with a plain node inserted between the root and the hips, the frame the
    /// legs then measure in. Returns the frame's node.
    pub fn with_frame_above_hips() -> (Graph, Profile, u32) {
        let (src, mut p) = base::avatar();
        let h = bone(&p, BoneSlot::Hips);
        let remap = |i: u32| if i == NO_NODE || i < h { i } else { i + 1 };
        let n = src.len();
        let mut g = Graph::new(Shape {
            nodes: n + 1,
            meshes: src.mesh_nodes.len(),
            skeletons: src.skeleton_offsets.len() - 1,
            bones: src.bone_nodes.len(),
        });
        let identity = Mat4::default();
        for i in 0..n {
            if i == h as usize {
                let mut r = [0.0; RECORD];
                r[3..7].copy_from_slice(&[0.0, 0.0, 0.0, 1.0]);
                r[7..10].copy_from_slice(&[1.0; 3]);
                r[13..29].copy_from_slice(&identity.elements);
                r[29..45].copy_from_slice(&identity.elements);
                g.push_node(
                    src.parent[i],
                    flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE,
                    &r,
                );
            }
            let mut r = [0.0; RECORD];
            r[0..3].copy_from_slice(&src.position[3 * i..3 * i + 3]);
            r[3..7].copy_from_slice(&src.quaternion[4 * i..4 * i + 4]);
            r[7..10].copy_from_slice(&src.scale[3 * i..3 * i + 3]);
            r[10..13].copy_from_slice(&src.pivot[3 * i..3 * i + 3]);
            r[13..29].copy_from_slice(&src.matrix[16 * i..16 * i + 16]);
            r[29..45].copy_from_slice(&src.matrix_world[16 * i..16 * i + 16]);
            let parent = if i == h as usize {
                h
            } else {
                remap(src.parent[i])
            };
            g.push_node(parent, src.flags[i], &r);
        }
        let mat = |s: &[f64], k: usize| {
            let mut e = [0.0; 16];
            e.copy_from_slice(&s[16 * k..16 * k + 16]);
            Mat4::from_elements(e)
        };
        for (m, &node) in src.mesh_nodes.iter().enumerate() {
            g.push_mesh(
                remap(node),
                &mat(&src.bind_matrix, m),
                &mat(&src.bind_matrix_inverse, m),
            );
        }
        for s in 0..src.skeleton_offsets.len() - 1 {
            g.push_skeleton();
            for b in src.skeleton_offsets[s] as usize..src.skeleton_offsets[s + 1] as usize {
                g.push_bone(remap(src.bone_nodes[b]), &mat(&src.bone_inverses, b));
            }
        }
        g.build();
        for b in &mut p.bones {
            *b = remap(*b);
        }
        for chain in &mut p.finger_bones {
            for b in chain {
                *b = remap(*b);
            }
        }
        for t in p.arm_twists.iter_mut().flatten() {
            t.primary = remap(t.primary);
            t.next = remap(t.next);
            t.helper = remap(t.helper);
        }
        g.update_matrix_world(0, true);
        (g, p, h)
    }

    /// `parent.add(helper); helper.add(child)` before the profile is built: a plain node with
    /// the given transform inserted above `child`, which keeps its own. The table stays in
    /// traverse order with the helper just before `child`; the profile is renumbered to match.
    /// Returns the helper's node.
    pub fn with_helper_above(
        src: &Graph,
        p: &Profile,
        child: u32,
        position: &Vec3,
        quaternion: &Quat,
        scale: &Vec3,
    ) -> (Graph, Profile, u32) {
        let mut p = p.clone();
        let remap = |i: u32| {
            if i == NO_NODE || i < child { i } else { i + 1 }
        };
        let n = src.len();
        let mut g = Graph::new(Shape {
            nodes: n + 1,
            meshes: src.mesh_nodes.len(),
            skeletons: src.skeleton_offsets.len() - 1,
            bones: src.bone_nodes.len(),
        });
        let identity = Mat4::default();
        for i in 0..n {
            if i == child as usize {
                let mut r = [0.0; RECORD];
                r[0..3].copy_from_slice(&[position.x, position.y, position.z]);
                r[3..7].copy_from_slice(&[quaternion.x, quaternion.y, quaternion.z, quaternion.w]);
                r[7..10].copy_from_slice(&[scale.x, scale.y, scale.z]);
                r[13..29].copy_from_slice(&identity.elements);
                r[29..45].copy_from_slice(&identity.elements);
                g.push_node(
                    src.parent[i],
                    flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE,
                    &r,
                );
            }
            let mut r = [0.0; RECORD];
            r[0..3].copy_from_slice(&src.position[3 * i..3 * i + 3]);
            r[3..7].copy_from_slice(&src.quaternion[4 * i..4 * i + 4]);
            r[7..10].copy_from_slice(&src.scale[3 * i..3 * i + 3]);
            r[10..13].copy_from_slice(&src.pivot[3 * i..3 * i + 3]);
            r[13..29].copy_from_slice(&src.matrix[16 * i..16 * i + 16]);
            r[29..45].copy_from_slice(&src.matrix_world[16 * i..16 * i + 16]);
            let parent = if i == child as usize {
                child
            } else {
                remap(src.parent[i])
            };
            g.push_node(parent, src.flags[i], &r);
        }
        let mat = |s: &[f64], k: usize| {
            let mut e = [0.0; 16];
            e.copy_from_slice(&s[16 * k..16 * k + 16]);
            Mat4::from_elements(e)
        };
        for (m, &node) in src.mesh_nodes.iter().enumerate() {
            g.push_mesh(
                remap(node),
                &mat(&src.bind_matrix, m),
                &mat(&src.bind_matrix_inverse, m),
            );
        }
        for s in 0..src.skeleton_offsets.len() - 1 {
            g.push_skeleton();
            for b in src.skeleton_offsets[s] as usize..src.skeleton_offsets[s + 1] as usize {
                g.push_bone(remap(src.bone_nodes[b]), &mat(&src.bone_inverses, b));
            }
        }
        g.build();
        for b in &mut p.bones {
            *b = remap(*b);
        }
        for chain in &mut p.finger_bones {
            for b in chain {
                *b = remap(*b);
            }
        }
        for t in p.arm_twists.iter_mut().flatten() {
            t.primary = remap(t.primary);
            t.next = remap(t.next);
            t.helper = remap(t.helper);
        }
        g.update_matrix_world(0, true);
        (g, p, child)
    }

    /// 64-bit FNV-1a over every node's position, quaternion, scale, matrix, matrixWorld and
    /// matrixWorldNeedsUpdate, in node order: f64 little-endian with NaN as one pattern, the
    /// flag as a byte. `record-corpora.test.ts` hashes the TS tree the same way.
    pub fn graph_hash(g: &Graph) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut byte = |b: u8| {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        };
        let f64s = |values: &[f64], byte: &mut dyn FnMut(u8)| {
            for &v in values {
                let bits = if v.is_nan() {
                    0x7ff8_0000_0000_0000
                } else {
                    v.to_bits()
                };
                for b in bits.to_le_bytes() {
                    byte(b);
                }
            }
        };
        for i in 0..g.len() {
            f64s(&g.position[3 * i..3 * i + 3], &mut byte);
            f64s(&g.quaternion[4 * i..4 * i + 4], &mut byte);
            f64s(&g.scale[3 * i..3 * i + 3], &mut byte);
            f64s(&g.matrix[16 * i..16 * i + 16], &mut byte);
            f64s(&g.matrix_world[16 * i..16 * i + 16], &mut byte);
            byte(u8::from(g.flags[i] & flag::MATRIX_WORLD_NEEDS_UPDATE != 0));
        }
        h
    }

    /// 64-bit FNV-1a over f64s, little-endian with NaN as one pattern: `makeFnv64().f64s(values)`.
    pub fn fnv_f64s(values: &[f64]) -> u64 {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &v in values {
            let bits = if v.is_nan() {
                0x7ff8_0000_0000_0000
            } else {
                v.to_bits()
            };
            for b in bits.to_le_bytes() {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        h
    }

    /// `Rig.armContext`: hand the anatomy model this arm's origin and segment lengths.
    pub fn arm_context(p: &Profile, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side));
        let limb = &p.limb[side as usize];
        let (Some(upper), Some(la)) = (upper, length(limb.upper)) else {
            anat.clear_arm();
            return false;
        };
        graph.update_world_matrix(upper, true, false, false);
        let s = graph.world_position(upper);
        anat.set_arm(
            &s,
            la,
            limb.lower.unwrap_or(0.0),
            limb.tip[Finger::Middle as usize].unwrap_or(0.0) * HAND_CONTACT,
        );
        true
    }

    /// The elbow search's view of the rig, as `Rig` wires it.
    pub struct Context<'a> {
        pub p: &'a Profile,
        pub joints: &'a JointTable,
        pub dt: f64,
    }

    impl ElbowContext for Context<'_> {
        fn solve_reach(
            &mut self,
            graph: &mut Graph,
            anat: &mut ArmAnatomy,
            side: Side,
            target_world: &Vec3,
            angle: f64,
            out: &mut ReachLinks,
            framed: bool,
        ) -> bool {
            solve_reach(
                self.p,
                self.joints,
                graph,
                anat,
                side,
                target_world,
                angle,
                out,
                Some(framed),
            )
        }

        fn arm_context(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
            arm_context(self.p, graph, anat, side)
        }

        fn dt(&self) -> f64 {
            self.dt
        }
    }

    /// The arm solvers of a `Rig` on the base avatar, with its frame refreshed.
    pub struct Arms {
        pub graph: Graph,
        pub profile: Profile,
        pub anat: ArmAnatomy,
        pub joints: JointTable,
        pub elbow: ElbowSearch,
        pub point: PointSolver,
        pub dt: f64,
    }

    impl Arms {
        pub fn new() -> Arms {
            let (graph, profile) = avatar();
            Arms::of(graph, profile)
        }

        pub fn of(mut graph: Graph, profile: Profile) -> Arms {
            let anat = ArmAnatomy::new(&profile, &mut graph);
            let joints = profile.anatomy.clone().unwrap_or_else(JointTable::human);
            let mut arms = Arms {
                graph,
                profile,
                anat,
                joints,
                elbow: ElbowSearch::new(),
                point: PointSolver::new(),
                dt: 1.0 / 60.0,
            };
            assert!(arms.anat.update(&mut arms.graph));
            arms
        }

        pub fn shoulder(&mut self, side: Side) -> Vec3 {
            let upper = bone(&self.profile, BoneSlot::arm(ArmSlot::UpperArm, side));
            self.graph.update_world_matrix(upper, true, false, false);
            self.graph.world_position(upper)
        }

        /// `Rig.solveReach`, with `framed` left to the solver.
        pub fn solve_reach(
            &mut self,
            side: Side,
            target: &Vec3,
            angle: f64,
            out: &mut ReachLinks,
        ) -> bool {
            solve_reach(
                &self.profile,
                &self.joints,
                &mut self.graph,
                &mut self.anat,
                side,
                target,
                angle,
                out,
                None,
            )
        }

        /// `Rig.solveReachNatural`.
        pub fn solve_reach_natural(
            &mut self,
            side: Side,
            target: &Vec3,
            hand_dir: Option<&Vec3>,
            out: &mut ArmSolution,
            pole: Option<&Vec3>,
        ) -> bool {
            let mut ctx = Context {
                p: &self.profile,
                joints: &self.joints,
                dt: self.dt,
            };
            self.elbow
                .search(
                    &self.profile,
                    &mut self.graph,
                    &mut self.anat,
                    &mut ctx,
                    side,
                    target,
                    hand_dir,
                    None,
                    out,
                    pole,
                )
                .is_some()
        }

        /// `Rig.solvePoint`.
        pub fn solve_point(
            &mut self,
            side: Side,
            spec: &PointRequest,
            out: &mut ArmSolution,
        ) -> bool {
            let elbow = self.elbow;
            let mut ctx = Context {
                p: &self.profile,
                joints: &self.joints,
                dt: self.dt,
            };
            let profile = &self.profile;
            let mut search = |graph: &mut Graph,
                              anat: &mut ArmAnatomy,
                              side: Side,
                              wrist: &Vec3,
                              hand_dir: Option<&Vec3>,
                              palm_n: Option<&Vec3>,
                              out: &mut ArmSolution| {
                elbow.search(
                    profile, graph, anat, &mut ctx, side, wrist, hand_dir, palm_n, out, None,
                )
            };
            self.point.solve(
                profile,
                &self.joints,
                &mut self.graph,
                &mut self.anat,
                &mut search,
                side,
                spec,
                out,
            )
        }
    }

    /// vitest's `toBeCloseTo(b, digits)`.
    pub fn close(a: f64, b: f64, digits: i32) {
        anatomy::close(a, b, digits);
    }

    /// `Rig`'s rest map, per node: every profile bone and finger bone as it stands, `None`
    /// elsewhere.
    pub fn rig_rest(g: &Graph, p: &Profile) -> Vec<Option<Quat>> {
        let mut table = vec![None; g.len()];
        for &b in p.bones.iter().chain(p.finger_bones.iter().flatten()) {
            if b != NO_NODE {
                table[b as usize] = Some(g.local_quaternion(b));
            }
        }
        table
    }

    /// `Rig.fingerClearance`.
    pub fn finger_clearance(p: &Profile, side: Side) -> f64 {
        0.5 * FINGER_WIDTH * p.limb[side as usize].pitch.unwrap_or(0.0)
    }

    /// The humeral front the `Rig` constructor derives from the body frame, in upper-arm space.
    pub fn humeral_front(p: &Profile, g: &mut Graph, side: Side) -> Option<Vec3> {
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side))?;
        let chest = p.chest()?;
        let body = p.body?;
        g.update_world_matrix(upper, true, false, false);
        let mut q = g.world_quaternion(upper);
        let mut along = p.rest_dir[BoneSlot::arm(ArmSlot::UpperArm, side) as usize]?;
        along.apply_quaternion(&q);
        let mut front = body.forward;
        front.apply_quaternion(&g.world_quaternion(chest));
        let d = -front.dot(&along);
        front.add_scaled_vector(&along, d);
        if front.length_sq() <= 1e-8 {
            return None;
        }
        q.invert();
        Some(*front.normalize().apply_quaternion(&q))
    }

    /// `Rig.readArmForwardContext(side, true)`.
    pub fn forward_context(
        p: &Profile,
        g: &mut Graph,
        anat: &mut ArmAnatomy,
        side: Side,
    ) -> Option<ArmForwardContext> {
        let upper = p.bone(BoneSlot::arm(ArmSlot::UpperArm, side))?;
        let parent = g.parent_of(upper)?;
        let limb = &p.limb[side as usize];
        let upper_length = limb.upper.unwrap_or(0.0);
        let lower_length = limb.lower.unwrap_or(0.0);
        if !(upper_length > 0.0 && lower_length > 0.0 && anat.update(g)) {
            return None;
        }
        g.update_matrix_world(0, true);
        if !arm_context(p, g, anat, side) {
            return None;
        }
        g.update_world_matrix(upper, true, false, false);
        g.update_world_matrix(parent, true, false, false);
        let shoulder = g.world_position(upper);
        Some(ArmForwardContext {
            side,
            shoulder,
            upper_length,
            lower_length,
            up: *anat.up(),
            right: *anat.right(),
            forward: *anat.fwd(),
            upper_parent_world: g.world_quaternion(parent),
        })
    }

    /// `Rig.readActualArmPose`: the posed upper arm, forearm, hand and palm directions.
    pub fn actual_arm_pose(p: &Profile, g: &mut Graph, palm: &Vec3, side: Side) -> [Vec3; 4] {
        g.update_matrix_world(0, true);
        let dir = |g: &mut Graph, slot: ArmSlot| {
            let b = bone(p, BoneSlot::arm(slot, side));
            let mut v = p.rest_dir[BoneSlot::arm(slot, side) as usize].unwrap();
            v.apply_quaternion(&g.world_quaternion(b)).normalize();
            v
        };
        let u = dir(g, ArmSlot::UpperArm);
        let l = dir(g, ArmSlot::LowerArm);
        let h = dir(g, ArmSlot::Hand);
        let mut n = *palm;
        n.apply_quaternion(&g.world_quaternion(bone(p, BoneSlot::arm(ArmSlot::Hand, side))))
            .normalize();
        [u, l, h, n]
    }

    /// A battery's records, read front to back, with what each one wrote checked as it is read.
    pub struct Stream<'a> {
        values: &'a [f64],
        at: usize,
        pub what: String,
    }

    impl<'a> Stream<'a> {
        pub fn new(values: &'a [f64]) -> Stream<'a> {
            Stream {
                values,
                at: 0,
                what: String::new(),
            }
        }

        pub fn done(&self) -> bool {
            self.at == self.values.len()
        }

        pub fn f64(&mut self) -> f64 {
            let v = self.values[self.at];
            self.at += 1;
            v
        }

        pub fn take(&mut self, n: usize) -> &'a [f64] {
            let v = &self.values[self.at..self.at + n];
            self.at += n;
            v
        }

        pub fn index(&mut self) -> usize {
            let v = self.f64();
            assert!(
                v >= 0.0 && v.fract() == 0.0,
                "{}: {v} is not an index",
                self.what
            );
            v as usize
        }

        pub fn flag(&mut self) -> bool {
            self.f64() == 1.0
        }

        pub fn vec3(&mut self) -> Vec3 {
            let v = self.take(3);
            Vec3::new(v[0], v[1], v[2])
        }

        pub fn quat(&mut self) -> Quat {
            let v = self.take(4);
            Quat::new(v[0], v[1], v[2], v[3])
        }

        pub fn q(&mut self) -> [f64; 7] {
            self.take(7).try_into().unwrap()
        }

        pub fn opt_vec3(&mut self) -> Option<Vec3> {
            self.flag().then(|| self.vec3())
        }

        pub fn spec(&mut self) -> FingerSpec {
            std::array::from_fn(|_| self.flag().then(|| self.f64()))
        }

        pub fn side(&mut self) -> Side {
            Side::BOTH[self.index()]
        }

        /// The next values are what the TS wrote; they must be `got`, bit for bit.
        pub fn same(&mut self, got: &[f64], name: &str) {
            let want = self.take(got.len());
            let g: Vec<u64> = got.iter().map(|v| v.to_bits()).collect();
            let w: Vec<u64> = want.iter().map(|v| v.to_bits()).collect();
            assert_eq!(g, w, "{}: {name}: {got:?} against {want:?}", self.what);
        }

        pub fn same_flag(&mut self, b: bool, name: &str) {
            self.same(&[f64::from(u8::from(b))], name);
        }

        pub fn same_opt_vec3(&mut self, v: Option<&Vec3>, name: &str) {
            match v {
                Some(v) => self.same(&[1.0, v.x, v.y, v.z], name),
                None => self.same(&[0.0], name),
            }
        }

        pub fn same_spec(&mut self, spec: &FingerSpec, name: &str) {
            for v in spec {
                match v {
                    Some(v) => self.same(&[1.0, *v], name),
                    None => self.same(&[0.0], name),
                }
            }
        }
    }

    pub fn halves(h: u64) -> [f64; 2] {
        [(h >> 32) as f64, (h & 0xffff_ffff) as f64]
    }

    pub fn hash_halves(values: &[f64]) -> [f64; 2] {
        halves(fnv_f64s(values))
    }

    pub fn present(into: &mut Vec<f64>, v: Option<f64>) {
        match v {
            Some(v) => into.extend([1.0, v]),
            None => into.push(0.0),
        }
    }

    pub fn present_vec(into: &mut Vec<f64>, v: Option<&Vec3>) {
        match v {
            Some(v) => into.extend([1.0, v.x, v.y, v.z]),
            None => into.push(0.0),
        }
    }

    pub fn v3(v: &Vec3) -> [f64; 3] {
        [v.x, v.y, v.z]
    }

    pub fn q4(q: &Quat) -> [f64; 4] {
        [q.x, q.y, q.z, q.w]
    }

    /// `definitionValues`: a calibration and hand geometry in the solver battery's order.
    pub fn definition_values(c: &ArmCalibration, g: &HandGeometryCalibration) -> Vec<f64> {
        let mut v = Vec::new();
        v.extend(v3(&c.upper.axis));
        v.extend(q4(&c.upper.rest));
        v.extend(v3(&c.upper.front));
        v.extend(v3(&c.lower.axis));
        v.extend(q4(&c.lower.rest));
        v.extend(v3(&c.hand.axis));
        v.extend(q4(&c.hand.rest));
        v.extend(v3(&c.hand.palm));
        v.push(c.radial_sign);
        present(&mut v, g.hand_present.map(|p| f64::from(u8::from(p))));
        v.extend([g.metric_scale, g.points.len() as f64]);
        for point in &g.points {
            v.extend([
                point.finger as usize as f64,
                point.joint_index as f64,
                f64::from(u8::from(point.tip)),
            ]);
            match &point.nodes {
                Some(nodes) => {
                    v.extend([1.0, nodes.len() as f64]);
                    for node in nodes {
                        v.extend(v3(&node.position));
                        v.extend(q4(&node.rest));
                        v.extend(v3(&node.scale));
                        present_vec(&mut v, node.curl_axis.as_ref());
                        present_vec(&mut v, node.splay_axis.as_ref());
                        present(&mut v, node.joint_index.map(|i| i as f64));
                    }
                }
                None => v.push(0.0),
            }
            present(&mut v, point.previous_point.map(|i| i as f64));
            present(&mut v, point.last_point.map(|i| i as f64));
        }
        v
    }

    pub fn configuration_values(c: &ArmConfiguration) -> [f64; 7] {
        [
            c.shoulder_plane,
            c.shoulder_lift,
            c.humeral_rotation,
            c.elbow_flex,
            c.forearm_roll,
            c.wrist_flex,
            c.wrist_dev,
        ]
    }

    pub fn configuration_of(v: &[f64]) -> ArmConfiguration {
        ArmConfiguration {
            shoulder_plane: v[0],
            shoulder_lift: v[1],
            humeral_rotation: v[2],
            elbow_flex: v[3],
            forearm_roll: v[4],
            wrist_flex: v[5],
            wrist_dev: v[6],
        }
    }

    pub fn forward_values(r: &ArmForwardResult) -> Vec<f64> {
        let mut out = Vec::with_capacity(42);
        for v in [r.u, r.l, r.h, r.palm, r.elbow, r.wrist] {
            out.extend(v3(&v));
        }
        for q in [
            r.upper_world,
            r.lower_world,
            r.hand_world,
            r.upper_local,
            r.lower_local,
            r.hand_local,
        ] {
            out.extend(q4(&q));
        }
        out
    }

    pub fn context_values(c: &ArmForwardContext) -> Vec<f64> {
        let mut out = vec![c.side as usize as f64];
        out.extend(v3(&c.shoulder));
        out.extend([c.upper_length, c.lower_length]);
        out.extend(v3(&c.up));
        out.extend(v3(&c.right));
        out.extend(v3(&c.forward));
        out.extend(q4(&c.upper_parent_world));
        out
    }

    pub fn context_of(s: &mut Stream) -> ArmForwardContext {
        ArmForwardContext {
            side: s.side(),
            shoulder: s.vec3(),
            upper_length: s.f64(),
            lower_length: s.f64(),
            up: s.vec3(),
            right: s.vec3(),
            forward: s.vec3(),
            upper_parent_world: s.quat(),
        }
    }

    /// `Rig`'s side of `ArmChain`: its clock, limiter switch, rest map, roll tables and helpers.
    pub struct ChainPort<'a> {
        pub p: &'a Profile,
        pub rest: &'a [Option<Quat>],
        pub dt: f64,
        pub limits: bool,
        pub fore_roll: &'a mut [f64; 2],
        pub upper_roll: &'a mut [f64; 2],
        pub twists: Option<&'a mut ArmTwists>,
    }

    impl ArmChainPort for ChainPort<'_> {
        fn dt(&self) -> f64 {
            self.dt
        }

        fn limits_enabled(&self) -> bool {
            self.limits
        }

        fn arm_context(&mut self, graph: &mut Graph, anat: &mut ArmAnatomy, side: Side) -> bool {
            arm_context(self.p, graph, anat, side)
        }

        fn rest_of(&self, bone: u32) -> Quat {
            self.rest[bone as usize].unwrap_or_default()
        }

        fn record_rolls(&mut self, side: Side, fore: f64, humeral: f64) {
            self.fore_roll[side as usize] = fore;
            self.upper_roll[side as usize] = humeral;
        }

        fn stage_twists(&mut self, graph: &mut Graph, side: Side) {
            if let Some(twists) = self.twists.as_mut() {
                twists.stage(graph, side);
            }
        }
    }

    /// The constrained arms of a `Rig`, wired and seeded as its constructor does: the base avatar's
    /// anatomy, finger axes, humeral fronts and one `ArmDriver` per side.
    pub struct Driven {
        pub graph: Graph,
        pub profile: Profile,
        pub anat: ArmAnatomy,
        pub joints: JointTable,
        pub rest: Vec<Option<Quat>>,
        pub twists: Option<ArmTwists>,
        pub hands: Hands,
        pub humeral_front: [Option<Vec3>; 2],
        pub chain: ArmChain,
        pub drivers: [Option<ArmDriver>; 2],
        /// The context each driver was seeded in.
        pub seeded: [Option<ArmForwardContext>; 2],
        /// `Rig.dt`.
        pub dt: f64,
        pub limits: bool,
        /// `Rig.foreRoll` and `Rig.upperRoll`.
        pub fore_roll: [f64; 2],
        pub upper_roll: [f64; 2],
    }

    impl Driven {
        pub fn new() -> Driven {
            let (graph, profile) = avatar();
            Driven::of(graph, profile)
        }

        pub fn of(mut graph: Graph, profile: Profile) -> Driven {
            graph.update_world_matrix(0, true, true, false);
            let rest = rig_rest(&graph, &profile);
            let twists = ArmTwists::create(&profile, &mut graph);
            let joints = profile.anatomy.clone().unwrap_or_else(JointTable::human);
            let hands = Hands::new(&profile, &mut graph);
            let mut anat = ArmAnatomy::new(&profile, &mut graph);
            let humeral_front = Side::BOTH.map(|s| humeral_front(&profile, &mut graph, s));
            let chain = ArmChain::new(*hands.palm_local(), humeral_front);
            let mut drivers = [None, None];
            let mut seeded = [None, None];
            for side in Side::BOTH {
                let (Some(palm), Some(front)) = (
                    hands.palm_local()[side as usize],
                    humeral_front[side as usize],
                ) else {
                    continue;
                };
                let input = DriverInput {
                    profile: &profile,
                    side,
                    joints: &joints,
                    rest: &|i| rest[i as usize],
                    finger_axes: &hands.fingers,
                    palm_local: palm,
                    radial_sign: anat.radial_sign[side as usize],
                    humeral_front: front,
                    finger_clearance: finger_clearance(&profile, side),
                };
                let Ok(mut driver) = ArmDriver::create(&input, &mut graph) else {
                    continue;
                };
                let Some(context) = forward_context(&profile, &mut graph, &mut anat, side) else {
                    continue;
                };
                let [u, l, h, n] = actual_arm_pose(&profile, &mut graph, &palm, side);
                if driver.seed_from_pose(&context, &u, &l, &h, &n) {
                    drivers[side as usize] = Some(driver);
                    seeded[side as usize] = Some(context);
                }
            }
            Driven {
                graph,
                profile,
                anat,
                joints,
                rest,
                twists,
                hands,
                humeral_front,
                chain,
                drivers,
                seeded,
                dt: 1.0 / 60.0,
                limits: true,
                fore_roll: [0.0; 2],
                upper_roll: [0.0; 2],
            }
        }

        /// `rig.aimArmLegacy(side, dirs, twist, palmTarget, palmWeight)`.
        pub fn aim_arm_legacy(
            &mut self,
            side: Side,
            dirs: &[Option<Vec3>; 4],
            twist: f64,
            palm_target: Option<&Vec3>,
            palm_weight: f64,
        ) {
            let mut port = ChainPort {
                p: &self.profile,
                rest: &self.rest,
                dt: self.dt,
                limits: self.limits,
                fore_roll: &mut self.fore_roll,
                upper_roll: &mut self.upper_roll,
                twists: self.twists.as_mut(),
            };
            self.chain.aim_arm_legacy(
                &self.profile,
                &self.joints,
                &mut self.graph,
                &mut self.anat,
                &mut port,
                side,
                dirs,
                twist,
                palm_target,
                palm_weight,
            );
        }

        /// `rig.armForwardContext(side)`.
        pub fn context(&mut self, side: Side) -> ArmForwardContext {
            forward_context(&self.profile, &mut self.graph, &mut self.anat, side)
                .expect("the base avatar has an arm context")
        }

        /// One side's driver and the anatomy it samples, borrowed together.
        pub fn driver(&mut self, side: Side) -> (&mut ArmDriver, &mut ArmAnatomy) {
            (
                self.drivers[side as usize]
                    .as_mut()
                    .expect("the base avatar has a constrained arm"),
                &mut self.anat,
            )
        }

        /// `driver.captureVolumeFrame()`.
        pub fn capture_volume_frame(&mut self, side: Side) {
            let driver = self.drivers[side as usize].as_mut().unwrap();
            driver.capture_volume_frame(&mut self.graph, &mut self.anat);
        }
    }
}

/// `tests/corpora/rig-a-battery`: the TS rig leaf modules on the base avatar through a fixed run
/// of their calls, replayed step by step on the port. See `record-corpora.test.ts`.
#[cfg(test)]
mod battery {
    use super::elbow::ElbowSearch;
    use super::girdle::ShoulderGirdle;
    use super::legs::GroundedLegs;
    use super::point::{PointRequest, PointSolver};
    use super::reach::{
        ArmSolution, ReachLinks, near_reach, pole_angle, reach_ref, solve_reach, swivel_of,
    };
    use super::skeleton::SkeletonRefresh;
    use super::spine::{OffsetSlot, SpineOffsets};
    use super::testkit::{Context, avatar, graph_hash, rest_of, rest_table};
    use crate::anatomy::arm::ArmAnatomy;
    use crate::anatomy::joints::JointTable;
    use crate::corpus_replay::{Case, Corpus};
    use crate::math::{Quat, Vec3};
    use crate::profile::{Finger, Side};
    use crate::scene::graph::{Graph, flag};

    const KINDS: [&str; 20] = [
        "skeleton.build",
        "legs.create",
        "spine.build",
        "anat.build",
        "update",
        "skeleton.run",
        "legs.apply",
        "legs.pivot",
        "spine.commit",
        "spine.eyes",
        "spine.head",
        "girdle.room",
        "girdle.turn",
        "reach.near",
        "reach.ref",
        "reach.solve",
        "reach.pole",
        "reach.swivel",
        "elbow.search",
        "point.solve",
    ];

    struct Step<'c> {
        case: Case<'c>,
        n: usize,
        kind: &'static str,
    }

    impl Step<'_> {
        fn input(&self, name: &str) -> &[f64] {
            self.case.input(name)
        }

        fn scalar(&self, name: &str) -> f64 {
            self.case.scalar(name, false)
        }

        fn flag(&self, name: &str) -> bool {
            self.scalar(name) == 1.0
        }

        fn vec3(&self, name: &str) -> Vec3 {
            let v = self.input(name);
            Vec3::new(v[0], v[1], v[2])
        }

        fn opt_vec3(&self, name: &str) -> Option<Vec3> {
            self.flag(&format!("{name}.present"))
                .then(|| self.vec3(name))
        }

        fn opt_bool(&self, name: &str) -> Option<bool> {
            self.flag(&format!("{name}.present"))
                .then(|| self.flag(name))
        }

        fn side(&self) -> Side {
            Side::BOTH[self.scalar("side") as usize]
        }

        fn same(&self, got: &[f64], name: &str) {
            let want = self.case.output(name);
            let g: Vec<u64> = got.iter().map(|v| v.to_bits()).collect();
            let w: Vec<u64> = want.iter().map(|v| v.to_bits()).collect();
            assert_eq!(
                g, w,
                "step {} ({}): {name}: {got:?} against {want:?}",
                self.n, self.kind
            );
        }

        fn same_vec(&self, v: &Vec3, name: &str) {
            self.same(&[v.x, v.y, v.z], name);
        }

        fn same_bool(&self, b: bool, name: &str) {
            self.same(&[if b { 1.0 } else { 0.0 }], name);
        }

        fn same_option(&self, v: Option<f64>, name: &str) {
            self.same_bool(v.is_some(), "ok");
            self.same(&[v.unwrap_or(0.0)], name);
        }

        fn same_touched(&self, g: &Graph) {
            let len = self.case.output("touched.len")[0] as usize;
            for k in 0..len {
                let at = |field: &str| format!("touched[{k}].{field}");
                let node = self.case.output(&at("node"))[0] as usize;
                self.same(&g.position[3 * node..3 * node + 3], &at("position"));
                self.same(&g.quaternion[4 * node..4 * node + 4], &at("quaternion"));
                self.same(
                    &g.matrix_world[16 * node..16 * node + 16],
                    &at("matrixWorld"),
                );
                let dirty = g.flags[node] & flag::MATRIX_WORLD_NEEDS_UPDATE != 0;
                self.same_bool(dirty, &at("matrixWorldNeedsUpdate"));
            }
        }

        fn same_solution(&self, o: &ArmSolution) {
            self.same_vec(&o.links.upper_arm, "upperArm");
            self.same_vec(&o.links.lower_arm, "lowerArm");
            self.same_vec(&o.swivel_dir, "swivelDir");
        }
    }

    fn quat(q: &Quat) -> [f64; 4] {
        [q.x, q.y, q.z, q.w]
    }

    #[test]
    fn replays_the_ts_rig_bit_for_bit() {
        let corpus = Corpus::load("rig-a-battery");
        let (mut g, p) = avatar();
        let rest = rest_table(&g);
        let joints = JointTable::human();
        let mut skeleton = None;
        let mut legs = None;
        let mut spine = None;
        let mut anat: Option<ArmAnatomy> = None;
        let girdle = ShoulderGirdle::new();
        let elbow = ElbowSearch::new();
        let point = PointSolver::new();
        let mut slots = [ArmSolution::default(); 4];
        let mut seen = [0; 20];

        for (n, case) in corpus.iter().enumerate() {
            let k = case.scalar("kind", false) as usize;
            seen[k] += 1;
            let s = Step {
                case,
                n,
                kind: KINDS[k],
            };
            if s.flag("set.present") {
                let node = s.scalar("set.node") as usize;
                g.position[3 * node..3 * node + 3].copy_from_slice(s.input("set.position"));
                g.quaternion[4 * node..4 * node + 4].copy_from_slice(s.input("set.quaternion"));
            }
            if s.flag("update") {
                g.update_matrix_world(0, true);
            }
            match s.kind {
                "skeleton.build" => {
                    let refresh = SkeletonRefresh::new(&g, 0);
                    let list = |v: &[u32]| {
                        let mut out = vec![v.len() as f64];
                        out.extend(v.iter().map(|&i| f64::from(i)));
                        out
                    };
                    let names = |name: &str, len: usize| {
                        let mut out = vec![s.case.output(&format!("{name}.len"))[0]];
                        for i in 0..len {
                            out.push(s.case.output(&format!("{name}[{i}]"))[0]);
                        }
                        out
                    };
                    assert_eq!(list(&refresh.path), names("path", refresh.path.len()));
                    assert_eq!(
                        list(&refresh.subtrees),
                        names("subtrees", refresh.subtrees.len())
                    );
                    skeleton = Some(refresh);
                }
                "legs.create" => {
                    let created =
                        GroundedLegs::create(&p, &mut g, &rest_of(&rest)).expect("grounded legs");
                    for (i, side) in ["L", "R"].iter().enumerate() {
                        let state = &created.legs[i];
                        let at = |field: &str| format!("legs.{side}.{field}");
                        s.same_vec(&state.knee_pole, &at("kneePole"));
                        s.same_vec(&state.anchor_root, &at("anchorRoot"));
                        s.same(&[state.soft_zone], &at("softZone"));
                        s.same(&[state.upper_length], &at("upperLength"));
                        s.same(&[state.lower_length], &at("lowerLength"));
                    }
                    legs = Some(created);
                }
                "spine.build" => {
                    let built = SpineOffsets::new(&p, &mut g);
                    for slot in OffsetSlot::ALL {
                        let name = ["hips", "spine", "chest", "neck", "head", "eye.L", "eye.R"]
                            [slot as usize];
                        let q = built.basis_q(slot);
                        s.same_bool(q.is_some(), &format!("basis.{name}.present"));
                        if let Some(q) = q {
                            s.same(&quat(&q), &format!("basis.{name}"));
                        }
                    }
                    spine = Some(built);
                }
                "anat.build" => {
                    let a = anat.get_or_insert_with(|| ArmAnatomy::new(&p, &mut g));
                    s.same_bool(a.update(&mut g), "ok");
                }
                "update" => g.update_matrix_world(0, true),
                "skeleton.run" => skeleton.as_ref().unwrap().run(&mut g),
                "legs.apply" => {
                    let refresh = if s.flag("refresh") {
                        skeleton.as_ref()
                    } else {
                        None
                    };
                    let ok = legs.as_mut().unwrap().apply(
                        &p,
                        &mut g,
                        s.scalar("rise"),
                        s.scalar("yaw"),
                        refresh,
                    );
                    s.same_bool(ok, "ok");
                    s.same_touched(&g);
                }
                "legs.pivot" => {
                    let pivot = legs.as_ref().unwrap().stance_pivot(&mut g);
                    s.same_vec(&pivot, "value3");
                }
                "spine.commit" => {
                    let spine = spine.as_mut().unwrap();
                    spine.clear();
                    for i in 0..s.scalar("adds.len") as usize {
                        let slot = OffsetSlot::ALL[s.scalar(&format!("adds[{i}].slot")) as usize];
                        let o = s.input(&format!("adds[{i}].offset"));
                        spine.add(slot, o[0], o[1], o[2]);
                    }
                    spine.commit(&p, &mut g, &rest_of(&rest));
                    s.same_touched(&g);
                }
                "spine.eyes" => {
                    spine
                        .as_ref()
                        .unwrap()
                        .commit_eyes(&p, &mut g, &rest_of(&rest));
                    s.same_touched(&g);
                }
                "spine.head" => {
                    let mut q = Quat::default();
                    let ok = spine.as_ref().unwrap().read_head_offset(&p, &mut g, &mut q);
                    s.same_bool(ok, "ok");
                    s.same(&quat(&q), "q");
                }
                "girdle.room" => {
                    let d = s.input("dir");
                    let mut turn = s.vec3("turn");
                    girdle.girdle_room(
                        &p,
                        &joints,
                        &mut g,
                        s.side(),
                        &s.vec3("target"),
                        &[d[0], d[1], d[2]],
                        s.scalar("weight"),
                        &mut turn,
                    );
                    s.same_vec(&turn, "value3");
                }
                "girdle.turn" => {
                    let d = s.input("dir");
                    let mut dir = [d[0], d[1], d[2]];
                    girdle.turn_girdle(&mut dir, &s.vec3("turn"));
                    s.same(&dir, "value3");
                }
                "reach.near" => {
                    s.same(
                        &[near_reach(s.scalar("la"), s.scalar("lf"), &joints)],
                        "value",
                    );
                }
                "reach.ref" => {
                    let mut perp = Vec3::default();
                    reach_ref(
                        &mut g,
                        anat.as_mut().unwrap(),
                        &s.vec3("n"),
                        &mut perp,
                        s.opt_bool("framed"),
                    );
                    s.same_vec(&perp, "value3");
                }
                "reach.solve" => {
                    let mut links = ReachLinks::default();
                    let ok = solve_reach(
                        &p,
                        &joints,
                        &mut g,
                        anat.as_mut().unwrap(),
                        s.side(),
                        &s.vec3("target"),
                        s.scalar("angle"),
                        &mut links,
                        s.opt_bool("framed"),
                    );
                    s.same_bool(ok, "ok");
                    s.same_vec(&links.upper_arm, "upperArm");
                    s.same_vec(&links.lower_arm, "lowerArm");
                }
                "reach.pole" => {
                    let a = pole_angle(
                        &p,
                        &mut g,
                        anat.as_mut().unwrap(),
                        Side::R,
                        &s.vec3("target"),
                        &s.vec3("pole"),
                    );
                    s.same_option(a, "value");
                }
                "reach.swivel" => {
                    let a = swivel_of(
                        &mut g,
                        anat.as_mut().unwrap(),
                        &s.vec3("n"),
                        &s.vec3("w"),
                        s.opt_bool("framed"),
                    );
                    s.same_option(a, "value");
                }
                "elbow.search" => {
                    let mut ctx = Context {
                        p: &p,
                        joints: &joints,
                        dt: s.scalar("dt"),
                    };
                    let (hand_dir, palm_n, pole) = (
                        s.opt_vec3("handDir"),
                        s.opt_vec3("palmN"),
                        s.opt_vec3("pole"),
                    );
                    let slot = &mut slots[s.scalar("slot") as usize];
                    let strain = elbow.search(
                        &p,
                        &mut g,
                        anat.as_mut().unwrap(),
                        &mut ctx,
                        s.side(),
                        &s.vec3("target"),
                        hand_dir.as_ref(),
                        palm_n.as_ref(),
                        slot,
                        pole.as_ref(),
                    );
                    s.same_option(strain, "value");
                    s.same_solution(slot);
                }
                "point.solve" => {
                    let mut ctx = Context {
                        p: &p,
                        joints: &joints,
                        dt: s.scalar("dt"),
                    };
                    let request = PointRequest {
                        azimuth: Some(s.scalar("azimuth")),
                        elevation: Some(s.scalar("elevation")),
                        extent: s.flag("extent.present").then(|| s.scalar("extent")),
                        finger: s
                            .flag("finger.present")
                            .then(|| Finger::ALL[s.scalar("finger") as usize]),
                        point: s.opt_vec3("point"),
                        palm: s.opt_vec3("palm"),
                    };
                    let profile = &p;
                    let mut search = |graph: &mut Graph,
                                      anat: &mut ArmAnatomy,
                                      side: Side,
                                      wrist: &Vec3,
                                      hand_dir: Option<&Vec3>,
                                      palm_n: Option<&Vec3>,
                                      out: &mut ArmSolution| {
                        elbow.search(
                            profile, graph, anat, &mut ctx, side, wrist, hand_dir, palm_n, out,
                            None,
                        )
                    };
                    let slot = &mut slots[s.scalar("slot") as usize];
                    let ok = point.solve(
                        &p,
                        &joints,
                        &mut g,
                        anat.as_mut().unwrap(),
                        &mut search,
                        s.side(),
                        &request,
                        slot,
                    );
                    s.same_bool(ok, "ok");
                    s.same_solution(slot);
                    s.same_vec(&slot.hand, "hand");
                    s.same_vec(&slot.palm, "palm");
                    s.same_vec(&slot.tip, "tip");
                    s.same(&[slot.twist], "twist");
                    s.same(&[slot.strain.unwrap_or(0.0)], "value");
                }
                other => panic!("unknown step {other}"),
            }
            let h = graph_hash(&g);
            s.same(&[(h >> 32) as f64, (h & 0xffff_ffff) as f64], "hash");
        }
        assert_eq!(
            seen,
            [1, 1, 1, 2, 2, 1, 7, 1, 2, 1, 1, 3, 3, 1, 4, 5, 4, 2, 8, 8]
        );
    }
}
