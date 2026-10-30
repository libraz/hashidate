//! Placement of an attached spring root on a weighted, skinned point, and the transform contract
//! it guards on every placement.

use super::StatusKind;
use super::spring::InputWorld;
use super::tree::Tree;
use crate::math::f::{hypot3, js_max};
use crate::math::{Mat4, Quat, Vec3};
use crate::scene::graph::NO_NODE;

const MANUAL_MATRIX_SCALE_TOLERANCE: f64 = 2e-7;
const UNIFORM_SCALE_TOLERANCE: f64 = 1e-5;
const ORTHOGONAL_TOLERANCE: f64 = 1e-6;

/// A broken contract: what broke, and on which node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Failure {
    pub kind: StatusKind,
    /// The node it broke on, or [`NO_NODE`] when the failure is not about one node.
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
fn read_local_matrix(scene: &Tree, index: u32, out: &mut Mat4) {
    if scene.matrix_auto_update(index) {
        out.compose(
            &scene.position(index),
            &scene.quaternion(index),
            &scene.scale(index),
        );
    } else {
        out.copy(&scene.matrix(index));
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
fn snapshot_transform(index: u32, scene: &Tree, matrix: &Mat4) -> Result<Guard, Failure> {
    let scale = transform_scale(index, matrix)?;
    Ok(if scene.matrix_auto_update(index) {
        let k = scene.scale(index);
        Guard::Auto {
            scale: [k.x, k.y, k.z],
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
    scene: &Tree,
    matrix: &Mat4,
    expected: &Guard,
) -> Result<(), Failure> {
    if scene.matrix_auto_update(index) != matches!(expected, Guard::Auto { .. }) {
        return fail(StatusKind::AnchorModeChanged, index);
    }
    let scale = transform_scale(index, matrix)?;
    match *expected {
        Guard::Auto { scale: expected } => {
            // A changing quaternion can perturb composed column lengths by Float32
            // roundoff. The Object3D TRS scale itself is the immutable contract.
            let k = scene.scale(index);
            if !(k.x == expected[0] && k.y == expected[1] && k.z == expected[2]) {
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
fn still_passed(entry: &PathNode, scene: &Tree) -> bool {
    if !(entry.has_passed && scene.matrix_auto_update(entry.node)) {
        return false;
    }
    let (p, q, k) = trs(scene, entry.node);
    let now = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, k.x, k.y, k.z];
    now.iter()
        .zip(&entry.passed)
        .all(|(&a, &b)| same_value(a, b))
}

// skin-point-anchor.ts rememberPassed
fn remember_passed(entry: &mut PathNode, scene: &Tree) {
    entry.has_passed = scene.matrix_auto_update(entry.node);
    if !entry.has_passed {
        return;
    }
    let (p, q, k) = trs(scene, entry.node);
    entry.passed = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, k.x, k.y, k.z];
}

fn trs(scene: &Tree, index: u32) -> (Vec3, Quat, Vec3) {
    (
        scene.position(index),
        scene.quaternion(index),
        scene.scale(index),
    )
}

// skin-point-anchor.ts matrixPath
fn matrix_path(
    scene: &Tree,
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
        if !scene.matrix_world_auto_update(index) {
            return fail(StatusKind::AnchorWorldOverride, index);
        }
        let mut entry = shared[index as usize];
        if entry == NO_NODE {
            let mut local = Mat4::default();
            read_local_matrix(scene, index, &mut local);
            nodes.push(PathNode {
                node: index,
                transform: snapshot_transform(index, scene, &local)?,
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
    pub(crate) fn new(
        scene: &Tree,
        root: u32,
        influences: &[(u32, f64, Vec3)],
    ) -> Result<Self, Failure> {
        let parent = scene.parent(root).expect("an anchor root has a parent");
        let mut nodes = Vec::new();
        let mut shared = vec![NO_NODE; scene.len()];
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
        read_local_matrix(scene, root, &mut local);
        let root_transform = snapshot_transform(root, scene, &local)?;
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
        scene: &Tree,
        node: u32,
        out: &mut Vec<SubtreeNode>,
    ) -> Result<(), Failure> {
        for &child in scene.children(node) {
            if !scene.matrix_world_auto_update(child) {
                return fail(StatusKind::AnchorWorldOverride, child);
            }
            let mut local = Mat4::default();
            read_local_matrix(scene, child, &mut local);
            out.push(SubtreeNode {
                node: child,
                parent: node,
                transform: snapshot_transform(child, scene, &local)?,
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
    pub(crate) fn place(
        &mut self,
        scene: &mut Tree,
        inputs: Option<&InputWorld>,
    ) -> Result<(), Failure> {
        self.placement += 1;
        let placement = self.placement;
        let root = self.root;
        if !scene.matrix_world_auto_update(root) {
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
            return fail(StatusKind::AnchorParentSingular, NO_NODE);
        }
        let mut inverse_parent = parent_world;
        inverse_parent.invert();
        let mut position = self.target_world;
        position.apply_matrix4(&inverse_parent);
        scene.set_position(root, &position);
        let mut local = Mat4::default();
        read_local_matrix(scene, root, &mut local);
        assert_transform_stable(root, scene, &local, &self.root_transform)?;
        scene.update_matrix(root);
        let mut root_matrix = Mat4::default();
        root_matrix.multiply_matrices(&parent_world, &scene.matrix(root));
        scene.set_matrix_world(root, &root_matrix);
        scene.clear_needs_update(root);
        self.refresh_subtree(scene)?;
        self.root_world.set_from_matrix_position(&root_matrix);
        self.error = self.root_world.distance_to(&self.target_world);
        Ok(())
    }

    // skin-point-anchor.ts SkinPointAnchor.#refreshSubtree
    fn refresh_subtree(&self, scene: &mut Tree) -> Result<(), Failure> {
        for entry in &self.subtree {
            let child = entry.node;
            if !scene.matrix_world_auto_update(child) {
                return fail(StatusKind::AnchorWorldOverride, child);
            }
            if scene.matrix_auto_update(child) {
                scene.update_matrix(child);
            }
            assert_transform_stable(child, scene, &scene.matrix(child), &entry.transform)?;
            scene.hang(child, entry.parent);
            scene.clear_needs_update(child);
        }
        Ok(())
    }
}

// skin-point-anchor.ts SkinPointAnchor.#walk
fn walk(
    nodes: &mut [PathNode],
    path: &[usize],
    placement: i64,
    scene: &Tree,
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
        if !scene.matrix_world_auto_update(index) {
            return fail(StatusKind::AnchorWorldOverride, index);
        }
        // A node shared by several paths, or one nothing has moved since the last
        // placement, is read and guarded once.
        if !(matches!(entry.transform, Guard::Auto { .. }) && still_passed(entry, scene)) {
            read_local_matrix(scene, index, &mut entry.local);
            assert_transform_stable(index, scene, &entry.local, &entry.transform)?;
            remember_passed(entry, scene);
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
    use super::super::Spring;
    use super::super::StatusKind;
    use super::super::testkit::{
        Node, Rig, chain, euler_xyz, graph, group, matrix, matrix_world, needs_update, quaternion,
        set_quaternion, world_update,
    };
    use super::super::tree::Tree;
    use super::{Failure, SkinPointAnchor};
    use crate::math::{Mat4, Quat, Vec3};
    use crate::scene::graph::{Graph, NO_NODE, flag};

    const STEP: f64 = 1.0 / 60.0;

    fn read3(s: &[f64], i: u32) -> Vec3 {
        let at = 3 * i as usize;
        Vec3::new(s[at], s[at + 1], s[at + 2])
    }

    fn write3(s: &mut [f64], i: u32, v: &Vec3) {
        let at = 3 * i as usize;
        s[at..at + 3].copy_from_slice(&[v.x, v.y, v.z]);
    }

    /// Two producer chains, and with `attached` a charm placed on four of their bones.
    fn producers(attached: bool) -> (Rig, Graph, Spring, u32) {
        let mut rig = Rig::humanoid(0.01);
        let (hips, spine) = (rig.bone("Hips"), rig.bone("Spine"));
        let a = chain(&mut rig, hips, 3, [0.0, -0.025, 0.03], [0.0, -0.08, 0.02]);
        let b = chain(&mut rig, spine, 3, [0.0, -0.025, 0.03], [0.0, -0.08, 0.02]);
        let charm = chain(&mut rig, hips, 3, [0.0, -0.025, 0.03], [0.0, -0.08, 0.02]);
        let (mut graph, mut spring) = rig.spring();
        let at = |ids: &[u32]| -> Vec<u32> { ids.iter().map(|&id| rig.at(id)).collect() };
        let (a, b, charm) = (at(&a), at(&b), at(&charm));
        for (root, figures) in [(a[0], (0.9, 0.32, 0.11)), (b[0], (0.7, 0.41, 0.07))] {
            spring.begin_group(group(figures.0, figures.1, figures.2));
            spring.add_group_root(root);
            assert!(spring.end_group(&mut graph) > 0);
        }
        if attached {
            spring.begin_group(group(0.0, 0.45, 0.16));
            spring.add_group_root(charm[0]);
            spring.set_group_anchor(charm[0]);
            spring.add_anchor_influence(a[1], 0.31, Vec3::new(0.0, -2.0, 0.0));
            spring.add_anchor_influence(a[2], 0.27, Vec3::new(1.0, -3.0, 0.5));
            spring.add_anchor_influence(b[1], 0.22, Vec3::new(-0.5, -2.0, 1.0));
            spring.add_anchor_influence(b[2], 0.2, Vec3::new(0.0, -1.0, -1.0));
            assert!(spring.end_group(&mut graph) > 0);
        }
        spring.build(&mut graph);
        assert!(spring.statuses().is_empty());
        (rig, graph, spring, a[1])
    }

    fn pose(rig: &Rig, graph: &mut Graph, frame: f64) {
        write3(
            &mut graph.position,
            0,
            &Vec3::new(
                0.3 + (frame * 0.13).sin() * 0.04,
                (frame * 0.07).cos() * 0.03,
                -0.2 + (frame * 0.11).sin() * 0.02,
            ),
        );
        set_quaternion(
            graph,
            0,
            &euler_xyz([
                (frame * 0.03).sin() * 0.11,
                (frame * 0.05).cos() * 0.16,
                (frame * 0.09).sin() * 0.08,
            ]),
        );
        let hips = euler_xyz([
            (frame * 0.12).sin() * 0.24,
            (frame * 0.08).cos() * 0.2,
            (frame * 0.17).sin() * 0.19,
        ]);
        set_quaternion(graph, rig.node("Hips"), &hips);
        let spine = euler_xyz([
            (frame * 0.09).cos() * 0.2,
            (frame * 0.14).sin() * 0.16,
            (frame * 0.18).cos() * 0.13,
        ]);
        set_quaternion(graph, rig.node("Spine"), &spine);
        world_update(graph);
    }

    /// The producers' tails, rotations and matrices, as bits.
    fn producer_state(graph: &Graph, spring: &Spring) -> Vec<u64> {
        let mut out = Vec::new();
        for g in &spring.groups()[..2] {
            for j in &g.joints {
                let (c, p, q) = (j.cur, j.prev, quaternion(graph, j.bone));
                out.extend([c.x, c.y, c.z, p.x, p.y, p.z, q.x, q.y, q.z, q.w].map(f64::to_bits));
                out.extend(matrix(graph, j.bone).elements.map(f64::to_bits));
                out.extend(matrix_world(graph, j.bone).elements.map(f64::to_bits));
                out.push(u64::from(needs_update(graph, j.bone)));
            }
        }
        out
    }

    #[test]
    fn an_attachment_changes_no_bit_of_its_producers() {
        let (rig_p, mut graph_p, mut plain, _) = producers(false);
        let (rig_a, mut graph_a, mut attached, _) = producers(true);
        let durations = [STEP, 1.0 / 30.0, 0.05, STEP, 0.007, 1.0 / 30.0, 0.05, 0.0];
        for frame in 0..240 {
            pose(&rig_p, &mut graph_p, frame as f64);
            pose(&rig_a, &mut graph_a, frame as f64);
            let dt = durations[frame % durations.len()];
            plain.update(&mut graph_p, dt);
            attached.update(&mut graph_a, dt);
            assert_eq!(
                producer_state(&graph_a, &attached),
                producer_state(&graph_p, &plain),
                "frame {frame}"
            );
        }
    }

    #[test]
    fn a_stale_producer_matrix_between_steps_is_caught() {
        let (rig_p, mut graph_p, mut plain, _) = producers(false);
        let (rig_b, mut graph_b, mut broken, source) = producers(true);
        broken.after_place = Some(source);
        for frame in 0..80 {
            pose(&rig_p, &mut graph_p, frame as f64);
            pose(&rig_b, &mut graph_b, frame as f64);
            plain.update(&mut graph_p, 0.05);
            broken.update(&mut graph_b, 0.05);
        }
        assert_ne!(
            producer_state(&graph_b, &broken),
            producer_state(&graph_p, &plain)
        );
    }

    /// A placed avatar under a scene, four sources on its hips and a two-link charm. Nodes are
    /// added in `traverse` order, so their ids are their graph indices.
    struct Skin {
        graph: Graph,
        avatar: u32,
        hips: u32,
        sources: [u32; 4],
        root: u32,
        link: u32,
        influences: Vec<(u32, f64, Vec3)>,
    }

    fn add(nodes: &mut Vec<Node>, parent: u32, position: [f64; 3], is_bone: bool) -> u32 {
        nodes.push(Node::new(parent, is_bone, position));
        (nodes.len() - 1) as u32
    }

    fn skin() -> Skin {
        let mut nodes = Vec::new();
        let top = add(&mut nodes, NO_NODE, [0.0; 3], false);
        let avatar = add(&mut nodes, top, [2.3, -1.2, 0.7], false);
        let n = &mut nodes[avatar as usize];
        n.quaternion = euler_xyz([0.31, -0.22, 0.48]);
        n.scale.set(0.01, 0.01, 0.01);
        let hips = add(&mut nodes, avatar, [2.0, 90.0, -1.0], true);
        let sources = [0, 1, 2, 3].map(|i| {
            let i = f64::from(i);
            add(
                &mut nodes,
                hips,
                [-22.0 + i * 13.0, 4.0 + i * 5.0, -9.0 + i * 7.0],
                true,
            )
        });
        let root = add(&mut nodes, hips, [0.0; 3], true);
        let link = add(&mut nodes, root, [0.0, -3.5, 0.0], true);
        add(&mut nodes, link, [0.0, -3.5, 0.0], true);
        let (mut graph, _) = graph(&nodes);
        world_update(&mut graph);
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
            graph,
            avatar,
            hips,
            sources,
            root,
            link,
            influences,
        }
    }

    impl Skin {
        fn anchor(&mut self) -> Result<SkinPointAnchor, Failure> {
            SkinPointAnchor::new(&Tree::new(&mut self.graph), self.root, &self.influences)
        }

        fn place(&mut self, anchor: &mut SkinPointAnchor) -> Result<(), Failure> {
            anchor.place(&mut Tree::new(&mut self.graph), None)
        }

        /// The weighted sum of each influence's position through its bone's world matrix,
        /// after a world update, independent of the anchor's own composition.
        fn oracle(&mut self) -> Vec3 {
            world_update(&mut self.graph);
            let mut out = Vec3::default();
            for &(bone, weight, position) in &self.influences {
                let mut p = position;
                p.apply_matrix4(&matrix_world(&self.graph, bone));
                out.add_scaled_vector(&p, weight);
            }
            out
        }

        fn source_matrices(&self) -> Vec<(Mat4, Mat4, bool)> {
            [0, self.avatar, self.hips]
                .iter()
                .chain(&self.sources)
                .map(|&i| {
                    (
                        matrix(&self.graph, i),
                        matrix_world(&self.graph, i),
                        needs_update(&self.graph, i),
                    )
                })
                .collect()
        }

        fn change_scale(&mut self, node: u32, change: fn(&mut Vec3)) {
            let mut k = read3(&self.graph.scale, node);
            change(&mut k);
            write3(&mut self.graph.scale, node, &k);
        }

        fn clear_flag(&mut self, node: u32, bit: u8) {
            self.graph.flags[node as usize] &= !bit;
        }
    }

    /// Which node of a fixture a case touches, and what that change does to its scale.
    type Pick = fn(&Skin) -> u32;
    type ScaleCase = (Pick, fn(&mut Vec3));

    fn failure(kind: StatusKind, node: u32) -> Failure {
        Failure { kind, node }
    }

    #[test]
    fn places_a_four_weight_point_through_scale_and_moved_ancestors() {
        let mut skin = skin();
        let mut anchor = skin.anchor().expect("valid");
        let g = &mut skin.graph;
        write3(&mut g.position, skin.avatar, &Vec3::new(-1.7, 0.6, 2.2));
        set_quaternion(g, skin.avatar, &euler_xyz([-0.27, 0.42, -0.19]));
        set_quaternion(g, skin.hips, &euler_xyz([0.2, -0.13, 0.34]));
        set_quaternion(g, skin.sources[0], &euler_xyz([0.18, 0.12, -0.3]));
        let mut p = read3(&g.position, skin.sources[1]);
        p.x += 7.0;
        write3(&mut g.position, skin.sources[1], &p);
        set_quaternion(g, skin.sources[2], &euler_xyz([-0.24, 0.31, 0.16]));
        let mut p = read3(&g.position, skin.sources[3]);
        p.z -= 5.0;
        write3(&mut g.position, skin.sources[3], &p);
        world_update(g);
        let before = skin.source_matrices();
        skin.place(&mut anchor).expect("placed");
        assert_eq!(skin.source_matrices(), before, "placement touched a source");
        let oracle = skin.oracle();
        assert!(anchor.target_world.distance_to(&oracle) < 2e-6);
        assert!(anchor.root_world.distance_to(&oracle) < 2e-6);
        assert!(anchor.error < 2e-6);
        // The point is a blend, not the dominant bone's alone.
        let (bone, _, position) = skin.influences[3];
        let mut dominant = position;
        dominant.apply_matrix4(&matrix_world(&skin.graph, bone));
        assert!(dominant.distance_to(&oracle) > 1e-3);
    }

    #[test]
    fn accepts_float32_ppm_scale_and_stays_put_through_rotation() {
        let mut skin = skin();
        let f = |x: f64| f64::from(x as f32);
        let root = skin.root;
        write3(
            &mut skin.graph.scale,
            root,
            &Vec3::new(f(1.0), f(0.9999998807907104), f(1.0000059604644775)),
        );
        let q = Quat::new(
            f(-0.5785567164421082),
            f(0.5854491591453552),
            f(-0.5619037747383118),
            f(-0.08237501978874207),
        );
        set_quaternion(&mut skin.graph, root, &q);
        let length = q.length();
        assert!((length - 1.0).abs() > 4e-8 && (length - 1.0).abs() < 5e-8);
        let mut anchor = skin.anchor().expect("valid");
        let mut rotated = Quat::default();
        rotated.set_from_axis_angle(&Vec3::new(1.0, 0.0, 0.0), std::f64::consts::PI / 100.0);
        let scaled = Quat::new(
            rotated.x * length,
            rotated.y * length,
            rotated.z * length,
            rotated.w * length,
        );
        set_quaternion(&mut skin.graph, root, &scaled);
        let before = skin.source_matrices();
        skin.place(&mut anchor).expect("placed");
        assert_eq!(skin.source_matrices(), before);
        let oracle = skin.oracle();
        assert!(anchor.root_world.distance_to(&oracle) < 2e-6);
    }

    #[test]
    fn rejects_shear_and_changed_scale() {
        let mut sheared = skin();
        let link = sheared.link;
        sheared.graph.update_matrix(link);
        sheared.graph.matrix[16 * link as usize + 4] = 2e-6;
        sheared.clear_flag(link, flag::MATRIX_AUTO_UPDATE);
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
            s.change_scale(node, change);
            assert_eq!(
                s.place(&mut anchor).err(),
                Some(failure(StatusKind::AnchorScaleChanged, node))
            );
        }
    }

    #[test]
    fn rejects_unsupported_transforms_and_manual_world_matrices() {
        let mut s = skin();
        let avatar = s.avatar;
        write3(&mut s.graph.scale, avatar, &Vec3::new(0.01, 0.02, 0.01));
        assert_eq!(
            s.anchor().err(),
            Some(failure(StatusKind::AnchorNonuniform, avatar))
        );
        write3(&mut s.graph.scale, avatar, &Vec3::new(0.01, 0.01, 0.01));
        s.clear_flag(avatar, flag::MATRIX_WORLD_AUTO_UPDATE);
        assert_eq!(
            s.anchor().err(),
            Some(failure(StatusKind::AnchorWorldOverride, avatar))
        );

        let picks: [Pick; 2] = [|s| s.sources[0], |s| s.root];
        for node in picks {
            let mut s = skin();
            let mut anchor = s.anchor().expect("valid");
            let node = node(&s);
            s.clear_flag(node, flag::MATRIX_WORLD_AUTO_UPDATE);
            assert_eq!(
                s.place(&mut anchor).err(),
                Some(failure(StatusKind::AnchorWorldOverride, node))
            );
        }
    }
}
