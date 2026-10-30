//! The solver's view of the scene graph, read and written in place.
//!
//! Indices below `nodes()` are the table's. The root's ancestors follow, the root's parent at
//! `nodes()` and each one's parent at the next index, read from the mirror as the caller last
//! wrote it. Construction walks them; a path resolved through an ancestor keeps its index, since
//! the hierarchy is fixed once the graph exists and only the root's own parent may change. Writes
//! reach the table only.

use crate::math::{Mat4, Quat, Vec3};
use crate::scene::graph::{
    Graph, NO_NODE, R_MATRIX, R_MATRIX_WORLD, R_POSITION, R_QUATERNION, R_SCALE, RECORD, flag,
};

fn mat4(s: &[f64], at: usize) -> Mat4 {
    let mut elements = [0.0; 16];
    elements.copy_from_slice(&s[at..at + 16]);
    Mat4::from_elements(elements)
}

/// A graph borrowed for one solver call.
pub(crate) struct Tree<'g> {
    graph: &'g mut Graph,
}

impl<'g> Tree<'g> {
    pub fn new(graph: &'g mut Graph) -> Self {
        Self { graph }
    }

    /// Nodes of the table.
    pub fn nodes(&self) -> u32 {
        self.graph.len() as u32
    }

    /// Nodes of the table and the ancestors mirrored now.
    pub fn len(&self) -> usize {
        self.graph.len() + self.graph.ancestor_count()
    }

    /// The ancestor level of index `i`, if it is not a table node.
    fn level(&self, i: u32) -> Option<usize> {
        i.checked_sub(self.nodes()).map(|k| k as usize)
    }

    pub fn parent(&self, i: u32) -> Option<u32> {
        match self.level(i) {
            None => {
                let p = self.graph.parent[i as usize];
                if p != NO_NODE {
                    Some(p)
                } else {
                    (self.graph.ancestor_count() > 0).then(|| self.nodes())
                }
            }
            Some(k) => (k + 1 < self.graph.ancestor_count()).then_some(i + 1),
        }
    }

    /// Table children in three's `children` order.
    pub fn children(&self, i: u32) -> &[u32] {
        let n = i as usize;
        let offsets = &self.graph.child_offsets;
        &self.graph.children[offsets[n] as usize..offsets[n + 1] as usize]
    }

    /// Children that are bones, in order.
    pub fn bone_children(&self, i: u32) -> impl Iterator<Item = u32> + '_ {
        self.children(i)
            .iter()
            .copied()
            .filter(|&c| self.graph.flags[c as usize] & flag::BONE != 0)
    }

    fn flags(&self, i: u32) -> u8 {
        match self.level(i) {
            None => self.graph.flags[i as usize],
            Some(k) => self.graph.ancestor_flags[k],
        }
    }

    pub fn matrix_auto_update(&self, i: u32) -> bool {
        self.flags(i) & flag::MATRIX_AUTO_UPDATE != 0
    }

    pub fn matrix_world_auto_update(&self, i: u32) -> bool {
        self.flags(i) & flag::MATRIX_WORLD_AUTO_UPDATE != 0
    }

    pub fn has_pivot(&self, i: u32) -> bool {
        self.flags(i) & flag::PIVOT != 0
    }

    /// The node's slice of a per-node buffer of `stride`, or the field at `field` of its record.
    fn read<'a>(&'a self, i: u32, buffer: &'a [f64], stride: usize, field: usize) -> &'a [f64] {
        match self.level(i) {
            None => &buffer[stride * i as usize..],
            Some(k) => &self.graph.ancestors[RECORD * k + field..],
        }
    }

    pub fn position(&self, i: u32) -> Vec3 {
        let s = self.read(i, &self.graph.position, 3, R_POSITION);
        Vec3::new(s[0], s[1], s[2])
    }

    pub fn quaternion(&self, i: u32) -> Quat {
        let s = self.read(i, &self.graph.quaternion, 4, R_QUATERNION);
        Quat::new(s[0], s[1], s[2], s[3])
    }

    pub fn scale(&self, i: u32) -> Vec3 {
        let s = self.read(i, &self.graph.scale, 3, R_SCALE);
        Vec3::new(s[0], s[1], s[2])
    }

    pub fn matrix(&self, i: u32) -> Mat4 {
        mat4(self.read(i, &self.graph.matrix, 16, R_MATRIX), 0)
    }

    pub fn matrix_world(&self, i: u32) -> Mat4 {
        mat4(
            self.read(i, &self.graph.matrix_world, 16, R_MATRIX_WORLD),
            0,
        )
    }

    pub fn set_position(&mut self, i: u32, v: &Vec3) {
        let n = 3 * i as usize;
        self.graph.position[n..n + 3].copy_from_slice(&[v.x, v.y, v.z]);
    }

    pub fn set_quaternion(&mut self, i: u32, q: &Quat) {
        let n = 4 * i as usize;
        self.graph.quaternion[n..n + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
    }

    pub fn set_matrix_world(&mut self, i: u32, m: &Mat4) {
        let n = 16 * i as usize;
        self.graph.matrix_world[n..n + 16].copy_from_slice(&m.elements);
    }

    /// `node.matrixWorldNeedsUpdate = false`.
    pub fn clear_needs_update(&mut self, i: u32) {
        self.graph.flags[i as usize] &= !flag::MATRIX_WORLD_NEEDS_UPDATE;
    }

    // three r186 Object3D.updateMatrix
    pub fn update_matrix(&mut self, i: u32) {
        self.graph.update_matrix(i);
    }

    /// Origin of the node's world matrix.
    pub fn world_position(&self, i: u32) -> Vec3 {
        let mut out = Vec3::default();
        out.set_from_matrix_position(&self.matrix_world(i));
        out
    }

    /// World rotation of a node, with any scale on the hierarchy divided out.
    pub fn world_quat(&self, i: u32) -> Quat {
        let mut m = Mat4::default();
        m.extract_rotation(&self.matrix_world(i));
        let mut out = Quat::default();
        out.set_from_rotation_matrix(&m);
        out
    }

    /// `node.matrixWorld.multiplyMatrices(parent.matrixWorld, node.matrix)`.
    pub fn hang(&mut self, i: u32, parent: u32) {
        let mut world = Mat4::default();
        world.multiply_matrices(&self.matrix_world(parent), &self.matrix(i));
        self.set_matrix_world(i, &world);
    }

    // three r186 Object3D.updateWorldMatrix (updateParents = true, updateChildren = false)
    pub fn update_world_matrix_parents(&mut self, i: u32) {
        self.graph.update_world_matrix(i, true, false, false);
    }

    // three r186 Object3D.updateMatrixWorld(true), over a subset of the update root's subtree.
    //
    // `nodes` must be ascending table nodes and hold the parent of every entry but the first's, so
    // each world matrix is formed from a parent formed earlier in the same pass. Nodes left out are
    // not touched, and no SkinnedMesh's bindMatrixInverse is rebuilt.
    pub fn update_matrix_world_forced(&mut self, nodes: &[u32]) {
        for &i in nodes {
            if self.matrix_auto_update(i) {
                self.update_matrix(i);
            }
            if self.matrix_world_auto_update(i) {
                let matrix = self.matrix(i);
                let mut world = Mat4::default();
                match self.parent(i) {
                    Some(p) => world.multiply_matrices(&self.matrix_world(p), &matrix),
                    None => world.copy(&matrix),
                };
                self.set_matrix_world(i, &world);
            }
            self.clear_needs_update(i);
        }
    }
}
