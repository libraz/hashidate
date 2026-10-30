//! A node table standing in for a three.js hierarchy.
//!
//! Nodes are numbered in `traverse` order, so a parent always precedes its children and a
//! node's subtree is the contiguous run of indices after it. The table holds what the solvers
//! read and write; everything else about the hierarchy stays on the three side.

pub mod node;

pub use node::{NONE, Node};

use crate::math::{Mat4, Quat, Vec3};

/// Nodes in `traverse` order, with each node's children in child order.
#[derive(Clone, Debug, Default)]
pub struct Scene {
    nodes: Vec<Node>,
    children: Vec<Vec<u32>>,
}

impl Scene {
    /// Appends a node. Its parent must already be in the table.
    pub fn push(&mut self, node: Node) -> u32 {
        let index = self.nodes.len() as u32;
        if let Some(parent) = node.parent() {
            assert!(
                parent < index,
                "node {index} names parent {parent} out of order"
            );
            self.children[parent as usize].push(index);
        }
        self.nodes.push(node);
        self.children.push(Vec::new());
        index
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn node(&self, index: u32) -> &Node {
        &self.nodes[index as usize]
    }

    pub fn node_mut(&mut self, index: u32) -> &mut Node {
        &mut self.nodes[index as usize]
    }

    /// Children in three's `children` order.
    pub fn children(&self, index: u32) -> &[u32] {
        &self.children[index as usize]
    }

    /// Children that are bones, in order.
    pub fn bone_children(&self, index: u32) -> impl Iterator<Item = u32> + '_ {
        self.children(index)
            .iter()
            .copied()
            .filter(|&c| self.node(c).is_bone)
    }

    pub fn parent(&self, index: u32) -> Option<u32> {
        self.node(index).parent()
    }

    /// Origin of the node's world matrix.
    pub fn world_position(&self, index: u32) -> Vec3 {
        let mut out = Vec3::default();
        out.set_from_matrix_position(&self.node(index).matrix_world);
        out
    }

    /// World rotation of a node, with any scale on the hierarchy divided out.
    pub fn world_quat(&self, index: u32) -> Quat {
        let mut m = Mat4::default();
        m.extract_rotation(&self.node(index).matrix_world);
        let mut out = Quat::default();
        out.set_from_rotation_matrix(&m);
        out
    }

    /// `node.matrixWorld.multiplyMatrices(parent.matrixWorld, node.matrix)`.
    pub fn hang(&mut self, index: u32, parent: u32) {
        let parent_world = self.node(parent).matrix_world;
        let node = self.node_mut(index);
        let local = node.matrix;
        node.matrix_world.multiply_matrices(&parent_world, &local);
    }

    // three r186 Object3D.updateWorldMatrix (updateParents = true, updateChildren = false)
    pub fn update_world_matrix_parents(&mut self, index: u32) {
        if let Some(parent) = self.parent(index) {
            self.update_world_matrix_parents(parent);
        }
        self.update_world_matrix_self(index, false);
    }

    /// The part of `updateMatrixWorld`/`updateWorldMatrix` that concerns the node itself.
    fn update_world_matrix_self(&mut self, index: u32, force: bool) {
        let parent_world = self.parent(index).map(|p| self.node(p).matrix_world);
        let node = self.node_mut(index);
        if node.matrix_auto_update {
            node.update_matrix();
        }
        if node.matrix_world_needs_update || force {
            if node.matrix_world_auto_update {
                let local = node.matrix;
                match parent_world {
                    None => {
                        node.matrix_world.copy(&local);
                    }
                    Some(parent_world) => {
                        node.matrix_world.multiply_matrices(&parent_world, &local);
                    }
                }
            }
            node.matrix_world_needs_update = false;
        }
    }

    // three r186 Object3D.updateMatrixWorld(true), over a subset of the update root's subtree.
    //
    // `nodes` must be ascending and hold the parent of every entry but the first's, so each
    // world matrix is formed from a parent formed earlier in the same pass. Nodes left out are
    // not read.
    pub fn update_matrix_world_forced(&mut self, nodes: &[u32]) {
        for &index in nodes {
            self.update_world_matrix_self(index, true);
        }
    }
}
