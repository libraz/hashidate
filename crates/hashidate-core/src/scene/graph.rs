//! An avatar's transform hierarchy, owned by the core and viewed in place by three.
//!
//! Nodes are numbered in three's `traverse` order and stored as structure-of-arrays, so the TS
//! side can point a node's `matrix.elements` and its vector accessors straight at these buffers.
//! The update functions are three r186's `Object3D` methods ported operation for operation,
//! including the `SkinnedMesh.updateMatrixWorld` override and `Skeleton.update`.
//!
//! The root's ancestors stay plain three objects. A small mirror of that chain, written by the
//! caller before each call and read back after it, lets the root take three's `parent === null`
//! branch when the chain is empty and the multiply branch otherwise; it is only updated where three
//! would update it, on the climb of `updateWorldMatrix(true, …)`.
//!
//! Children that stay outside the table (outline meshes added after construction) are updated by
//! the caller. A pass records, for each node flagged as having such children, the `force` it handed
//! its children, so the caller can repeat three's call on them afterwards.
//!
//! All allocation happens in [`Graph::new`] and [`Graph::build`]; the update functions allocate
//! nothing.

use crate::math::{Mat4, Quat, Vec3, object3d};

/// Node index meaning "none": the root's parent, or a skeleton slot with no bone in the table.
pub const NO_NODE: u32 = u32::MAX;

/// Bits of a node's flags byte (and, for the first four, of an ancestor's).
pub mod flag {
    pub const MATRIX_AUTO_UPDATE: u8 = 1;
    pub const MATRIX_WORLD_AUTO_UPDATE: u8 = 2;
    pub const MATRIX_WORLD_NEEDS_UPDATE: u8 = 4;
    /// `pivot !== null`; the pivot buffer holds its value.
    pub const PIVOT: u8 = 8;
    /// `isBone`. Fixed at construction.
    pub const BONE: u8 = 16;
    /// `isSkinnedMesh`, registered with [`super::Graph::push_mesh`]. Fixed at construction.
    pub const SKINNED: u8 = 32;
    /// `bindMode === DetachedBindMode`.
    pub const DETACHED: u8 = 64;
    /// The node has children outside the table. Set only through `set_plain_children`.
    pub const PLAIN_CHILDREN: u8 = 128;
}

/// Values of a node's force byte after a pass.
pub mod force {
    /// The pass did not iterate the node's children.
    pub const UNVISITED: u8 = 0;
    /// The pass handed the node's children `force = false`.
    pub const FALSE: u8 = 1;
    /// The pass handed the node's children `force = true`.
    pub const TRUE: u8 = 2;
}

/// f64 per node record: position 3, quaternion 4, scale 3, pivot 3, matrix 16, matrixWorld 16.
pub const RECORD: usize = 45;
pub(crate) const R_POSITION: usize = 0;
pub(crate) const R_QUATERNION: usize = 3;
pub(crate) const R_SCALE: usize = 7;
pub(crate) const R_PIVOT: usize = 10;
pub(crate) const R_MATRIX: usize = 13;
pub(crate) const R_MATRIX_WORLD: usize = 29;

/// Ancestor levels the mirror holds. Production has one (`scene`), tests up to three.
pub const MAX_ANCESTORS: usize = 16;

/// Sizes of a graph, fixed when it is created.
#[derive(Clone, Copy, Debug, Default)]
pub struct Shape {
    pub nodes: usize,
    pub meshes: usize,
    pub skeletons: usize,
    /// Bone slots over every skeleton.
    pub bones: usize,
}

/// A node's parent as three sees it: a node of the table, or a level of the root's ancestor
/// mirror (0 the root's own parent).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Parent {
    Node(u32),
    Ancestor(usize),
}

/// The hierarchy. Every buffer is allocated at its final length by [`Graph::new`].
#[derive(Debug)]
pub struct Graph {
    /// f64 xyz per node.
    pub position: Vec<f64>,
    /// f64 xyzw per node.
    pub quaternion: Vec<f64>,
    /// f64 xyz per node.
    pub scale: Vec<f64>,
    /// f64 xyz per node, read only with [`flag::PIVOT`].
    pub pivot: Vec<f64>,
    /// f64 16 per node, column-major.
    pub matrix: Vec<f64>,
    /// f64 16 per node, column-major.
    pub matrix_world: Vec<f64>,
    /// [`flag`] bits per node.
    pub flags: Vec<u8>,
    /// [`force`] value per node; meaningful only with [`flag::PLAIN_CHILDREN`].
    pub force: Vec<u8>,
    /// Parent per node; [`NO_NODE`] for the root.
    pub parent: Vec<u32>,
    /// Start of each node's run in `children`, plus one past the last (n + 1).
    pub child_offsets: Vec<u32>,
    /// Table children of every node, in three's `children` order.
    pub children: Vec<u32>,
    /// Node per SkinnedMesh slot.
    pub mesh_nodes: Vec<u32>,
    /// f64 16 per mesh.
    pub bind_matrix: Vec<f64>,
    /// f64 16 per mesh.
    pub bind_matrix_inverse: Vec<f64>,
    /// Start of each skeleton's run of bone slots, plus one past the last (skeletons + 1).
    pub skeleton_offsets: Vec<u32>,
    /// Node per bone slot, or [`NO_NODE`] where three's `bones[i]` is absent or outside the table.
    pub bone_nodes: Vec<u32>,
    /// f64 16 per bone slot.
    pub bone_inverses: Vec<f64>,
    /// f32 16 per bone slot, as `Skeleton.update` writes `boneMatrices`.
    pub bone_matrices: Vec<f32>,
    /// [`RECORD`] f64 per ancestor level, the root's parent first.
    pub ancestors: Vec<f64>,
    /// [`flag`] bits per ancestor level (the first four only).
    pub ancestor_flags: Vec<u8>,
    ancestor_count: usize,
    /// Mesh slot per node, or [`NO_NODE`].
    mesh_of: Vec<u32>,
    /// Nodes flagged [`flag::PLAIN_CHILDREN`]; its capacity is the node count, so it never grows.
    plain: Vec<u32>,
    filled: Shape,
    built: bool,
}

fn mat4(s: &[f64], i: usize) -> Mat4 {
    let mut elements = [0.0; 16];
    elements.copy_from_slice(&s[16 * i..16 * i + 16]);
    Mat4::from_elements(elements)
}

fn put_mat4(s: &mut [f64], i: usize, m: &Mat4) {
    s[16 * i..16 * i + 16].copy_from_slice(&m.elements);
}

fn record_mat4(record: &[f64], at: usize) -> Mat4 {
    let mut elements = [0.0; 16];
    elements.copy_from_slice(&record[at..at + 16]);
    Mat4::from_elements(elements)
}

impl Graph {
    /// A graph with every buffer allocated and nothing registered.
    pub fn new(shape: Shape) -> Self {
        let n = shape.nodes;
        Self {
            position: vec![0.0; 3 * n],
            quaternion: vec![0.0; 4 * n],
            scale: vec![0.0; 3 * n],
            pivot: vec![0.0; 3 * n],
            matrix: vec![0.0; 16 * n],
            matrix_world: vec![0.0; 16 * n],
            flags: vec![0; n],
            force: vec![force::UNVISITED; n],
            parent: vec![NO_NODE; n],
            child_offsets: vec![0; n + 1],
            children: vec![0; n.saturating_sub(1)],
            mesh_nodes: vec![NO_NODE; shape.meshes],
            bind_matrix: vec![0.0; 16 * shape.meshes],
            bind_matrix_inverse: vec![0.0; 16 * shape.meshes],
            skeleton_offsets: vec![0; shape.skeletons + 1],
            bone_nodes: vec![NO_NODE; shape.bones],
            bone_inverses: vec![0.0; 16 * shape.bones],
            bone_matrices: vec![0.0; 16 * shape.bones],
            ancestors: vec![0.0; RECORD * MAX_ANCESTORS],
            ancestor_flags: vec![0; MAX_ANCESTORS],
            ancestor_count: 0,
            mesh_of: vec![NO_NODE; n],
            plain: Vec::with_capacity(n),
            filled: Shape::default(),
            built: false,
        }
    }

    pub fn len(&self) -> usize {
        self.flags.len()
    }

    pub fn is_empty(&self) -> bool {
        self.flags.is_empty()
    }

    /// Registers the next node in `traverse` order from a [`RECORD`] and its [`flag`] bits.
    ///
    /// Node 0 is the root and alone has no parent; every other node's parent must be the previous
    /// node or one of its ancestors, so subtrees stay contiguous.
    pub fn push_node(&mut self, parent: u32, flags: u8, record: &[f64]) -> u32 {
        assert!(!self.built, "node registered after build");
        let i = self.filled.nodes;
        assert!(i < self.len(), "more nodes than the graph was sized for");
        if i == 0 {
            assert_eq!(parent, NO_NODE, "the root must have no parent");
        } else {
            assert!(parent != NO_NODE, "node {i} has no parent; only node 0 may");
            let mut at = (i - 1) as u32;
            while at != parent {
                assert!(
                    at != NO_NODE,
                    "node {i} names parent {parent} out of traverse order"
                );
                at = self.parent[at as usize];
            }
        }
        self.parent[i] = parent;
        self.flags[i] = flags;
        self.position[3 * i..3 * i + 3].copy_from_slice(&record[R_POSITION..R_POSITION + 3]);
        self.quaternion[4 * i..4 * i + 4].copy_from_slice(&record[R_QUATERNION..R_QUATERNION + 4]);
        self.scale[3 * i..3 * i + 3].copy_from_slice(&record[R_SCALE..R_SCALE + 3]);
        self.pivot[3 * i..3 * i + 3].copy_from_slice(&record[R_PIVOT..R_PIVOT + 3]);
        put_mat4(&mut self.matrix, i, &record_mat4(record, R_MATRIX));
        put_mat4(
            &mut self.matrix_world,
            i,
            &record_mat4(record, R_MATRIX_WORLD),
        );
        if flags & flag::PLAIN_CHILDREN != 0 {
            self.plain.push(i as u32);
        }
        self.filled.nodes += 1;
        i as u32
    }

    /// Registers node `node`, flagged [`flag::SKINNED`], as the next SkinnedMesh slot.
    pub fn push_mesh(&mut self, node: u32, bind_matrix: &Mat4, bind_matrix_inverse: &Mat4) -> u32 {
        assert!(!self.built, "mesh registered after build");
        let m = self.filled.meshes;
        assert!(
            m < self.mesh_nodes.len(),
            "more meshes than the graph was sized for"
        );
        let n = node as usize;
        assert!(n < self.filled.nodes, "mesh names unregistered node {node}");
        assert!(
            self.flags[n] & flag::SKINNED != 0,
            "mesh node {node} is not flagged skinned"
        );
        assert_eq!(
            self.mesh_of[n], NO_NODE,
            "node {node} registered twice as a mesh"
        );
        self.mesh_nodes[m] = node;
        self.mesh_of[n] = m as u32;
        put_mat4(&mut self.bind_matrix, m, bind_matrix);
        put_mat4(&mut self.bind_matrix_inverse, m, bind_matrix_inverse);
        self.filled.meshes += 1;
        m as u32
    }

    /// Opens the next skeleton; bones pushed after it belong to it.
    pub fn push_skeleton(&mut self) -> u32 {
        assert!(!self.built, "skeleton registered after build");
        let s = self.filled.skeletons;
        assert!(
            s + 1 < self.skeleton_offsets.len(),
            "more skeletons than the graph was sized for"
        );
        self.skeleton_offsets[s] = self.filled.bones as u32;
        self.filled.skeletons += 1;
        s as u32
    }

    /// Appends a bone slot to the open skeleton: its node (or [`NO_NODE`]) and `boneInverses[i]`.
    pub fn push_bone(&mut self, node: u32, bone_inverse: &Mat4) -> u32 {
        assert!(!self.built, "bone registered after build");
        assert!(
            self.filled.skeletons > 0,
            "bone registered before any skeleton"
        );
        let b = self.filled.bones;
        assert!(
            b < self.bone_nodes.len(),
            "more bones than the graph was sized for"
        );
        assert!(
            node == NO_NODE || (node as usize) < self.filled.nodes,
            "bone names unregistered node {node}"
        );
        self.bone_nodes[b] = node;
        put_mat4(&mut self.bone_inverses, b, bone_inverse);
        self.filled.bones += 1;
        (b - self.skeleton_offsets[self.filled.skeletons - 1] as usize) as u32
    }

    /// Closes construction once everything the graph was sized for is registered.
    pub fn build(&mut self) {
        assert!(!self.built, "graph built twice");
        assert_eq!(self.filled.nodes, self.len(), "nodes left unregistered");
        assert_eq!(
            self.filled.meshes,
            self.mesh_nodes.len(),
            "meshes left unregistered"
        );
        assert_eq!(
            self.filled.skeletons + 1,
            self.skeleton_offsets.len(),
            "skeletons left unregistered"
        );
        assert_eq!(
            self.filled.bones,
            self.bone_nodes.len(),
            "bones left unregistered"
        );
        for (i, &f) in self.flags.iter().enumerate() {
            assert!(
                f & flag::SKINNED == 0 || self.mesh_of[i] != NO_NODE,
                "skinned node {i} has no mesh slot"
            );
        }
        self.skeleton_offsets[self.filled.skeletons] = self.filled.bones as u32;

        let n = self.len();
        for &p in self.parent.iter().skip(1) {
            self.child_offsets[p as usize + 1] += 1;
        }
        for i in 0..n {
            self.child_offsets[i + 1] += self.child_offsets[i];
        }
        let mut next: Vec<u32> = self.child_offsets[..n].to_vec();
        for j in 1..n {
            let p = self.parent[j] as usize;
            self.children[next[p] as usize] = j as u32;
            next[p] += 1;
        }
        self.built = true;
    }

    /// Sets or clears [`flag::PLAIN_CHILDREN`] on node `i`.
    pub fn set_plain_children(&mut self, i: u32, on: bool) {
        let n = i as usize;
        let has = self.flags[n] & flag::PLAIN_CHILDREN != 0;
        if on && !has {
            self.flags[n] |= flag::PLAIN_CHILDREN;
            self.plain.push(i);
        } else if !on && has {
            self.flags[n] &= !flag::PLAIN_CHILDREN;
            let k = self.plain.iter().position(|&p| p == i).unwrap();
            self.plain.swap_remove(k);
            self.force[n] = force::UNVISITED;
        }
    }

    /// Sets how many ancestor levels above the root the mirror holds.
    pub fn set_ancestors(&mut self, count: usize) {
        assert!(
            count <= MAX_ANCESTORS,
            "{count} ancestors exceed {MAX_ANCESTORS}"
        );
        self.ancestor_count = count;
    }

    pub fn ancestor_count(&self) -> usize {
        self.ancestor_count
    }

    // three r186 Object3D.updateMatrix
    pub fn update_matrix(&mut self, i: u32) {
        self.assert_built();
        let n = i as usize;
        let position = Vec3::new(
            self.position[3 * n],
            self.position[3 * n + 1],
            self.position[3 * n + 2],
        );
        let quaternion = Quat::new(
            self.quaternion[4 * n],
            self.quaternion[4 * n + 1],
            self.quaternion[4 * n + 2],
            self.quaternion[4 * n + 3],
        );
        let scale = Vec3::new(
            self.scale[3 * n],
            self.scale[3 * n + 1],
            self.scale[3 * n + 2],
        );
        let pivot = (self.flags[n] & flag::PIVOT != 0).then(|| {
            Vec3::new(
                self.pivot[3 * n],
                self.pivot[3 * n + 1],
                self.pivot[3 * n + 2],
            )
        });
        let mut matrix = mat4(&self.matrix, n);
        object3d::update_matrix(&mut matrix, &position, &quaternion, &scale, pivot.as_ref());
        put_mat4(&mut self.matrix, n, &matrix);
        self.flags[n] |= flag::MATRIX_WORLD_NEEDS_UPDATE;
    }

    // three r186 Object3D.updateMatrixWorld, with SkinnedMesh.updateMatrixWorld on skinned nodes
    pub fn update_matrix_world(&mut self, i: u32, force: bool) {
        self.assert_built();
        self.begin_pass();
        self.update_matrix_world_node(i, force);
    }

    // three r186 Object3D.updateWorldMatrix
    pub fn update_world_matrix(
        &mut self,
        i: u32,
        update_parents: bool,
        update_children: bool,
        force: bool,
    ) {
        self.assert_built();
        self.begin_pass();
        self.update_world_matrix_node(i, update_parents, update_children, force);
    }

    // three r186 Skeleton.update
    pub fn skeleton_update(&mut self, s: u32) {
        self.assert_built();
        let s = s as usize;
        let identity = Mat4::default();
        let mut offset = Mat4::default();
        for b in self.skeleton_offsets[s] as usize..self.skeleton_offsets[s + 1] as usize {
            let node = self.bone_nodes[b];
            let matrix = if node == NO_NODE {
                identity
            } else {
                mat4(&self.matrix_world, node as usize)
            };
            offset.multiply_matrices(&matrix, &mat4(&self.bone_inverses, b));
            for (out, &e) in self.bone_matrices[16 * b..16 * b + 16]
                .iter_mut()
                .zip(&offset.elements)
            {
                *out = e as f32;
            }
        }
    }

    /// The node's `matrixWorld` as it stands, without updating it.
    pub fn current_matrix_world(&self, i: u32) -> Mat4 {
        mat4(&self.matrix_world, i as usize)
    }

    /// The node's `matrix` as it stands, without updating it.
    pub fn local_matrix(&self, i: u32) -> Mat4 {
        mat4(&self.matrix, i as usize)
    }

    // three r186 Object3D.getWorldPosition
    pub fn world_position(&mut self, i: u32) -> Vec3 {
        self.update_world_matrix(i, true, false, false);
        let mut out = Vec3::default();
        out.set_from_matrix_position(&self.current_matrix_world(i));
        out
    }

    // three r186 Object3D.getWorldQuaternion
    pub fn world_quaternion(&mut self, i: u32) -> Quat {
        self.update_world_matrix(i, true, false, false);
        let mut position = Vec3::default();
        let mut out = Quat::default();
        let mut scale = Vec3::default();
        self.current_matrix_world(i)
            .decompose(&mut position, &mut out, &mut scale);
        out
    }

    // three r186 Object3D.getWorldScale
    pub fn world_scale(&mut self, i: u32) -> Vec3 {
        self.update_world_matrix(i, true, false, false);
        let mut position = Vec3::default();
        let mut quaternion = Quat::default();
        let mut out = Vec3::default();
        self.current_matrix_world(i)
            .decompose(&mut position, &mut quaternion, &mut out);
        out
    }

    /// The node's parent, or none for the root.
    pub fn parent_of(&self, i: u32) -> Option<u32> {
        let p = self.parent[i as usize];
        (p != NO_NODE).then_some(p)
    }

    /// The node's parent as three's `parent` is: a table node, or for the root the mirror's
    /// first ancestor level; none only for a root the mirror holds no level above.
    pub fn three_parent_of(&self, i: u32) -> Option<Parent> {
        match self.parent_of(i) {
            Some(p) => Some(Parent::Node(p)),
            None => (i == 0 && self.ancestor_count > 0).then_some(Parent::Ancestor(0)),
        }
    }

    // three r186 Object3D.updateWorldMatrix(true, false) on a parent
    pub fn update_parent_world(&mut self, parent: Parent) {
        match parent {
            Parent::Node(i) => self.update_world_matrix(i, true, false, false),
            Parent::Ancestor(k) => {
                self.assert_built();
                self.begin_pass();
                self.update_ancestor(k);
            }
        }
    }

    /// A parent's `matrixWorld` as it stands, without updating it.
    pub fn current_parent_world(&self, parent: Parent) -> Mat4 {
        match parent {
            Parent::Node(i) => self.current_matrix_world(i),
            Parent::Ancestor(k) => self.ancestor_world(k),
        }
    }

    // three r186 Object3D.getWorldQuaternion on a parent
    pub fn parent_world_quaternion(&mut self, parent: Parent) -> Quat {
        self.update_parent_world(parent);
        let mut position = Vec3::default();
        let mut out = Quat::default();
        let mut scale = Vec3::default();
        self.current_parent_world(parent)
            .decompose(&mut position, &mut out, &mut scale);
        out
    }

    /// The node's local `position`.
    pub fn local_position(&self, i: u32) -> Vec3 {
        let n = 3 * i as usize;
        Vec3::new(self.position[n], self.position[n + 1], self.position[n + 2])
    }

    pub fn set_local_position(&mut self, i: u32, v: &Vec3) {
        let n = 3 * i as usize;
        self.position[n..n + 3].copy_from_slice(&[v.x, v.y, v.z]);
    }

    /// The node's local `quaternion`.
    pub fn local_quaternion(&self, i: u32) -> Quat {
        let n = 4 * i as usize;
        let q = &self.quaternion[n..n + 4];
        Quat::new(q[0], q[1], q[2], q[3])
    }

    pub fn set_local_quaternion(&mut self, i: u32, q: &Quat) {
        let n = 4 * i as usize;
        self.quaternion[n..n + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
    }

    /// The node's local `scale`.
    pub fn local_scale(&self, i: u32) -> Vec3 {
        let n = 3 * i as usize;
        Vec3::new(self.scale[n], self.scale[n + 1], self.scale[n + 2])
    }

    pub fn set_local_scale(&mut self, i: u32, v: &Vec3) {
        let n = 3 * i as usize;
        self.scale[n..n + 3].copy_from_slice(&[v.x, v.y, v.z]);
    }

    fn assert_built(&self) {
        assert!(self.built, "graph used before build");
    }

    /// Clears the force byte of every node with plain children.
    fn begin_pass(&mut self) {
        for &p in &self.plain {
            self.force[p as usize] = force::UNVISITED;
        }
    }

    fn update_matrix_world_node(&mut self, i: u32, force: bool) {
        let force = self.update_self(i, force);
        self.note_force(i, force);
        let n = i as usize;
        for k in self.child_offsets[n]..self.child_offsets[n + 1] {
            let child = self.children[k as usize];
            self.update_matrix_world_node(child, force);
        }
        if self.flags[n] & flag::SKINNED != 0 {
            self.update_bind_matrix_inverse(n);
        }
    }

    fn update_world_matrix_node(
        &mut self,
        i: u32,
        update_parents: bool,
        update_children: bool,
        force: bool,
    ) {
        let n = i as usize;
        if update_parents {
            let parent = self.parent[n];
            if parent != NO_NODE {
                self.update_world_matrix_node(parent, true, false, false);
            } else if self.ancestor_count > 0 {
                self.update_ancestor(0);
            }
        }
        let force = self.update_self(i, force);
        if update_children {
            self.note_force(i, force);
            for k in self.child_offsets[n]..self.child_offsets[n + 1] {
                let child = self.children[k as usize];
                self.update_world_matrix_node(child, false, true, force);
            }
        }
    }

    fn note_force(&mut self, i: u32, force: bool) {
        let n = i as usize;
        if self.flags[n] & flag::PLAIN_CHILDREN != 0 {
            self.force[n] = if force { force::TRUE } else { force::FALSE };
        }
    }

    /// The node's own step of `updateMatrixWorld` and `updateWorldMatrix`; returns the force its
    /// children receive.
    fn update_self(&mut self, i: u32, mut force: bool) -> bool {
        let n = i as usize;
        if self.flags[n] & flag::MATRIX_AUTO_UPDATE != 0 {
            self.update_matrix(i);
        }
        if self.flags[n] & flag::MATRIX_WORLD_NEEDS_UPDATE != 0 || force {
            if self.flags[n] & flag::MATRIX_WORLD_AUTO_UPDATE != 0 {
                let matrix = mat4(&self.matrix, n);
                let parent = self.parent[n];
                let mut world = mat4(&self.matrix_world, n);
                if parent != NO_NODE {
                    world.multiply_matrices(&mat4(&self.matrix_world, parent as usize), &matrix);
                } else if self.ancestor_count > 0 {
                    world.multiply_matrices(&self.ancestor_world(0), &matrix);
                } else {
                    world.copy(&matrix);
                }
                put_mat4(&mut self.matrix_world, n, &world);
            }
            self.flags[n] &= !flag::MATRIX_WORLD_NEEDS_UPDATE;
            force = true;
        }
        force
    }

    // three r186 SkinnedMesh.updateMatrixWorld, the part after super.updateMatrixWorld
    fn update_bind_matrix_inverse(&mut self, n: usize) {
        let m = self.mesh_of[n] as usize;
        let mut inverse = if self.flags[n] & flag::DETACHED != 0 {
            mat4(&self.bind_matrix, m)
        } else {
            mat4(&self.matrix_world, n)
        };
        inverse.invert();
        put_mat4(&mut self.bind_matrix_inverse, m, &inverse);
    }

    fn ancestor_world(&self, k: usize) -> Mat4 {
        record_mat4(&self.ancestors[RECORD * k..], R_MATRIX_WORLD)
    }

    // three r186 Object3D.updateWorldMatrix(true, false) on ancestor level `k`
    fn update_ancestor(&mut self, k: usize) {
        if k + 1 < self.ancestor_count {
            self.update_ancestor(k + 1);
        }
        let flags = self.ancestor_flags[k];
        let r = &mut self.ancestors[RECORD * k..RECORD * (k + 1)];
        if flags & flag::MATRIX_AUTO_UPDATE != 0 {
            let position = Vec3::new(r[R_POSITION], r[R_POSITION + 1], r[R_POSITION + 2]);
            let quaternion = Quat::new(
                r[R_QUATERNION],
                r[R_QUATERNION + 1],
                r[R_QUATERNION + 2],
                r[R_QUATERNION + 3],
            );
            let scale = Vec3::new(r[R_SCALE], r[R_SCALE + 1], r[R_SCALE + 2]);
            let pivot = (flags & flag::PIVOT != 0)
                .then(|| Vec3::new(r[R_PIVOT], r[R_PIVOT + 1], r[R_PIVOT + 2]));
            let mut matrix = record_mat4(r, R_MATRIX);
            object3d::update_matrix(&mut matrix, &position, &quaternion, &scale, pivot.as_ref());
            r[R_MATRIX..R_MATRIX + 16].copy_from_slice(&matrix.elements);
            self.ancestor_flags[k] |= flag::MATRIX_WORLD_NEEDS_UPDATE;
        }
        if self.ancestor_flags[k] & flag::MATRIX_WORLD_NEEDS_UPDATE != 0 {
            if flags & flag::MATRIX_WORLD_AUTO_UPDATE != 0 {
                let parent = (k + 1 < self.ancestor_count).then(|| self.ancestor_world(k + 1));
                let r = &mut self.ancestors[RECORD * k..RECORD * (k + 1)];
                let matrix = record_mat4(r, R_MATRIX);
                let mut world = record_mat4(r, R_MATRIX_WORLD);
                match parent {
                    Some(parent) => world.multiply_matrices(&parent, &matrix),
                    None => world.copy(&matrix),
                };
                r[R_MATRIX_WORLD..R_MATRIX_WORLD + 16].copy_from_slice(&world.elements);
            }
            self.ancestor_flags[k] &= !flag::MATRIX_WORLD_NEEDS_UPDATE;
        }
    }
}

/// Bits of a handle holding the slot; the rest hold the slot's generation.
const SLOT_BITS: u32 = 16;
const SLOT_MASK: u32 = (1 << SLOT_BITS) - 1;
const MAX_GENERATION: u32 = u32::MAX >> SLOT_BITS;

#[derive(Debug)]
struct Slot<T> {
    generation: u32,
    value: Option<Box<T>>,
    dependents: u32,
}

/// Live graphs by handle, and the count of handles that depend on each.
///
/// A handle is the slot number in the low 16 bits and the slot's generation (never 0) above
/// them, so 0 is never a handle. Freeing advances the generation, which is how a dependent freed
/// after its graph learns that the graph is gone. The value is boxed so its address survives the
/// slot table growing.
#[derive(Debug)]
pub struct Registry<T> {
    slots: Vec<Slot<T>>,
}

impl<T> Default for Registry<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Registry<T> {
    pub const fn new() -> Self {
        Self { slots: Vec::new() }
    }

    /// Stores `value` in a free slot and returns its handle.
    pub fn insert(&mut self, value: T) -> u32 {
        let slot = match self.slots.iter().position(|s| s.value.is_none()) {
            Some(slot) => slot,
            None => {
                assert!(
                    self.slots.len() <= SLOT_MASK as usize,
                    "too many live graphs"
                );
                self.slots.push(Slot {
                    generation: 1,
                    value: None,
                    dependents: 0,
                });
                self.slots.len() - 1
            }
        };
        let s = &mut self.slots[slot];
        s.value = Some(Box::new(value));
        s.dependents = 0;
        (s.generation << SLOT_BITS) | slot as u32
    }

    /// The live slot behind `handle`, or `None` once it has been freed.
    fn live(&mut self, handle: u32) -> Option<&mut Slot<T>> {
        let slot = self.slots.get_mut((handle & SLOT_MASK) as usize)?;
        (slot.generation == handle >> SLOT_BITS && slot.value.is_some()).then_some(slot)
    }

    fn slot(&mut self, handle: u32) -> &mut Slot<T> {
        self.live(handle)
            .unwrap_or_else(|| panic!("graph handle {handle:#x} is not live"))
    }

    pub fn get(&mut self, handle: u32) -> &mut T {
        self.slot(handle).value.as_deref_mut().unwrap()
    }

    /// Frees the graph; a dependent still registered is a caller bug.
    pub fn free(&mut self, handle: u32) {
        let dependents = self.slot(handle).dependents;
        assert!(
            dependents == 0,
            "graph {handle:#x} freed with {dependents} dependents"
        );
        self.free_orphan(handle);
    }

    /// Frees the graph whatever still depends on it, for a finaliser that runs in no fixed order.
    pub fn free_orphan(&mut self, handle: u32) {
        let s = self.slot(handle);
        s.value = None;
        s.dependents = 0;
        s.generation = if s.generation == MAX_GENERATION {
            1
        } else {
            s.generation + 1
        };
    }

    /// Registers a dependent of the live graph `handle`; the dependent keeps `handle`.
    pub fn retain(&mut self, handle: u32) {
        self.slot(handle).dependents += 1;
    }

    /// Unregisters a dependent created with `handle`. Once that graph is gone this does nothing,
    /// so a dependent can be freed after its graph.
    pub fn release(&mut self, handle: u32) {
        if let Some(s) = self.live(handle) {
            assert!(
                s.dependents > 0,
                "graph {handle:#x} has no dependent to release"
            );
            s.dependents -= 1;
        }
    }

    /// Dependents registered on the live graph `handle`.
    pub fn dependents(&mut self, handle: u32) -> u32 {
        self.slot(handle).dependents
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUTO: u8 = flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE;

    fn translation(x: f64, y: f64, z: f64) -> Mat4 {
        let mut m = Mat4::default();
        m.make_translation(x, y, z);
        m
    }

    /// A record at `position` with the identity rotation, unit scale and the given matrices.
    fn record(position: [f64; 3], matrix: &Mat4, world: &Mat4) -> [f64; RECORD] {
        let mut r = [0.0; RECORD];
        r[R_POSITION..R_POSITION + 3].copy_from_slice(&position);
        r[R_QUATERNION + 3] = 1.0;
        r[R_SCALE..R_SCALE + 3].copy_from_slice(&[1.0, 1.0, 1.0]);
        r[R_MATRIX..R_MATRIX + 16].copy_from_slice(&matrix.elements);
        r[R_MATRIX_WORLD..R_MATRIX_WORLD + 16].copy_from_slice(&world.elements);
        r
    }

    fn sentinel(k: f64) -> Mat4 {
        translation(100.0 * k, -7.0 * k, 3.0 * k)
    }

    /// A graph of `parents.len()` nodes at `position (i + 1, 0, 0)`, each matrix and world the
    /// sentinel of its index, built with the given flags.
    fn graph(parents: &[u32], flags: &[u8]) -> Graph {
        let mut g = Graph::new(Shape {
            nodes: parents.len(),
            ..Shape::default()
        });
        for (i, (&p, &f)) in parents.iter().zip(flags).enumerate() {
            let s = sentinel(i as f64 + 1.0);
            g.push_node(p, f, &record([i as f64 + 1.0, 0.0, 0.0], &s, &s));
        }
        g.build();
        g
    }

    fn world(g: &Graph, i: usize) -> Mat4 {
        mat4(&g.matrix_world, i)
    }

    fn local(g: &Graph, i: usize) -> Mat4 {
        mat4(&g.matrix, i)
    }

    fn product(a: &Mat4, b: &Mat4) -> Mat4 {
        let mut m = Mat4::default();
        m.multiply_matrices(a, b);
        m
    }

    fn needs_update(g: &Graph, i: usize) -> bool {
        g.flags[i] & flag::MATRIX_WORLD_NEEDS_UPDATE != 0
    }

    fn bits(m: &Mat4) -> [u64; 16] {
        m.elements.map(f64::to_bits)
    }

    fn set_ancestor(g: &mut Graph, k: usize, position: [f64; 3], world: &Mat4, flags: u8) {
        let r = record(position, &sentinel(50.0 + k as f64), world);
        g.ancestors[RECORD * k..RECORD * (k + 1)].copy_from_slice(&r);
        g.ancestor_flags[k] = flags;
    }

    #[test]
    fn children_follow_traverse_order() {
        // 0 ─ 1 ─ 2
        //  │   └ 3
        //  └ 4
        let g = graph(&[NO_NODE, 0, 1, 1, 0], &[AUTO; 5]);
        assert_eq!(g.child_offsets, [0, 2, 4, 4, 4, 4]);
        assert_eq!(g.children, [1, 4, 2, 3]);
    }

    #[test]
    #[should_panic(expected = "out of traverse order")]
    fn a_parent_off_the_current_path_traps() {
        graph(&[NO_NODE, 0, 1, 0, 2], &[AUTO; 5]);
    }

    #[test]
    fn update_matrix_world_forces_below_an_updated_node() {
        // three: the root composes, so it and every descendant are recomputed with force = true,
        // including a child whose matrix is frozen and whose world was not dirty.
        let frozen = flag::MATRIX_WORLD_AUTO_UPDATE;
        let mut g = graph(&[NO_NODE, 0, 1, 0], &[AUTO, frozen, AUTO, frozen]);
        g.update_matrix_world(0, false);
        let root = translation(1.0, 0.0, 0.0);
        assert_eq!(local(&g, 0), root);
        assert_eq!(world(&g, 0), root);
        assert_eq!(local(&g, 1), sentinel(2.0));
        let w1 = product(&root, &sentinel(2.0));
        assert_eq!(world(&g, 1), w1);
        assert_eq!(world(&g, 2), product(&w1, &translation(3.0, 0.0, 0.0)));
        assert_eq!(world(&g, 3), product(&root, &sentinel(4.0)));
        assert!((0..4).all(|i| !needs_update(&g, i)));
    }

    #[test]
    fn update_matrix_world_without_force_reads_a_stale_parent() {
        // three: neither the root nor node 1 is dirty, so both keep their world matrices and node
        // 2, which composes, multiplies node 1's stale world.
        let frozen = flag::MATRIX_WORLD_AUTO_UPDATE;
        let mut g = graph(&[NO_NODE, 0, 1], &[frozen, frozen, AUTO]);
        g.update_matrix_world(0, false);
        assert_eq!(world(&g, 0), sentinel(1.0));
        assert_eq!(world(&g, 1), sentinel(2.0));
        assert_eq!(
            world(&g, 2),
            product(&sentinel(2.0), &translation(3.0, 0.0, 0.0))
        );

        g.update_matrix_world(0, true);
        assert_eq!(world(&g, 0), sentinel(1.0));
        assert_eq!(world(&g, 1), product(&sentinel(1.0), &sentinel(2.0)));
    }

    #[test]
    fn a_dirty_frozen_node_recomputes_and_forces_its_children() {
        let frozen = flag::MATRIX_WORLD_AUTO_UPDATE;
        let dirty = frozen | flag::MATRIX_WORLD_NEEDS_UPDATE;
        let mut g = graph(&[NO_NODE, 0, 1], &[frozen, dirty, frozen]);
        g.update_matrix_world(0, false);
        let w1 = product(&sentinel(1.0), &sentinel(2.0));
        assert_eq!(world(&g, 1), w1);
        assert_eq!(world(&g, 2), product(&w1, &sentinel(3.0)));
        assert!(!needs_update(&g, 1));
    }

    #[test]
    fn matrix_world_auto_update_off_keeps_the_world_but_clears_the_flag() {
        // three: the node composes and clears matrixWorldNeedsUpdate without writing its world,
        // and still hands force = true on, so its child multiplies the untouched world.
        let mut g = graph(&[NO_NODE, 0, 1], &[AUTO, flag::MATRIX_AUTO_UPDATE, AUTO]);
        g.update_matrix_world(0, false);
        assert_eq!(local(&g, 1), translation(2.0, 0.0, 0.0));
        assert_eq!(world(&g, 1), sentinel(2.0));
        assert!(!needs_update(&g, 1));
        assert_eq!(
            world(&g, 2),
            product(&sentinel(2.0), &translation(3.0, 0.0, 0.0))
        );
    }

    #[test]
    fn update_matrix_applies_the_pivot_and_marks_the_world_dirty() {
        let mut g = graph(&[NO_NODE], &[0]);
        let h = std::f64::consts::FRAC_1_SQRT_2;
        g.quaternion[..4].copy_from_slice(&[0.0, 0.0, h, h]);
        g.position[..3].copy_from_slice(&[0.0, 0.0, 0.0]);
        g.update_matrix(0);
        let unpivoted = local(&g, 0);
        assert!(needs_update(&g, 0));

        // A quarter turn about z around (1, 0, 0) moves the origin to (1, -1, 0).
        g.pivot[..3].copy_from_slice(&[1.0, 0.0, 0.0]);
        g.update_matrix(0);
        assert_eq!(local(&g, 0), unpivoted, "pivot is ignored without the flag");
        g.flags[0] |= flag::PIVOT;
        g.update_matrix(0);
        let m = local(&g, 0);
        assert!((m.elements[12] - 1.0).abs() < 1e-15);
        assert!((m.elements[13] + 1.0).abs() < 1e-15);
        assert_eq!(m.elements[14], 0.0);
        assert_eq!(m.elements[..12], unpivoted.elements[..12]);
    }

    /// A lone root whose frozen dirty matrix holds -0 at the x translation and +Inf at m11.
    fn signed_root() -> Graph {
        let mut m = Mat4::default();
        m.elements[12] = -0.0;
        m.elements[0] = f64::INFINITY;
        let mut g = Graph::new(Shape {
            nodes: 1,
            ..Shape::default()
        });
        let flags = flag::MATRIX_WORLD_AUTO_UPDATE | flag::MATRIX_WORLD_NEEDS_UPDATE;
        g.push_node(NO_NODE, flags, &record([0.0; 3], &m, &Mat4::default()));
        g.build();
        g
    }

    #[test]
    fn a_parentless_root_copies_its_matrix() {
        let mut g = signed_root();
        g.update_matrix_world(0, false);
        assert_eq!(bits(&world(&g, 0)), bits(&local(&g, 0)));
        assert!(world(&g, 0).elements[12].is_sign_negative());
        assert_eq!(world(&g, 0).elements[1], 0.0);
    }

    #[test]
    fn a_root_under_an_ancestor_multiplies_even_by_the_identity() {
        // three's multiply branch: 1 * -0 + 0 * 0 + … is +0, and 0 * Inf is NaN.
        let mut g = signed_root();
        set_ancestor(&mut g, 0, [0.0; 3], &Mat4::default(), AUTO);
        g.set_ancestors(1);
        g.update_matrix_world(0, false);
        let w = world(&g, 0);
        assert_eq!(w.elements[12].to_bits(), 0);
        assert_eq!(w.elements[0], f64::INFINITY);
        assert!(w.elements[1].is_nan());
    }

    #[test]
    fn update_matrix_world_reads_the_nearest_ancestor_and_leaves_the_chain_stale() {
        let mut g = graph(&[NO_NODE, 0], &[AUTO, AUTO]);
        set_ancestor(&mut g, 0, [9.0, 0.0, 0.0], &sentinel(20.0), AUTO);
        set_ancestor(&mut g, 1, [8.0, 0.0, 0.0], &sentinel(21.0), AUTO);
        g.set_ancestors(2);
        let before = g.ancestors.clone();
        g.update_matrix_world(0, false);
        assert_eq!(
            world(&g, 0),
            product(&sentinel(20.0), &translation(1.0, 0.0, 0.0))
        );
        assert_eq!(g.ancestors, before);
        assert_eq!(g.ancestor_flags[..2], [AUTO, AUTO]);
    }

    #[test]
    fn update_world_matrix_climbs_into_the_ancestors() {
        // three: updateWorldMatrix(true, false) on node 1 updates the top ancestor (parentless,
        // copy), then the root's parent, then the root, then node 1; node 2 is not visited.
        let mut g = graph(&[NO_NODE, 0, 1], &[AUTO; 3]);
        let dirty_frozen = flag::MATRIX_WORLD_AUTO_UPDATE | flag::MATRIX_WORLD_NEEDS_UPDATE;
        set_ancestor(&mut g, 0, [5.0, 0.0, 0.0], &sentinel(20.0), AUTO);
        set_ancestor(&mut g, 1, [6.0, 0.0, 0.0], &sentinel(21.0), dirty_frozen);
        g.set_ancestors(2);
        g.update_world_matrix(1, true, false, false);

        let top_matrix = sentinel(51.0);
        let top = &g.ancestors[RECORD..2 * RECORD];
        assert_eq!(
            record_mat4(top, R_MATRIX),
            top_matrix,
            "frozen top keeps its matrix"
        );
        assert_eq!(
            record_mat4(top, R_MATRIX_WORLD),
            top_matrix,
            "parentless top copies"
        );
        let a0 = &g.ancestors[..RECORD];
        let a0_matrix = translation(5.0, 0.0, 0.0);
        assert_eq!(record_mat4(a0, R_MATRIX), a0_matrix);
        let a0_world = product(&top_matrix, &a0_matrix);
        assert_eq!(record_mat4(a0, R_MATRIX_WORLD), a0_world);
        assert_eq!(
            g.ancestor_flags[..2],
            [AUTO, flag::MATRIX_WORLD_AUTO_UPDATE]
        );

        let w0 = product(&a0_world, &translation(1.0, 0.0, 0.0));
        assert_eq!(world(&g, 0), w0);
        assert_eq!(world(&g, 1), product(&w0, &translation(2.0, 0.0, 0.0)));
        assert_eq!(world(&g, 2), sentinel(3.0));
    }

    #[test]
    fn a_clean_frozen_ancestor_is_not_recomputed_on_the_climb() {
        let mut g = graph(&[NO_NODE], &[AUTO]);
        set_ancestor(
            &mut g,
            0,
            [5.0, 0.0, 0.0],
            &sentinel(20.0),
            flag::MATRIX_WORLD_AUTO_UPDATE,
        );
        g.set_ancestors(1);
        g.update_world_matrix(0, true, false, false);
        assert_eq!(record_mat4(&g.ancestors, R_MATRIX_WORLD), sentinel(20.0));
        assert_eq!(
            world(&g, 0),
            product(&sentinel(20.0), &translation(1.0, 0.0, 0.0))
        );
    }

    #[test]
    fn update_world_matrix_reaches_children_only_when_asked() {
        let frozen = flag::MATRIX_WORLD_AUTO_UPDATE;
        let mut g = graph(&[NO_NODE, 0, 1], &[frozen, frozen, frozen]);
        g.update_world_matrix(0, false, false, true);
        assert_eq!(world(&g, 1), sentinel(2.0));

        // force reaches the grandchild through a clean frozen child.
        g.update_world_matrix(0, false, true, true);
        let w1 = product(&sentinel(1.0), &sentinel(2.0));
        assert_eq!(world(&g, 1), w1);
        assert_eq!(world(&g, 2), product(&w1, &sentinel(3.0)));
    }

    /// Root → attached mesh → child, and a detached mesh under the root.
    fn skinned() -> Graph {
        let mesh = AUTO | flag::SKINNED;
        let mut g = Graph::new(Shape {
            nodes: 4,
            meshes: 2,
            ..Shape::default()
        });
        for (i, (p, f)) in [
            (NO_NODE, AUTO),
            (0, mesh),
            (1, AUTO),
            (0, mesh | flag::DETACHED),
        ]
        .into_iter()
        .enumerate()
        {
            let s = sentinel(i as f64 + 1.0);
            g.push_node(p, f, &record([i as f64 + 1.0, 2.0, 0.0], &s, &s));
        }
        g.push_mesh(1, &sentinel(30.0), &sentinel(31.0));
        g.push_mesh(3, &translation(0.0, 4.0, 0.0), &sentinel(33.0));
        g.build();
        g
    }

    fn bind_inverse(g: &Graph, m: usize) -> Mat4 {
        mat4(&g.bind_matrix_inverse, m)
    }

    fn inverse(m: &Mat4) -> Mat4 {
        let mut m = *m;
        m.invert();
        m
    }

    #[test]
    fn bind_matrix_inverse_is_left_alone_off_the_update_matrix_world_path() {
        let mut g = skinned();
        g.update_matrix(1);
        g.update_world_matrix(2, true, false, false);
        g.update_world_matrix(0, false, true, true);
        assert_eq!(bind_inverse(&g, 0), sentinel(31.0));
        assert_eq!(bind_inverse(&g, 1), sentinel(33.0));
    }

    #[test]
    fn update_matrix_world_rebuilds_bind_matrix_inverse_by_bind_mode() {
        let mut g = skinned();
        g.update_matrix_world(0, false);
        assert_eq!(bind_inverse(&g, 0), inverse(&world(&g, 1)));
        assert_eq!(bind_inverse(&g, 1), inverse(&translation(0.0, 4.0, 0.0)));

        // Entered at the mesh itself, the override still runs.
        let mut g = skinned();
        g.update_matrix_world(1, false);
        assert_eq!(bind_inverse(&g, 0), inverse(&world(&g, 1)));
        assert_eq!(bind_inverse(&g, 1), sentinel(33.0));
    }

    #[test]
    fn skeleton_update_rounds_to_f32_and_multiplies_missing_bones_by_the_identity() {
        let mut g = Graph::new(Shape {
            nodes: 1,
            skeletons: 2,
            bones: 2,
            ..Shape::default()
        });
        // 1 + 2^-24 and 1 + 3 * 2^-24 sit halfway between f32 neighbours and round to even.
        let mut w = translation(0.1, 1.0 + 2f64.powi(-24), 1.0 + 3.0 * 2f64.powi(-24));
        w.elements[0] = 2.0;
        g.push_node(NO_NODE, 0, &record([0.0; 3], &w, &w));
        let mut odd = Mat4::default();
        odd.elements[12] = -0.0;
        odd.elements[0] = f64::INFINITY;
        assert_eq!(g.push_skeleton(), 0);
        assert_eq!(g.push_bone(0, &Mat4::default()), 0);
        assert_eq!(g.push_bone(NO_NODE, &odd), 1);
        assert_eq!(g.push_skeleton(), 1);
        g.build();
        g.skeleton_update(1);
        g.skeleton_update(0);

        let b0 = &g.bone_matrices[..16];
        assert_eq!(b0[0], 2.0);
        assert_eq!(b0[12].to_bits(), 0.1f32.to_bits());
        assert_eq!(b0[13], 1.0);
        assert_eq!(b0[14], 1.0 + 2f32.powi(-22));

        // identity × boneInverse, not boneInverse itself: -0 becomes +0 and 0 * Inf is NaN.
        let b1 = &g.bone_matrices[16..];
        assert_eq!(b1[12].to_bits(), 0);
        assert_eq!(b1[0], f32::INFINITY);
        assert!(b1[1].is_nan());
        assert_eq!(b1[5], 1.0);
    }

    #[test]
    fn the_force_byte_records_what_each_pass_handed_plain_children() {
        let frozen = flag::MATRIX_WORLD_AUTO_UPDATE;
        let mut g = graph(&[NO_NODE, 0, 1, 0], &[frozen, frozen, AUTO, frozen]);
        for i in [0, 1, 2] {
            g.set_plain_children(i, true);
        }
        g.update_matrix_world(0, false);
        assert_eq!(
            g.force,
            [force::FALSE, force::FALSE, force::TRUE, force::UNVISITED]
        );

        // A climb iterates no children, and the pass starts by clearing every byte.
        g.update_world_matrix(2, true, false, false);
        assert_eq!(g.force, [force::UNVISITED; 4]);

        g.update_world_matrix(1, false, true, true);
        assert_eq!(
            g.force,
            [force::UNVISITED, force::TRUE, force::TRUE, force::UNVISITED]
        );

        g.set_plain_children(1, false);
        assert_eq!(g.flags[1] & flag::PLAIN_CHILDREN, 0);
        g.update_matrix_world(0, true);
        assert_eq!(
            g.force,
            [force::TRUE, force::UNVISITED, force::TRUE, force::UNVISITED]
        );
    }

    fn empty() -> Graph {
        let mut g = Graph::new(Shape::default());
        g.build();
        g
    }

    #[test]
    fn a_dependent_freed_after_its_graph_frees_silently() {
        let mut scenes = Registry::new();
        let h = scenes.insert(empty());
        assert_ne!(h, 0);
        scenes.retain(h);
        scenes.free_orphan(h);
        scenes.release(h);

        // The slot is reused under a new generation; the stale release leaves it alone.
        let h2 = scenes.insert(empty());
        assert_eq!(h2 & SLOT_MASK, h & SLOT_MASK);
        assert_ne!(h2, h);
        scenes.retain(h2);
        scenes.release(h);
        assert_eq!(scenes.dependents(h2), 1);
        scenes.release(h2);
        scenes.free(h2);
    }

    #[test]
    #[should_panic(expected = "freed with 1 dependents")]
    fn freeing_a_graph_with_live_dependents_traps() {
        let mut scenes = Registry::new();
        let h = scenes.insert(empty());
        scenes.retain(h);
        scenes.free(h);
    }

    #[test]
    #[should_panic(expected = "is not live")]
    fn a_freed_handle_is_not_live() {
        let mut scenes = Registry::new();
        let h = scenes.insert(empty());
        scenes.free(h);
        scenes.get(h);
    }
}
