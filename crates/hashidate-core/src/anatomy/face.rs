//! `anatomy/face.ts`: the face as a finger meets it — the head's skin, kept vertex by vertex.
//!
//! The head volume is a radius per band and bearing about one axis. That is the
//! right shape for an arm swinging past a skull and the wrong one for a finger,
//! which travels a few millimetres off the skin: under the jaw and in the hollow
//! of a cheek lie inside the radius the chin or the cheekbone sets at that
//! bearing, and a finger laid along the face read as half a head deep. So the
//! fingers are tested against the skin itself, measured once at load in the
//! head bone's frame — whatever face the avatar has.
//!
//! Inside or out is read off the skin's normals round the point, which hold
//! near the surface, where the question is asked; nothing here claims a
//! distance deep in the skull. The normal is the surface's own, from its triangles: an anime face
//! carries normals edited toward the front for its shading, and by those a hand
//! cupped behind the ear read as three centimetres inside the cheek.
//!
//! `FaceSurface.measure` reads the mesh and stays in TS; its positions and normals arrive as a
//! [`FaceSkin`]. The hash TS keeps in a `Map` is a sorted key table here, each cell's vertices in
//! the order the map received them, so every query visits them in the same order.

use super::{world_position, world_quaternion};
use crate::math::f::{js_max, js_min, sqrt};
use crate::math::{Mat4, Quat, Vec3};
use crate::profile::FaceSkin;
use crate::scene::graph::Graph;

/// Hash cell, metres. About a fingertip's breadth.
const CELL: f64 = 0.02;
/// Cells out to look before calling a point nowhere near the face.
const REACH: f64 = 3.0;
/// Least radius the skin is read over round a point, metres: a few vertex spacings.
const SMOOTH: f64 = 0.01;

const ONE: Vec3 = Vec3::new(1.0, 1.0, 1.0);

/// Signed local plane sample and its outward normal in world coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FaceSurfaceSample {
    pub distance: f64,
    pub normal: Vec3,
    pub valid: bool,
}

// face.ts key
fn key(x: f64, y: f64, z: f64) -> f64 {
    ((x + 512.0) * 1024.0 + (y + 512.0)) * 1024.0 + (z + 512.0)
}

/// What `each` does with every vertex it visits: `findNearest` or `gatherWeighted`.
#[derive(Clone, Copy)]
enum Visit {
    Nearest,
    Gather,
}

#[derive(Clone, Debug)]
pub struct FaceSurface {
    bone: u32,
    pos: Vec<f32>,
    nrm: Vec<f32>,
    /// Occupied cell keys, ascending.
    keys: Vec<f64>,
    /// Start of each key's run in `members`, plus one past the last.
    starts: Vec<u32>,
    /// Vertices per cell, each run in insertion order.
    members: Vec<u32>,
    min_cell_x: f64,
    min_cell_y: f64,
    min_cell_z: f64,
    max_cell_x: f64,
    max_cell_y: f64,
    max_cell_z: f64,
    to_head: Mat4,
    turn: Quat,
    sample_point: Vec3,
    sample_normal: Vec3,
    best: f64,
    bi: Option<usize>,
    r2: f64,
    sum: f64,
    weight: f64,
    cached_sample: FaceSurfaceSample,
    /// Cell lookups since construction.
    #[cfg(test)]
    pub lookups: usize,
}

impl FaceSurface {
    // face.ts FaceSurface.constructor
    pub fn new(bone: u32, skin: &FaceSkin) -> FaceSurface {
        let pos = skin.pos.clone();
        let nrm = skin.nrm.clone();
        let n = pos.len() / 3;
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        let mut keyed: Vec<(f64, u32)> = Vec::with_capacity(n);
        for i in 0..n {
            let x = (f64::from(pos[i * 3]) / CELL).floor();
            let y = (f64::from(pos[i * 3 + 1]) / CELL).floor();
            let z = (f64::from(pos[i * 3 + 2]) / CELL).floor();
            for (axis, c) in [x, y, z].into_iter().enumerate() {
                min[axis] = js_min(min[axis], c);
                max[axis] = js_max(max[axis], c);
            }
            keyed.push((key(x, y, z), i as u32));
        }
        // Stable, so a cell keeps the order its vertices arrived in.
        keyed.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut keys = Vec::new();
        let mut starts = Vec::new();
        for (at, &(k, _)) in keyed.iter().enumerate() {
            if keys
                .last()
                .is_none_or(|last: &f64| last.total_cmp(&k).is_ne())
            {
                keys.push(k);
                starts.push(at as u32);
            }
        }
        starts.push(keyed.len() as u32);
        FaceSurface {
            bone,
            pos,
            nrm,
            keys,
            starts,
            members: keyed.iter().map(|&(_, i)| i).collect(),
            min_cell_x: min[0],
            min_cell_y: min[1],
            min_cell_z: min[2],
            max_cell_x: max[0],
            max_cell_y: max[1],
            max_cell_z: max[2],
            to_head: Mat4::default(),
            turn: Quat::default(),
            sample_point: Vec3::default(),
            sample_normal: Vec3::default(),
            best: f64::INFINITY,
            bi: None,
            r2: 0.0,
            sum: 0.0,
            weight: 0.0,
            cached_sample: FaceSurfaceSample::default(),
            #[cfg(test)]
            lookups: 0,
        }
    }

    // face.ts FaceSurface.refresh
    //
    // Follow the head to where it is posed now. Call before a run of face queries.
    pub fn refresh(&mut self, graph: &mut Graph) {
        graph.update_world_matrix(self.bone, true, false, false);
        self.turn = world_quaternion(graph, self.bone);
        let at = world_position(graph, self.bone);
        self.to_head.compose(&at, &self.turn, &ONE).invert();
    }

    // face.ts FaceSurface.shortfall
    //
    // How far short of `clear` outside the skin a world point is, in metres.
    // Writes the outward normal only for a positive shortfall; clear and invalid
    // points retain the old no-write behavior.
    pub fn shortfall(&mut self, p: &Vec3, clear: f64, outward: &mut Vec3) -> f64 {
        let mut sample = self.cached_sample;
        self.sample(p, &mut sample);
        self.cached_sample = sample;
        if !sample.valid || sample.distance >= clear {
            return 0.0;
        }
        outward.copy(&sample.normal);
        clear - sample.distance
    }

    // face.ts FaceSurface.sample
    //
    // Signed local averaged-plane distance in metres and its outward world
    // normal. Invalid samples reset the output to neutral values.
    //
    // Read off the vertices round the point rather than the nearest one alone,
    // each weighted down to nothing at a radius: the nearest vertex changes
    // under a moving point, the distance to its plane jumped by millimetres when
    // it did, and a hand placed by that distance jerked with it. The radius
    // grows with the distance to the skin, so the reading stays smooth deep in.
    //
    // `!(weight > 0)` is TS's, and is meant: a NaN weight fails it.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    pub fn sample(&mut self, p: &Vec3, out: &mut FaceSurfaceSample) {
        out.distance = 0.0;
        out.normal.set(0.0, 0.0, 0.0);
        out.valid = false;
        self.sample_point.copy(p).apply_matrix4(&self.to_head);
        let p = self.sample_point;
        let cx = (p.x / CELL).floor();
        let cy = (p.y / CELL).floor();
        let cz = (p.z / CELL).floor();
        // The nearest-vertex search cannot find a cell beyond this exact reach cube.
        if cx + REACH < self.min_cell_x
            || cx - REACH > self.max_cell_x
            || cy + REACH < self.min_cell_y
            || cy - REACH > self.max_cell_y
            || cz + REACH < self.min_cell_z
            || cz - REACH > self.max_cell_z
        {
            return;
        }
        self.best = f64::INFINITY;
        self.bi = None;
        // Widened only when the near cells are empty: a finger sunk deep in a cheek
        // is further from the skin than a cell, and that is the finger to move most.
        let mut r = 1.0;
        while r <= REACH && self.bi.is_none() {
            self.each(cx, cy, cz, r, Visit::Nearest);
            r += 1.0;
        }
        let Some(bi) = self.bi else {
            return;
        };
        let radius = js_max(SMOOTH, 2.0 * sqrt(self.best));
        // Too far off the skin to gather round: its nearest vertex's plane says it.
        if radius > REACH * CELL {
            self.plane_sample(&p, bi, out);
            return;
        }
        self.r2 = radius * radius;
        self.sum = 0.0;
        self.weight = 0.0;
        self.sample_normal.set(0.0, 0.0, 0.0);
        self.each(cx, cy, cz, (radius / CELL).ceil(), Visit::Gather);
        if !(self.weight > 0.0) || self.sample_normal.length_sq() < 1e-12 {
            return;
        }
        let s = self.sum / self.weight;
        out.distance = s;
        out.normal
            .copy(&self.sample_normal)
            .normalize()
            .apply_quaternion(&self.turn);
        out.valid = true;
    }

    // face.ts FaceSurface.planeSample
    fn plane_sample(&self, p: &Vec3, i: usize, out: &mut FaceSurfaceSample) {
        let (nx, ny, nz) = self.normal_of(i);
        let s = (p.x - f64::from(self.pos[i * 3])) * nx
            + (p.y - f64::from(self.pos[i * 3 + 1])) * ny
            + (p.z - f64::from(self.pos[i * 3 + 2])) * nz;
        let length_sq = nx * nx + ny * ny + nz * nz;
        if length_sq < 1e-12 {
            return;
        }
        out.distance = s;
        // Keep the captured Float32 normal: the former fallback wrote it unscaled.
        out.normal.set(nx, ny, nz).apply_quaternion(&self.turn);
        out.valid = true;
    }

    fn normal_of(&self, i: usize) -> (f64, f64, f64) {
        (
            f64::from(self.nrm[i * 3]),
            f64::from(self.nrm[i * 3 + 1]),
            f64::from(self.nrm[i * 3 + 2]),
        )
    }

    // face.ts FaceSurface.dist2
    fn dist2(&self, p: &Vec3, i: usize) -> f64 {
        let dx = p.x - f64::from(self.pos[i * 3]);
        let dy = p.y - f64::from(self.pos[i * 3 + 1]);
        let dz = p.z - f64::from(self.pos[i * 3 + 2]);
        dx * dx + dy * dy + dz * dz
    }

    // face.ts FaceSurface.findNearest
    fn find_nearest(&mut self, i: usize) {
        let d2 = self.dist2(&self.sample_point, i);
        if d2 < self.best {
            self.best = d2;
            self.bi = Some(i);
        }
    }

    // face.ts FaceSurface.gatherWeighted
    fn gather_weighted(&mut self, i: usize) {
        let p = self.sample_point;
        let r2 = self.r2;
        let d2 = self.dist2(&p, i);
        if d2 >= r2 {
            return;
        }
        let k = 1.0 - d2 / r2;
        let w = k * k;
        let (nx, ny, nz) = self.normal_of(i);
        self.sum += w
            * ((p.x - f64::from(self.pos[i * 3])) * nx
                + (p.y - f64::from(self.pos[i * 3 + 1])) * ny
                + (p.z - f64::from(self.pos[i * 3 + 2])) * nz);
        self.weight += w;
        self.sample_normal.x += w * nx;
        self.sample_normal.y += w * ny;
        self.sample_normal.z += w * nz;
    }

    /// The run of vertices in the cell with `key`, empty where none.
    fn cell(&self, key: f64) -> (usize, usize) {
        match self.keys.binary_search_by(|k| k.total_cmp(&key)) {
            Ok(c) => (self.starts[c] as usize, self.starts[c + 1] as usize),
            Err(_) => (0, 0),
        }
    }

    // face.ts FaceSurface.each
    //
    // Every vertex in the cells within `r` of cell (cx, cy, cz).
    fn each(&mut self, cx: f64, cy: f64, cz: f64, r: f64, visit: Visit) {
        let mut x = cx - r;
        while x <= cx + r {
            let mut y = cy - r;
            while y <= cy + r {
                let mut z = cz - r;
                while z <= cz + r {
                    #[cfg(test)]
                    {
                        self.lookups += 1;
                    }
                    let (start, end) = self.cell(key(x, y, z));
                    for m in start..end {
                        let i = self.members[m] as usize;
                        match visit {
                            Visit::Nearest => self.find_nearest(i),
                            Visit::Gather => self.gather_weighted(i),
                        }
                    }
                    z += 1.0;
                }
                y += 1.0;
            }
            x += 1.0;
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::scene::graph::{RECORD, Shape, flag};

    /// A head bone under a root, the shape `face-surface.test.ts` builds, as a graph: node 0 the
    /// root, node 1 the head.
    pub struct Fixture {
        pub graph: Graph,
        pub face: FaceSurface,
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Shape3 {
        Plane,
        Curved,
        Balanced,
    }

    const CLEAR: f64 = 0.03;
    const ROTATED_PLANE_NORMAL: [f64; 3] = [
        0.29116930397264834,
        -0.14869156426260066,
        0.9450456365389052,
    ];

    /// Captured from the unchanged shortfall implementation at clear=0.03.
    struct Case {
        shape: Shape3,
        local: [f64; 3],
        shortfall: f64,
        normal: [f64; 3],
    }

    const CASES: [Case; 4] = [
        Case {
            shape: Shape3::Plane,
            local: [0.013, 0.004, 0.006],
            shortfall: 0.024,
            normal: ROTATED_PLANE_NORMAL,
        },
        Case {
            shape: Shape3::Plane,
            local: [0.013, 0.004, -0.004],
            shortfall: 0.034,
            normal: ROTATED_PLANE_NORMAL,
        },
        Case {
            shape: Shape3::Curved,
            local: [0.023, -0.018, 0.102735],
            shortfall: 0.023476148986988465,
            normal: [0.485142503309084, -0.2872242147713401, 0.8259170672240539],
        },
        Case {
            shape: Shape3::Curved,
            local: [0.023, -0.018, 0.088735],
            shortfall: 0.03695687124457286,
            normal: [0.5060138469550715, -0.3038423005120602, 0.8072359277864608],
        },
    ];

    fn close(a: f64, b: f64, digits: i32) {
        let tolerance = 10f64.powi(-digits) / 2.0;
        assert!((a - b).abs() < tolerance, "{a} is not close to {b}");
    }

    fn v(a: [f64; 3]) -> Vec3 {
        Vec3::new(a[0], a[1], a[2])
    }

    /// What `FaceSurface.measure` reads off the test's skinned mesh, bound at rest with every
    /// matrix the identity: each vertex as the f32 attribute holds it, and its normal from the
    /// area-weighted triangle normals `shell` accumulates in an f32 array, nudged 1e-3 along it,
    /// differenced and normalised as the measurement does.
    fn skin(positions: &[f64], indices: &[usize]) -> FaceSkin {
        let n = positions.len() / 3;
        let at = |i: usize| {
            Vec3::new(
                f64::from(positions[3 * i] as f32),
                f64::from(positions[3 * i + 1] as f32),
                f64::from(positions[3 * i + 2] as f32),
            )
        };
        let mut acc = vec![0f32; 3 * n];
        for t in indices.as_chunks::<3>().0 {
            let a = at(t[0]);
            let mut b = at(t[1]);
            b.sub(&a);
            let mut c = at(t[2]);
            c.sub(&a);
            b.cross(&c);
            for &corner in t {
                acc[corner * 3] = (f64::from(acc[corner * 3]) + b.x) as f32;
                acc[corner * 3 + 1] = (f64::from(acc[corner * 3 + 1]) + b.y) as f32;
                acc[corner * 3 + 2] = (f64::from(acc[corner * 3 + 2]) + b.z) as f32;
            }
        }
        let mut pos = Vec::with_capacity(3 * n);
        let mut nrm = Vec::with_capacity(3 * n);
        for i in 0..n {
            let p = at(i);
            let mut normal = Vec3::new(
                f64::from(acc[3 * i]),
                f64::from(acc[3 * i + 1]),
                f64::from(acc[3 * i + 2]),
            );
            normal.normalize();
            let mut off = p;
            off.add_scaled_vector(&normal, 1e-3).sub(&p);
            if off.length_sq() < 1e-16 {
                continue;
            }
            off.normalize();
            pos.extend([p.x as f32, p.y as f32, p.z as f32]);
            nrm.extend([off.x as f32, off.y as f32, off.z as f32]);
        }
        FaceSkin { pos, nrm }
    }

    fn shape_skin(shape: Shape3) -> FaceSkin {
        let mut positions = Vec::new();
        let mut indices = Vec::new();
        if shape == Shape3::Balanced {
            let radius = 0.004;
            let points = [
                [radius, 0.0, 0.0],
                [-radius, 0.0, 0.0],
                [0.0, radius, 0.0],
                [0.0, -radius, 0.0],
                [0.0, 0.0, radius],
                [0.0, 0.0, -radius],
            ];
            for p in points {
                positions.extend(p);
            }
            for x in [0, 1] {
                for y in [2, 3] {
                    for z in [4, 5] {
                        let mut face = [x, y, z];
                        let (a, b, c) = (v(points[x]), v(points[y]), v(points[z]));
                        let mut normal = b;
                        normal.sub(&a);
                        let mut ca = c;
                        ca.sub(&a);
                        normal.cross(&ca);
                        let mut sum = a;
                        sum.add(&b).add(&c);
                        if normal.dot(&sum) < 0.0 {
                            face.swap(1, 2);
                        }
                        indices.extend(face);
                    }
                }
            }
        } else {
            let side = 15;
            let center = (side - 1) as f64 / 2.0;
            for y in 0..side {
                for x in 0..side {
                    let px = (x as f64 - center) * 0.01;
                    let py = (y as f64 - center) * 0.01;
                    let pz = if shape == Shape3::Plane {
                        0.0
                    } else {
                        0.1 - (px * px + py * py) / 0.2
                    };
                    positions.extend([px, py, pz]);
                }
            }
            for y in 0..side - 1 {
                for x in 0..side - 1 {
                    let a = y * side + x;
                    let b = a + 1;
                    let c = a + side;
                    let d = c + 1;
                    indices.extend([a, b, d, a, d, c]);
                }
            }
        }
        skin(&positions, &indices)
    }

    fn fixture(shape: Shape3) -> Fixture {
        let mut graph = Graph::new(Shape {
            nodes: 2,
            ..Shape::default()
        });
        let mut record = [0.0; RECORD];
        // Unit quaternion and scale, identity matrices.
        record[6] = 1.0;
        record[7..10].copy_from_slice(&[1.0, 1.0, 1.0]);
        for at in [13, 29] {
            for k in 0..4 {
                record[at + 5 * k] = 1.0;
            }
        }
        let auto = flag::MATRIX_AUTO_UPDATE | flag::MATRIX_WORLD_AUTO_UPDATE;
        graph.push_node(crate::scene::graph::NO_NODE, auto, &record);
        graph.push_node(0, auto | flag::BONE, &record);
        graph.build();
        let mut face = FaceSurface::new(1, &shape_skin(shape));
        face.refresh(&mut graph);
        Fixture { graph, face }
    }

    fn set_euler(graph: &mut Graph, node: usize, x: f64, y: f64, z: f64) {
        let mut q = Quat::default();
        q.set_from_euler_xyz(x, y, z);
        graph.quaternion[4 * node..4 * node + 4].copy_from_slice(&[q.x, q.y, q.z, q.w]);
    }

    fn posed(shape: Shape3) -> Fixture {
        let mut f = fixture(shape);
        f.graph.position[0..3].copy_from_slice(&[0.8, -0.3, 1.1]);
        set_euler(&mut f.graph, 0, 0.0, 0.4, 0.0);
        set_euler(&mut f.graph, 1, 0.15, -0.1, 0.08);
        f.graph.update_matrix_world(0, true);
        f.face.refresh(&mut f.graph);
        f
    }

    fn world_point(f: &mut Fixture, local: [f64; 3]) -> Vec3 {
        f.graph.update_matrix_world(0, true);
        let q = world_quaternion(&mut f.graph, 1);
        let at = world_position(&mut f.graph, 1);
        let mut p = v(local);
        p.apply_quaternion(&q).add(&at);
        p
    }

    fn sentinel() -> FaceSurfaceSample {
        FaceSurfaceSample {
            distance: 123.0,
            normal: Vec3::new(4.0, 5.0, 6.0),
            valid: false,
        }
    }

    #[test]
    fn keeps_the_recorded_shortfall_and_world_normal_on_transformed_skins() {
        for row in &CASES {
            let mut f = posed(row.shape);
            let mut normal = Vec3::new(4.0, 5.0, 6.0);
            let point = world_point(&mut f, row.local);
            let shortfall = f.face.shortfall(&point, CLEAR, &mut normal);
            close(shortfall, row.shortfall, 8);
            assert!(normal.distance_to(&v(row.normal)) < 1e-8);
        }
    }

    #[test]
    fn exposes_signed_distance_and_outward_normal_for_the_same_samples() {
        for row in &CASES {
            let mut f = posed(row.shape);
            let point = world_point(&mut f, row.local);
            let mut sample = sentinel();
            f.face.sample(&point, &mut sample);
            assert!(sample.valid);
            close(sample.distance, CLEAR - row.shortfall, 8);
            assert!(sample.normal.distance_to(&v(row.normal)) < 1e-8);
            let mut outward = Vec3::new(4.0, 5.0, 6.0);
            close(
                f.face.shortfall(&point, CLEAR, &mut outward),
                row.shortfall,
                8,
            );
            assert!(outward.distance_to(&sample.normal) < 1e-8);
        }
    }

    #[test]
    fn keeps_valid_clear_points_signed_without_writing_the_normal() {
        let mut f = fixture(Shape3::Plane);
        let point = world_point(&mut f, [0.013, 0.004, 0.006]);
        let mut sample = FaceSurfaceSample {
            distance: -1.0,
            ..sentinel()
        };
        f.face.sample(&point, &mut sample);
        assert!(sample.valid);
        close(sample.distance, 0.006, 8);
        close(sample.normal.length(), 1.0, 8);
        let mut outward = Vec3::new(4.0, 5.0, 6.0);
        assert_eq!(f.face.shortfall(&point, 0.003, &mut outward), 0.0);
        assert_eq!(outward, Vec3::new(4.0, 5.0, 6.0));
    }

    #[test]
    fn falls_back_to_the_nearest_plane_deep_inside_the_skin() {
        let mut f = posed(Shape3::Curved);
        let point = world_point(&mut f, [0.0, 0.0, 0.04]);
        let mut sample = sentinel();
        f.face.sample(&point, &mut sample);
        assert!(sample.valid);
        close(sample.distance, -0.06761233848142988, 8);
        assert_eq!(
            [sample.normal.x, sample.normal.y, sample.normal.z],
            [0.734208899333023, -0.25993920721420577, 0.6271912608092143]
        );
        let mut outward = Vec3::default();
        close(
            f.face.shortfall(&point, CLEAR, &mut outward),
            0.09761233848142988,
            8,
        );
        assert!(outward.distance_to(&sample.normal) < 1e-8);
    }

    #[test]
    fn marks_a_balanced_local_normal_invalid_without_stale_output() {
        let mut f = fixture(Shape3::Balanced);
        let point = world_point(&mut f, [0.0, 0.0, 0.0]);
        let mut sample = FaceSurfaceSample {
            valid: true,
            ..sentinel()
        };
        f.face.sample(&point, &mut sample);
        assert!(!sample.valid);
        assert_eq!(sample.distance, 0.0);
        assert_eq!(sample.normal, Vec3::default());
        let mut outward = Vec3::new(4.0, 5.0, 6.0);
        assert_eq!(f.face.shortfall(&point, CLEAR, &mut outward), 0.0);
        assert_eq!(outward, Vec3::new(4.0, 5.0, 6.0));
    }

    #[test]
    fn returns_neutral_invalid_samples_without_probing_disjoint_cells() {
        let mut f = posed(Shape3::Curved);
        let point = world_point(&mut f, [0.0, 0.0, 0.8]);
        let before = f.face.lookups;
        let mut sample = FaceSurfaceSample {
            valid: true,
            ..sentinel()
        };
        f.face.sample(&point, &mut sample);
        assert_eq!(f.face.lookups, before);
        assert!(!sample.valid);
        assert_eq!(sample.distance, 0.0);
        assert_eq!(sample.normal, Vec3::default());
    }

    #[test]
    fn keeps_queries_whose_reach_cube_touches_the_occupied_bounds() {
        let mut f = posed(Shape3::Plane);
        for local in [[-0.135, -0.135, -0.055], [0.125, 0.125, 0.065]] {
            let mut sample = sentinel();
            let point = world_point(&mut f, local);
            f.face.sample(&point, &mut sample);
            assert!(sample.valid);
            assert!(sample.distance.is_finite());
            assert!(sample.normal.length_sq() > 0.0);
        }
    }

    #[test]
    fn resets_invalid_far_samples_and_leaves_the_query_alone() {
        let mut f = fixture(Shape3::Curved);
        let point = world_point(&mut f, [0.0, 0.0, 0.8]);
        let original = point;
        let mut sample = FaceSurfaceSample {
            valid: true,
            ..sentinel()
        };
        f.face.sample(&point, &mut sample);
        assert!(!sample.valid);
        assert_eq!(sample.distance, 0.0);
        assert_eq!(sample.normal, Vec3::default());
        assert_eq!(point, original);
        let mut outward = Vec3::new(4.0, 5.0, 6.0);
        assert_eq!(f.face.shortfall(&point, CLEAR, &mut outward), 0.0);
        assert_eq!(outward, Vec3::new(4.0, 5.0, 6.0));
    }

    #[test]
    fn repeated_samples_visit_the_same_cells() {
        let mut f = fixture(Shape3::Plane);
        let point = world_point(&mut f, [0.013, 0.004, 0.006]);
        let mut counts = [0; 2];
        for count in &mut counts {
            let before = f.face.lookups;
            let mut sample = sentinel();
            f.face.sample(&point, &mut sample);
            assert!(sample.valid);
            close(sample.distance, 0.006, 8);
            *count = f.face.lookups - before;
        }
        // One nearest-vertex cube of radius 1, one gather cube of radius 1.
        assert_eq!(counts, [54, 54]);
    }
}
