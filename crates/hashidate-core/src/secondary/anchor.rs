//! Placement of an attached spring root on a weighted, skinned point, and the transform contract
//! it guards on every placement.

use super::StatusKind;
use super::spring::InputWorld;
use crate::math::f::{hypot3, js_max};
use crate::math::{Mat4, Vec3};
use crate::scene::{NONE, Node, Scene};

const MANUAL_MATRIX_SCALE_TOLERANCE: f64 = 2e-7;
const UNIFORM_SCALE_TOLERANCE: f64 = 1e-5;
const ORTHOGONAL_TOLERANCE: f64 = 1e-6;

/// A broken contract: what broke, and on which node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub kind: StatusKind,
    /// The node it broke on, or [`NONE`] when the failure is not about one node.
    pub node: u32,
}

fn fail<T>(kind: StatusKind, node: u32) -> Result<T, Failure> {
    Err(Failure { kind, node })
}

/// `Math.sign`, which keeps both zeros and NaN.
fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// `Object.is` on numbers.
fn same_value(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}

/// The transform a node resolved with, which every later placement must keep.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Guard {
    Auto { scale: [f64; 3] },
    Manual { scale: f64, sign: f64 },
}

// skin-point-anchor.ts readLocalMatrix
fn read_local_matrix(node: &Node, out: &mut Mat4) {
    if node.matrix_auto_update {
        out.compose(&node.position, &node.quaternion, &node.scale);
    } else {
        out.copy(&node.matrix);
    }
}

// skin-point-anchor.ts transformScale
//
// Validate affine, nearly uniform, orthogonal scale and return its magnitude.
// The negated comparisons are the point: NaN fails every one of them.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn transform_scale(index: u32, matrix: &Mat4) -> Result<f64, Failure> {
    let e = &matrix.elements;
    if !(e.iter().all(|v| v.is_finite())
        && e[3].abs() <= 1e-8
        && e[7].abs() <= 1e-8
        && e[11].abs() <= 1e-8
        && (e[15] - 1.0).abs() <= 1e-8)
    {
        return fail(StatusKind::AnchorNotAffine, index);
    }
    let x = hypot3(e[0], e[1], e[2]);
    let y = hypot3(e[4], e[5], e[6]);
    let z = hypot3(e[8], e[9], e[10]);
    let maximum = js_max(js_max(x, y), z);
    if !(maximum > 1e-12) {
        return fail(StatusKind::AnchorSingular, index);
    }
    if !((x - y).abs() <= UNIFORM_SCALE_TOLERANCE * maximum
        && (x - z).abs() <= UNIFORM_SCALE_TOLERANCE * maximum)
    {
        return fail(StatusKind::AnchorNonuniform, index);
    }
    let xy = e[0] * e[4] + e[1] * e[5] + e[2] * e[6];
    let xz = e[0] * e[8] + e[1] * e[9] + e[2] * e[10];
    let yz = e[4] * e[8] + e[5] * e[9] + e[6] * e[10];
    if !(xy.abs() <= ORTHOGONAL_TOLERANCE * x * y
        && xz.abs() <= ORTHOGONAL_TOLERANCE * x * z
        && yz.abs() <= ORTHOGONAL_TOLERANCE * y * z)
    {
        return fail(StatusKind::AnchorShear, index);
    }
    Ok((x + y + z) / 3.0)
}

// skin-point-anchor.ts snapshotTransform
fn snapshot_transform(index: u32, node: &Node, matrix: &Mat4) -> Result<Guard, Failure> {
    let scale = transform_scale(index, matrix)?;
    Ok(if node.matrix_auto_update {
        Guard::Auto {
            scale: [node.scale.x, node.scale.y, node.scale.z],
        }
    } else {
        Guard::Manual {
            scale,
            sign: js_sign(matrix.determinant()),
        }
    })
}

// skin-point-anchor.ts assertTransformStable
fn assert_transform_stable(
    index: u32,
    node: &Node,
    matrix: &Mat4,
    expected: &Guard,
) -> Result<(), Failure> {
    if node.matrix_auto_update != matches!(expected, Guard::Auto { .. }) {
        return fail(StatusKind::AnchorModeChanged, index);
    }
    let scale = transform_scale(index, matrix)?;
    match *expected {
        Guard::Auto { scale: expected } => {
            // A changing quaternion can perturb composed column lengths by Float32
            // roundoff. The Object3D TRS scale itself is the immutable contract.
            if !(node.scale.x == expected[0]
                && node.scale.y == expected[1]
                && node.scale.z == expected[2])
            {
                return fail(StatusKind::AnchorScaleChanged, index);
            }
            Ok(())
        }
        Guard::Manual {
            scale: expected,
            sign,
        } => {
            if !((scale - expected).abs() <= MANUAL_MATRIX_SCALE_TOLERANCE * js_max(1.0, expected)
                && js_sign(matrix.determinant()) == sign)
            {
                return fail(StatusKind::AnchorScaleChanged, index);
            }
            Ok(())
        }
    }
}

/// One node on a matrix path, shared by every path of an anchor that passes through it.
#[derive(Clone, Debug)]
struct PathNode {
    node: u32,
    transform: Guard,
    /// The node's local matrix as last read; see `passed`.
    local: Mat4,
    /// Position, quaternion and scale `local` was composed from and passed the guard with.
    passed: [f64; 10],
    has_passed: bool,
    /// The placement that last guarded this node; see `walk`.
    guarded: i64,
    /// The path's product down to this node in placement `formed`, starting after `from`.
    world: Mat4,
    formed: i64,
    from: Option<usize>,
}

// skin-point-anchor.ts stillPassed
//
// Whether `entry.local` still stands for the node: a composed local matrix and its guard depend
// on nothing else, so the same values compose and pass the same. Only values that passed are
// kept, and a NaN never passes, so `Object.is` cannot match one; it also tells the two zeros
// apart, as composing does.
fn still_passed(entry: &PathNode, node: &Node) -> bool {
    if !(entry.has_passed && node.matrix_auto_update) {
        return false;
    }
    let (p, q, k) = (&node.position, &node.quaternion, &node.scale);
    let now = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, k.x, k.y, k.z];
    now.iter()
        .zip(&entry.passed)
        .all(|(&a, &b)| same_value(a, b))
}

// skin-point-anchor.ts rememberPassed
fn remember_passed(entry: &mut PathNode, node: &Node) {
    entry.has_passed = node.matrix_auto_update;
    if !entry.has_passed {
        return;
    }
    let (p, q, k) = (&node.position, &node.quaternion, &node.scale);
    entry.passed = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, k.x, k.y, k.z];
}

// skin-point-anchor.ts matrixPath
fn matrix_path(
    scene: &Scene,
    node: u32,
    nodes: &mut Vec<PathNode>,
    shared: &mut [u32],
) -> Result<Vec<usize>, Failure> {
    let mut chain = Vec::new();
    let mut current = Some(node);
    while let Some(index) = current {
        chain.push(index);
        current = scene.parent(index);
    }
    chain.reverse();
    let mut path = Vec::with_capacity(chain.len());
    for index in chain {
        let n = scene.node(index);
        if !n.matrix_world_auto_update {
            return fail(StatusKind::AnchorWorldOverride, index);
        }
        let mut entry = shared[index as usize];
        if entry == NONE {
            let mut local = Mat4::default();
            read_local_matrix(n, &mut local);
            nodes.push(PathNode {
                node: index,
                transform: snapshot_transform(index, n, &local)?,
                local: Mat4::default(),
                passed: [0.0; 10],
                has_passed: false,
                guarded: -1,
                world: Mat4::default(),
                formed: -1,
                from: None,
            });
            entry = (nodes.len() - 1) as u32;
            shared[index as usize] = entry;
        }
        path.push(entry as usize);
    }
    Ok(path)
}

#[derive(Clone, Debug)]
pub struct Influence {
    pub bone: u32,
    pub weight: f64,
    pub position: Vec3,
    path: Vec<usize>,
}

/// One node below the root, in `traverse` order, with the transform it resolved with.
#[derive(Clone, Debug)]
struct SubtreeNode {
    node: u32,
    parent: u32,
    transform: Guard,
}

/// Translate one spring root to a weighted, skinned point without refreshing any source node's
/// matrices. All source transforms are composed in private scratch.
///
/// Bone skinning only. The spec names bones and bind-space positions rather than a mesh vertex,
/// so there is no morph data to read: a shape key that moves the skin under the point is not
/// followed, and the root sits where the skeleton alone puts the skin.
#[derive(Clone, Debug)]
pub struct SkinPointAnchor {
    pub root: u32,
    pub influences: Vec<Influence>,
    pub target_world: Vec3,
    pub root_world: Vec3,
    pub error: f64,
    nodes: Vec<PathNode>,
    parent_path: Vec<usize>,
    subtree: Vec<SubtreeNode>,
    root_transform: Guard,
    /// Counts placements, so a path node shared by several paths is handled once in each.
    placement: i64,
}

impl SkinPointAnchor {
    // skin-point-anchor.ts SkinPointAnchor.constructor
    //
    // The numeric half: paths and the transforms they resolved with. The spec has been read and
    // its names resolved by the caller.
    pub fn new(scene: &Scene, root: u32, influences: &[(u32, f64, Vec3)]) -> Result<Self, Failure> {
        let parent = scene.parent(root).expect("an anchor root has a parent");
        let mut nodes = Vec::new();
        let mut shared = vec![NONE; scene.len()];
        let mut resolved = Vec::with_capacity(influences.len());
        for &(bone, weight, position) in influences {
            let path = matrix_path(scene, bone, &mut nodes, &mut shared)?;
            resolved.push(Influence {
                bone,
                weight,
                position,
                path,
            });
        }
        let parent_path = matrix_path(scene, parent, &mut nodes, &mut shared)?;
        let mut local = Mat4::default();
        let root_node = scene.node(root);
        read_local_matrix(root_node, &mut local);
        let root_transform = snapshot_transform(root, root_node, &local)?;
        let mut subtree = Vec::new();
        Self::read_subtree_transforms(scene, root, &mut subtree)?;
        Ok(Self {
            root,
            influences: resolved,
            target_world: Vec3::default(),
            root_world: Vec3::default(),
            error: 0.0,
            nodes,
            parent_path,
            subtree,
            root_transform,
            placement: 0,
        })
    }

    // skin-point-anchor.ts SkinPointAnchor.#readSubtreeTransforms
    fn read_subtree_transforms(
        scene: &Scene,
        node: u32,
        out: &mut Vec<SubtreeNode>,
    ) -> Result<(), Failure> {
        for &child in scene.children(node) {
            let n = scene.node(child);
            if !n.matrix_world_auto_update {
                return fail(StatusKind::AnchorWorldOverride, child);
            }
            let mut local = Mat4::default();
            read_local_matrix(n, &mut local);
            out.push(SubtreeNode {
                node: child,
                parent: node,
                transform: snapshot_transform(child, n, &local)?,
            });
            Self::read_subtree_transforms(scene, child, out)?;
        }
        Ok(())
    }

    /// Every node of the parent path and of each influence's path.
    pub fn path_nodes(&self) -> impl Iterator<Item = u32> + '_ {
        self.nodes.iter().map(|n| n.node)
    }

    /// Every node below the root.
    pub fn subtree_nodes(&self) -> impl Iterator<Item = u32> + '_ {
        self.subtree.iter().map(|n| n.node)
    }

    // skin-point-anchor.ts SkinPointAnchor.place
    //
    // `inputs`: world matrices standing in for nodes no chain moves, so a step between two frames
    // composes from the body between them.
    pub fn place(&mut self, scene: &mut Scene, inputs: Option<&InputWorld>) -> Result<(), Failure> {
        self.placement += 1;
        let placement = self.placement;
        let root = self.root;
        if scene.node(root).reparented {
            return fail(StatusKind::AnchorRootReparented, root);
        }
        if !scene.node(root).matrix_world_auto_update {
            return fail(StatusKind::AnchorWorldOverride, root);
        }
        self.target_world.set(0.0, 0.0, 0.0);
        let mut world = Mat4::default();
        for influence in &self.influences {
            if influence.weight == 0.0 {
                continue;
            }
            walk(
                &mut self.nodes,
                &influence.path,
                placement,
                scene,
                inputs,
                &mut world,
            )?;
            let mut point = influence.position;
            point.apply_matrix4(&world);
            self.target_world
                .add_scaled_vector(&point, influence.weight);
        }

        let mut parent_world = Mat4::default();
        walk(
            &mut self.nodes,
            &self.parent_path,
            placement,
            scene,
            inputs,
            &mut parent_world,
        )?;
        let determinant = parent_world.determinant();
        if !(determinant.is_finite() && determinant.abs() > 1e-18) {
            return fail(StatusKind::AnchorParentSingular, NONE);
        }
        let mut inverse_parent = parent_world;
        inverse_parent.invert();
        let node = scene.node_mut(root);
        node.position
            .copy(&self.target_world)
            .apply_matrix4(&inverse_parent);
        let mut local = Mat4::default();
        read_local_matrix(node, &mut local);
        assert_transform_stable(root, node, &local, &self.root_transform)?;
        node.update_matrix();
        let mut root_matrix = Mat4::default();
        root_matrix.multiply_matrices(&parent_world, &node.matrix);
        node.matrix_world.copy(&root_matrix);
        node.matrix_world_needs_update = false;
        self.refresh_subtree(scene)?;
        self.root_world.set_from_matrix_position(&root_matrix);
        self.error = self.root_world.distance_to(&self.target_world);
        Ok(())
    }

    // skin-point-anchor.ts SkinPointAnchor.#refreshSubtree
    fn refresh_subtree(&self, scene: &mut Scene) -> Result<(), Failure> {
        for entry in &self.subtree {
            let child = scene.node_mut(entry.node);
            if !child.matrix_world_auto_update {
                return fail(StatusKind::AnchorWorldOverride, entry.node);
            }
            if child.matrix_auto_update {
                child.update_matrix();
            }
            assert_transform_stable(entry.node, child, &child.matrix, &entry.transform)?;
            if child.reparented {
                return fail(StatusKind::AnchorSubtreeReparented, entry.node);
            }
            scene.hang(entry.node, entry.parent);
            scene.node_mut(entry.node).matrix_world_needs_update = false;
        }
        Ok(())
    }
}

// skin-point-anchor.ts SkinPointAnchor.#walk
fn walk(
    nodes: &mut [PathNode],
    path: &[usize],
    placement: i64,
    scene: &Scene,
    inputs: Option<&InputWorld>,
    out: &mut Mat4,
) -> Result<(), Failure> {
    out.identity();
    // Compose from the deepest node given a world matrix, guarding the whole path.
    let mut start = 0;
    if let Some(inputs) = inputs {
        for i in (0..path.len()).rev() {
            if let Some(world) = inputs.get(nodes[path[i]].node) {
                out.copy(world);
                start = i + 1;
                break;
            }
        }
    }
    let from = (start > 0).then(|| path[start - 1]);
    for (i, &e) in path.iter().enumerate() {
        // Nothing a placement does moves a path node, so one guarded by an earlier
        // path of this placement passes again, and a product formed from the same
        // start comes out the same.
        if nodes[e].guarded == placement {
            if i >= start {
                extend(&mut nodes[e], out, from, placement);
            }
            continue;
        }
        let entry = &mut nodes[e];
        let index = entry.node;
        let node = scene.node(index);
        if node.reparented {
            let kind = if i > 0 {
                StatusKind::AnchorPathReparented
            } else {
                StatusKind::AnchorPathRootReparented
            };
            return fail(kind, index);
        }
        if !node.matrix_world_auto_update {
            return fail(StatusKind::AnchorWorldOverride, index);
        }
        // A node shared by several paths, or one nothing has moved since the last
        // placement, is read and guarded once.
        if !(matches!(entry.transform, Guard::Auto { .. }) && still_passed(entry, node)) {
            read_local_matrix(node, &mut entry.local);
            assert_transform_stable(index, node, &entry.local, &entry.transform)?;
            remember_passed(entry, node);
        }
        entry.guarded = placement;
        if i >= start {
            extend(entry, out, from, placement);
        }
    }
    Ok(())
}

// skin-point-anchor.ts SkinPointAnchor.#extend
//
// Carry `out` through `entry`'s local matrix, or take the product already formed there.
fn extend(entry: &mut PathNode, out: &mut Mat4, from: Option<usize>, placement: i64) {
    if entry.formed == placement && entry.from == from {
        out.copy(&entry.world);
        return;
    }
    out.multiply(&entry.local);
    entry.world.copy(out);
    entry.formed = placement;
    entry.from = from;
}

#[cfg(test)]
mod tests {
    use super::super::testkit::{Rig, chain, euler_xyz, group};
    use super::super::{Spring, StatusKind};
    use super::{Failure, SkinPointAnchor};
    use crate::math::{Mat4, Quat, Vec3};
    use crate::scene::{NONE, Node, Scene};

    const STEP: f64 = 1.0 / 60.0;

    /// Two producer chains, and with `attached` a charm placed on four of their bones.
    fn producers(attached: bool) -> (Rig, Spring, u32) {
        let mut rig = Rig::humanoid(0.01);
        let (hips, spine) = (rig.bone("Hips"), rig.bone("Spine"));
        let a = chain(&mut rig, hips, 3, [0.0, -0.025, 0.03], [0.0, -0.08, 0.02]);
        let b = chain(&mut rig, spine, 3, [0.0, -0.025, 0.03], [0.0, -0.08, 0.02]);
        let charm = chain(&mut rig, hips, 3, [0.0, -0.025, 0.03], [0.0, -0.08, 0.02]);
        let mut spring = rig.spring();
        for (root, figures) in [(a[0], (0.9, 0.32, 0.11)), (b[0], (0.7, 0.41, 0.07))] {
            spring.begin_group(group(figures.0, figures.1, figures.2));
            spring.add_group_root(root);
            assert!(spring.end_group() > 0);
        }
        if attached {
            spring.begin_group(group(0.0, 0.45, 0.16));
            spring.add_group_root(charm[0]);
            spring.set_group_anchor(charm[0]);
            spring.add_anchor_influence(a[1], 0.31, Vec3::new(0.0, -2.0, 0.0));
            spring.add_anchor_influence(a[2], 0.27, Vec3::new(1.0, -3.0, 0.5));
            spring.add_anchor_influence(b[1], 0.22, Vec3::new(-0.5, -2.0, 1.0));
            spring.add_anchor_influence(b[2], 0.2, Vec3::new(0.0, -1.0, -1.0));
            assert!(spring.end_group() > 0);
        }
        spring.build();
        assert!(spring.statuses().is_empty());
        (rig, spring, a[1])
    }

    fn pose(rig: &Rig, spring: &mut Spring, frame: f64) {
        let root = spring.scene_mut().node_mut(0);
        root.position.set(
            0.3 + (frame * 0.13).sin() * 0.04,
            (frame * 0.07).cos() * 0.03,
            -0.2 + (frame * 0.11).sin() * 0.02,
        );
        root.quaternion = euler_xyz([
            (frame * 0.03).sin() * 0.11,
            (frame * 0.05).cos() * 0.16,
            (frame * 0.09).sin() * 0.08,
        ]);
        let (hips, spine) = (rig.bone("Hips"), rig.bone("Spine"));
        rig.rotate(
            spring,
            hips,
            [
                (frame * 0.12).sin() * 0.24,
                (frame * 0.08).cos() * 0.2,
                (frame * 0.17).sin() * 0.19,
            ],
        );
        rig.rotate(
            spring,
            spine,
            [
                (frame * 0.09).cos() * 0.2,
                (frame * 0.14).sin() * 0.16,
                (frame * 0.18).cos() * 0.13,
            ],
        );
        rig.world_update(spring);
    }

    /// The producers' tails, rotations and matrices, as bits.
    fn producer_state(spring: &Spring) -> Vec<u64> {
        let mut out = Vec::new();
        for g in &spring.groups()[..2] {
            for j in &g.joints {
                let n = spring.scene().node(j.bone);
                let (c, p, q) = (j.cur, j.prev, n.quaternion);
                out.extend([c.x, c.y, c.z, p.x, p.y, p.z, q.x, q.y, q.z, q.w].map(f64::to_bits));
                out.extend(n.matrix.elements.map(f64::to_bits));
                out.extend(n.matrix_world.elements.map(f64::to_bits));
                out.push(u64::from(n.matrix_world_needs_update));
            }
        }
        out
    }

    #[test]
    fn an_attachment_changes_no_bit_of_its_producers() {
        let (rig_p, mut plain) = {
            let (r, s, _) = producers(false);
            (r, s)
        };
        let (rig_a, mut attached, _) = producers(true);
        let durations = [STEP, 1.0 / 30.0, 0.05, STEP, 0.007, 1.0 / 30.0, 0.05, 0.0];
        for frame in 0..240 {
            pose(&rig_p, &mut plain, frame as f64);
            pose(&rig_a, &mut attached, frame as f64);
            let dt = durations[frame % durations.len()];
            plain.update(dt);
            attached.update(dt);
            assert_eq!(
                producer_state(&attached),
                producer_state(&plain),
                "frame {frame}"
            );
        }
    }

    #[test]
    fn a_stale_producer_matrix_between_steps_is_caught() {
        let (rig_p, mut plain, _) = producers(false);
        let (rig_b, mut broken, source) = producers(true);
        broken.after_place = Some(source);
        for frame in 0..80 {
            pose(&rig_p, &mut plain, frame as f64);
            pose(&rig_b, &mut broken, frame as f64);
            plain.update(0.05);
            broken.update(0.05);
        }
        assert_ne!(producer_state(&broken), producer_state(&plain));
    }

    /// A placed avatar under a scene, four sources on its hips and a two-link charm.
    struct Skin {
        scene: Scene,
        avatar: u32,
        hips: u32,
        sources: [u32; 4],
        root: u32,
        link: u32,
        influences: Vec<(u32, f64, Vec3)>,
    }

    fn add(scene: &mut Scene, parent: u32, position: [f64; 3], is_bone: bool) -> u32 {
        let mut node = Node {
            parent,
            is_bone,
            ..Node::default()
        };
        node.position.set(position[0], position[1], position[2]);
        scene.push(node)
    }

    fn world_update(scene: &mut Scene) {
        let all: Vec<u32> = (0..scene.len() as u32).collect();
        scene.update_matrix_world_forced(&all);
    }

    fn skin() -> Skin {
        let mut scene = Scene::default();
        let top = add(&mut scene, NONE, [0.0; 3], false);
        let avatar = add(&mut scene, top, [2.3, -1.2, 0.7], false);
        let n = scene.node_mut(avatar);
        n.quaternion = euler_xyz([0.31, -0.22, 0.48]);
        n.scale.set(0.01, 0.01, 0.01);
        let hips = add(&mut scene, avatar, [2.0, 90.0, -1.0], true);
        let sources = [0, 1, 2, 3].map(|i| {
            let i = f64::from(i);
            add(
                &mut scene,
                hips,
                [-22.0 + i * 13.0, 4.0 + i * 5.0, -9.0 + i * 7.0],
                true,
            )
        });
        let root = add(&mut scene, hips, [0.0; 3], true);
        let link = add(&mut scene, root, [0.0, -3.5, 0.0], true);
        add(&mut scene, link, [0.0, -3.5, 0.0], true);
        world_update(&mut scene);
        let influences = sources
            .iter()
            .enumerate()
            .map(|(i, &s)| {
                let i = i as f64;
                (
                    s,
                    0.1 * (i + 1.0),
                    Vec3::new(3.1 - i, -2.0 + 0.7 * i, 1.3 * i - 0.4),
                )
            })
            .collect();
        Skin {
            scene,
            avatar,
            hips,
            sources,
            root,
            link,
            influences,
        }
    }

    impl Skin {
        fn anchor(&self) -> Result<SkinPointAnchor, Failure> {
            SkinPointAnchor::new(&self.scene, self.root, &self.influences)
        }

        /// The weighted sum of each influence's position through its bone's world matrix,
        /// after a world update, independent of the anchor's own composition.
        fn oracle(&mut self) -> Vec3 {
            world_update(&mut self.scene);
            let mut out = Vec3::default();
            for &(bone, weight, position) in &self.influences {
                let mut p = position;
                p.apply_matrix4(&self.scene.node(bone).matrix_world);
                out.add_scaled_vector(&p, weight);
            }
            out
        }

        fn source_matrices(&self) -> Vec<(Mat4, Mat4, bool)> {
            [0, self.avatar, self.hips]
                .iter()
                .chain(&self.sources)
                .map(|&i| {
                    let n = self.scene.node(i);
                    (n.matrix, n.matrix_world, n.matrix_world_needs_update)
                })
                .collect()
        }
    }

    /// Which node of a fixture a case touches, what it does there, and what that breaks.
    type Pick = fn(&Skin) -> u32;
    type ScaleCase = (Pick, fn(&mut Vec3));
    type NodeCase = (Pick, fn(&mut Node), StatusKind);

    fn failure(kind: StatusKind, node: u32) -> Failure {
        Failure { kind, node }
    }

    #[test]
    fn places_a_four_weight_point_through_scale_and_moved_ancestors() {
        let mut skin = skin();
        let mut anchor = skin.anchor().expect("valid");
        let s = &mut skin.scene;
        s.node_mut(skin.avatar).position.set(-1.7, 0.6, 2.2);
        s.node_mut(skin.avatar).quaternion = euler_xyz([-0.27, 0.42, -0.19]);
        s.node_mut(skin.hips).quaternion = euler_xyz([0.2, -0.13, 0.34]);
        s.node_mut(skin.sources[0]).quaternion = euler_xyz([0.18, 0.12, -0.3]);
        s.node_mut(skin.sources[1]).position.x += 7.0;
        s.node_mut(skin.sources[2]).quaternion = euler_xyz([-0.24, 0.31, 0.16]);
        s.node_mut(skin.sources[3]).position.z -= 5.0;
        world_update(s);
        let before = skin.source_matrices();
        anchor.place(&mut skin.scene, None).expect("placed");
        assert_eq!(skin.source_matrices(), before, "placement touched a source");
        let oracle = skin.oracle();
        assert!(anchor.target_world.distance_to(&oracle) < 2e-6);
        assert!(anchor.root_world.distance_to(&oracle) < 2e-6);
        assert!(anchor.error < 2e-6);
        // The point is a blend, not the dominant bone's alone.
        let (bone, _, position) = skin.influences[3];
        let mut dominant = position;
        dominant.apply_matrix4(&skin.scene.node(bone).matrix_world);
        assert!(dominant.distance_to(&oracle) > 1e-3);
    }

    #[test]
    fn accepts_float32_ppm_scale_and_stays_put_through_rotation() {
        let mut skin = skin();
        let f = |x: f64| f64::from(x as f32);
        let root = skin.scene.node_mut(skin.root);
        root.scale
            .set(f(1.0), f(0.9999998807907104), f(1.0000059604644775));
        root.quaternion = Quat::new(
            f(-0.5785567164421082),
            f(0.5854491591453552),
            f(-0.5619037747383118),
            f(-0.08237501978874207),
        );
        let length = root.quaternion.length();
        assert!((length - 1.0).abs() > 4e-8 && (length - 1.0).abs() < 5e-8);
        let mut anchor = skin.anchor().expect("valid");
        let mut rotated = Quat::default();
        rotated.set_from_axis_angle(&Vec3::new(1.0, 0.0, 0.0), std::f64::consts::PI / 100.0);
        skin.scene.node_mut(skin.root).quaternion = Quat::new(
            rotated.x * length,
            rotated.y * length,
            rotated.z * length,
            rotated.w * length,
        );
        let before = skin.source_matrices();
        anchor.place(&mut skin.scene, None).expect("placed");
        assert_eq!(skin.source_matrices(), before);
        let oracle = skin.oracle();
        assert!(anchor.root_world.distance_to(&oracle) < 2e-6);
    }

    #[test]
    fn rejects_shear_and_changed_scale() {
        let mut sheared = skin();
        let link = sheared.scene.node_mut(sheared.link);
        link.update_matrix();
        link.matrix.elements[4] = 2e-6;
        link.matrix_auto_update = false;
        let link = sheared.link;
        assert_eq!(
            sheared.anchor().err(),
            Some(failure(StatusKind::AnchorShear, link))
        );

        let changes: [ScaleCase; 4] = [
            (
                |s| s.sources[0],
                |k| {
                    k.multiply_scalar(1.001);
                },
            ),
            (|s| s.sources[0], |k| k.x += 1e-7),
            (|s| s.link, |k| k.x += 1e-7),
            (|s| s.root, |k| k.x += 1e-7),
        ];
        for (node, change) in changes {
            let mut s = skin();
            let mut anchor = s.anchor().expect("valid");
            let node = node(&s);
            change(&mut s.scene.node_mut(node).scale);
            assert_eq!(
                anchor.place(&mut s.scene, None).err(),
                Some(failure(StatusKind::AnchorScaleChanged, node))
            );
        }
    }

    #[test]
    fn rejects_unsupported_transforms_and_moved_nodes() {
        let mut s = skin();
        s.scene.node_mut(s.avatar).scale.set(0.01, 0.02, 0.01);
        assert_eq!(
            s.anchor().err(),
            Some(failure(StatusKind::AnchorNonuniform, s.avatar))
        );
        s.scene.node_mut(s.avatar).scale.set(0.01, 0.01, 0.01);
        s.scene.node_mut(s.avatar).matrix_world_auto_update = false;
        assert_eq!(
            s.anchor().err(),
            Some(failure(StatusKind::AnchorWorldOverride, s.avatar))
        );

        let cases: [NodeCase; 4] = [
            (
                |s| s.sources[0],
                |n| n.matrix_world_auto_update = false,
                StatusKind::AnchorWorldOverride,
            ),
            (
                |s| s.sources[0],
                |n| n.reparented = true,
                StatusKind::AnchorPathReparented,
            ),
            (
                |s| s.root,
                |n| n.reparented = true,
                StatusKind::AnchorRootReparented,
            ),
            (
                |s| s.root,
                |n| n.matrix_world_auto_update = false,
                StatusKind::AnchorWorldOverride,
            ),
        ];
        for (node, change, kind) in cases {
            let mut s = skin();
            let mut anchor = s.anchor().expect("valid");
            let node = node(&s);
            change(s.scene.node_mut(node));
            assert_eq!(
                anchor.place(&mut s.scene, None).err(),
                Some(failure(kind, node))
            );
        }
    }
}
