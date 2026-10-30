//! Colliders, the clusters that cull them, and the cull itself.

use super::{CLUSTER_SIZE, spring::Joint};
use crate::math::f::{js_max, js_min, sqrt};
use crate::math::{Box3, Quat, Vec3, clamp};
use crate::scene::Scene;

/// A sphere or capsule the swinging parts cannot enter.
///
/// Positioned relative to a bone, so it follows the body. `offset` and `tail` are in **metres
/// along the bone's own axes** — the bone's rotation is applied and its scale is not, which makes
/// one number mean the same distance on an avatar authored in metres and on one authored in
/// centimetres. Radii are metres for the same reason.
///
/// `inside: true` inverts it: the point is kept *within* the sphere instead of out of it. That is
/// how a ribbon is stopped from flaring off the body without also being stopped from lying
/// against it.
#[derive(Clone, Debug)]
pub struct Collider {
    pub bone: u32,
    pub offset: Vec3,
    pub tail_offset: Option<Vec3>,
    pub radius: f64,
    pub inside: bool,
    pub a: Vec3,
    pub b: Vec3,
    /// `b - a` and its squared length, as of the last `place`.
    seg: Vec3,
    len2: f64,
}

impl Collider {
    // spring.ts Collider.constructor
    pub fn new(
        bone: u32,
        offset: Vec3,
        tail_offset: Option<Vec3>,
        radius: f64,
        inside: bool,
    ) -> Self {
        Self {
            bone,
            offset,
            tail_offset,
            radius,
            inside,
            a: Vec3::default(),
            b: Vec3::default(),
            seg: Vec3::default(),
            len2: 0.0,
        }
    }

    // spring.ts Collider.place
    //
    // Refresh world-space geometry. Once per step, before any joint reads it.
    pub fn place(&mut self, scene: &Scene, rotation: &Quat) {
        let p = scene.world_position(self.bone);
        self.a.copy(&self.offset).apply_quaternion(rotation).add(&p);
        if let Some(tail) = &self.tail_offset {
            self.b.copy(tail).apply_quaternion(rotation).add(&p);
        } else {
            self.b.copy(&self.a);
        }
        self.len2 = self.seg.sub_vectors(&self.b, &self.a).length_sq();
    }

    /// `place` at the bone's own world rotation.
    pub fn place_on_bone(&mut self, scene: &Scene) {
        let rotation = scene.world_quat(self.bone);
        self.place(scene, &rotation);
    }

    // spring.ts Collider.nearest
    //
    // Nearest point on the capsule's axis and `point` minus it, returning the distance from
    // `point` to it. For a sphere the two ends coincide and this collapses to the centre without
    // a special case.
    fn nearest_point(&self, point: &Vec3) -> (f64, Vec3, Vec3) {
        let len2 = self.len2;
        let mut t = 0.0;
        let mut d = Vec3::default();
        if len2 > 1e-12 {
            t = d.sub_vectors(point, &self.a).dot(&self.seg) / len2;
            // `t < 0 ? 0 : t > 1 ? 1 : t`, which `f64::clamp` is, NaN and both zeros included.
            t = t.clamp(0.0, 1.0);
        }
        let mut p = self.a;
        p.add_scaled_vector(&self.seg, t);
        let dist = d.sub_vectors(point, &p).length();
        (dist, p, d)
    }

    // spring.ts Collider.nearest
    pub fn nearest(&self, point: &Vec3) -> f64 {
        self.nearest_point(point).0
    }

    // spring.ts Collider.beyond
    //
    // Whether `push` and `clearLink` are sure to leave a link alone: an outside collider whose
    // axis is further from `root` than the link's length plus either clearance (`Joint#reach`,
    // squared), with the tip at most that length away. Neither test is run on a culled pair, so
    // the margin keeps the cull clear of their rounding. Every axis point either test uses is at
    // least this far, so a capsule is culled on the same terms as a sphere.
    pub fn beyond(&self, root: &Vec3, reach: f64) -> bool {
        !self.inside && self.axis_distance_sq(root) > reach
    }

    // spring.ts Collider.#axisDistanceSq
    //
    // Squared distance from `point` to the axis; its rounding is far inside the cull margin.
    fn axis_distance_sq(&self, point: &Vec3) -> f64 {
        let a = &self.a;
        let mut dx = point.x - a.x;
        let mut dy = point.y - a.y;
        let mut dz = point.z - a.z;
        let len2 = self.len2;
        if len2 > 1e-12 {
            let s = &self.seg;
            let t = js_min(1.0, js_max(0.0, (dx * s.x + dy * s.y + dz * s.z) / len2));
            dx -= s.x * t;
            dy -= s.y * t;
            dz -= s.z * t;
        }
        dx * dx + dy * dy + dz * dz
    }

    // spring.ts Collider.nearestToLink
    //
    // Point on the capsule's axis nearest the segment `p0`–`p1`. For a sphere, its centre.
    fn nearest_to_link(&self, p0: &Vec3, p1: &Vec3) -> Vec3 {
        let seg = &self.seg;
        let e = self.len2;
        if e <= 1e-12 {
            return self.a;
        }
        let mut d = Vec3::default();
        let mut lr = Vec3::default();
        d.sub_vectors(p1, p0);
        lr.sub_vectors(p0, &self.a);
        let a = d.length_sq();
        let b = d.dot(seg);
        let c = d.dot(&lr);
        let f = seg.dot(&lr);
        // Closest points of two segments (Ericson 5.1.9). Only the axis point is
        // wanted, so the link parameter is not re-clamped after the axis one.
        let denom = a * e - b * b;
        // `MathUtils.clamp(v, 0, 1)` spelled out, which it is word for word.
        let s = if denom > 1e-12 {
            js_max(0.0, js_min(1.0, (b * f - c * e) / denom))
        } else {
            0.0
        };
        let t = js_max(0.0, js_min(1.0, (b * s + f) / e));
        let mut out = self.a;
        out.add_scaled_vector(seg, t);
        out
    }

    // spring.ts Collider.linkDistance
    //
    // Distance from the axis to the segment `p0`–`p1`.
    pub fn link_distance(&self, p0: &Vec3, p1: &Vec3) -> f64 {
        let lc = self.nearest_to_link(p0, p1);
        let mut lw = Vec3::default();
        lw.sub_vectors(p1, p0);
        let len2 = lw.length_sq();
        let mut lu = Vec3::default();
        let t = if len2 > 1e-12 {
            clamp(lu.sub_vectors(&lc, p0).dot(&lw) / len2, 0.0, 1.0)
        } else {
            0.0
        };
        lu.copy(p0).add_scaled_vector(&lw, t).distance_to(&lc)
    }

    // spring.ts Collider.clearLink
    //
    // Swing the link from `root` to `tip` about its root, by the least angle that holds the whole
    // link at or beyond `min` from the axis. Length is kept. A tail-only test lets a long link
    // pass through a collider with both ends outside it. Returns whether the tip had to be moved.
    // Outside colliders only: a link with both ends inside a convex shape is inside it along its
    // length.
    pub fn clear_link(&self, root: &Vec3, tip: &mut Vec3, length: f64, min: f64) -> bool {
        if self.inside {
            return false;
        }
        let lc = self.nearest_to_link(root, tip);
        let mut lw = Vec3::default();
        lw.sub_vectors(&lc, root);
        let dist = lw.length();
        // A root already that close cannot be helped by turning the link.
        if dist <= min {
            return false;
        }
        let mut lu = Vec3::default();
        lu.sub_vectors(tip, root).multiply_scalar(1.0 / length);
        let along = lu.dot(&lw);
        if along <= 0.0 {
            return false;
        }
        // The widest angle to the axis point that still clears: the tangent from the
        // root if the link reaches it, otherwise where the tip alone touches.
        let tangent = sqrt(dist * dist - min * min);
        let cos_max = if length >= tangent {
            tangent / dist
        } else {
            (dist * dist + length * length - min * min) / (2.0 * length * dist)
        };
        if along / dist <= cos_max {
            return false;
        }
        lw.multiply_scalar(1.0 / dist);
        let mut le = lu;
        le.add_scaled_vector(&lw, -lu.dot(&lw));
        if le.length_sq() < 1e-12 {
            let lr = if lw.x.abs() < 0.9 {
                Vec3::new(1.0, 0.0, 0.0)
            } else {
                Vec3::new(0.0, 1.0, 0.0)
            };
            le.cross_vectors(&lw, &lr);
        }
        le.normalize();
        let sin_max = sqrt(js_max(0.0, 1.0 - cos_max * cos_max));
        tip.copy(root)
            .add_scaled_vector(&lw, cos_max * length)
            .add_scaled_vector(&le, sin_max * length);
        true
    }

    // spring.ts Collider.push
    //
    // Hold `point` at or beyond `min` from the axis — or at or within it, for an inside collider.
    // Returns whether the point had to be moved.
    //
    // `min` is calibrated per joint rather than being `radius + tail radius`. See `calibrate`.
    pub fn push(&self, point: &mut Vec3, min: f64) -> bool {
        let (dist, p, mut d) = self.nearest_point(point);
        if if self.inside {
            dist <= min
        } else {
            dist >= min
        } {
            return false;
        }
        // Dead centre has no direction to leave by. Any is as good as any other,
        // and picking one beats leaving the point buried forever.
        if dist < 1e-9 {
            d.set(0.0, 1.0, 0.0);
        } else {
            d.multiply_scalar(1.0 / dist);
        }
        point.copy(&p).add_scaled_vector(&d, min);
        true
    }
}

/// Outside colliders of one group on one bone, near each other, bounded by a sphere refitted to
/// their placed axes. A root further from the sphere than the widest of the members' cull
/// distances is further than each from its own axis, so one test culls them all. A lone collider
/// is tested on its own.
#[derive(Clone, Debug)]
pub struct Cluster {
    /// Positions in the group's collider list.
    pub members: Vec<usize>,
    pub centre: Vec3,
    pub radius: f64,
}

impl Cluster {
    fn new(members: Vec<usize>) -> Self {
        Self {
            members,
            centre: Vec3::default(),
            radius: 0.0,
        }
    }

    // spring.ts Cluster.refit
    //
    // Fit the sphere around every member's axis ends as last placed.
    fn refit(&mut self, group: &[usize], pool: &[Collider]) {
        let centre = self.centre.set(0.0, 0.0, 0.0);
        for &i in &self.members {
            let c = &pool[group[i]];
            centre.add(&c.a).add(&c.b);
        }
        centre.multiply_scalar(1.0 / (2 * self.members.len()) as f64);
        let mut r2 = 0.0;
        for &i in &self.members {
            let c = &pool[group[i]];
            r2 = js_max(
                js_max(r2, self.centre.distance_to_squared(&c.a)),
                self.centre.distance_to_squared(&c.b),
            );
        }
        self.radius = sqrt(r2);
    }

    // spring.ts Cluster.beyond
    //
    // Whether the sphere is further from `root` than `reach`.
    fn beyond(&self, root: &Vec3, reach: f64) -> bool {
        let r = self.radius + reach;
        self.centre.distance_to_squared(root) > r * r
    }
}

/// Midpoint of a collider's placed axis.
fn mid(c: &Collider) -> Vec3 {
    let mut out = Vec3::default();
    out.add_vectors(&c.a, &c.b).multiply_scalar(0.5);
    out
}

/// Stable insertion sort taking `less` as `Array#sort`'s comparator does (`< 0` orders first).
/// Never panics on an inconsistent comparator, where a library sort may.
fn sort_stable(items: &mut [usize], mut compare: impl FnMut(usize, usize) -> f64) {
    for i in 1..items.len() {
        let mut j = i;
        while j > 0 && compare(items[j - 1], items[j]) > 0.0 {
            items.swap(j - 1, j);
            j -= 1;
        }
    }
}

// spring.ts clusterColliders
//
// Partition a group's colliders, as placed, into clusters: each bone's outside colliders split
// along their widest extent until no part exceeds `CLUSTER_SIZE`.
pub fn cluster_colliders(group: &[usize], pool: &[Collider]) -> Vec<Cluster> {
    let mut out = Vec::new();
    let mut by_bone: Vec<(u32, Vec<usize>)> = Vec::new();
    for (i, &c) in group.iter().enumerate() {
        let collider = &pool[c];
        if collider.inside {
            out.push(Cluster::new(vec![i]));
            continue;
        }
        match by_bone.iter_mut().find(|(bone, _)| *bone == collider.bone) {
            Some((_, members)) => members.push(i),
            None => by_bone.push((collider.bone, vec![i])),
        }
    }
    fn split(members: Vec<usize>, group: &[usize], pool: &[Collider], out: &mut Vec<Cluster>) {
        if members.len() <= CLUSTER_SIZE {
            out.push(Cluster::new(members));
            return;
        }
        let points: Vec<Vec3> = members.iter().map(|&i| mid(&pool[group[i]])).collect();
        let mut bounds = Box3::default();
        bounds.set_from_points(&points);
        let mut size = Vec3::default();
        bounds.get_size(&mut size);
        let axis: fn(&Vec3) -> f64 = if size.x >= size.y && size.x >= size.z {
            |v| v.x
        } else if size.y >= size.z {
            |v| v.y
        } else {
            |v| v.z
        };
        let mut sorted = members;
        sort_stable(&mut sorted, |p, q| {
            axis(&mid(&pool[group[p]])) - axis(&mid(&pool[group[q]]))
        });
        let half = sorted.len() >> 1;
        let rest = sorted.split_off(half);
        split(sorted, group, pool, out);
        split(rest, group, pool, out);
    }
    for (_, members) in by_bone {
        split(members, group, pool, &mut out);
    }
    out
}

// spring.ts refitClusters
pub fn refit_clusters(clusters: &mut [Cluster], group: &[usize], pool: &[Collider]) {
    for cluster in clusters {
        if cluster.members.len() > 1 {
            cluster.refit(group, pool);
        }
    }
}

/// Per collider of the joint being tested, whether `Collider::beyond` culls it.
#[derive(Clone, Debug, Default)]
pub struct Far {
    pub marks: Vec<u8>,
    /// Test every pair in full, as if nothing could be culled.
    #[cfg(test)]
    pub disabled: bool,
    /// Colliders culled, and contacts made by a step, since construction.
    #[cfg(test)]
    pub culled: usize,
    #[cfg(test)]
    pub contacts: usize,
}

// spring.ts cull
//
// Mark into `far` each collider `Collider::beyond` culls for `j` from `root`. Returns whether any
// is left to test.
pub fn cull(
    group: &[usize],
    pool: &[Collider],
    clusters: &[Cluster],
    j: &Joint,
    root: &Vec3,
    far: &mut Far,
) -> bool {
    if far.marks.len() < group.len() {
        far.marks.resize(group.len(), 0);
    }
    #[cfg(test)]
    if far.disabled {
        far.marks[..group.len()].fill(0);
        return !group.is_empty();
    }
    let mut near = false;
    for (q, cluster) in clusters.iter().enumerate() {
        let members = &cluster.members;
        if members.len() > 1 && cluster.beyond(root, j.cluster_reach[q]) {
            for &m in members {
                far.marks[m] = 1;
            }
            #[cfg(test)]
            {
                far.culled += members.len();
            }
            continue;
        }
        for &i in members {
            let is_far = pool[group[i]].beyond(root, j.reach[i]);
            far.marks[i] = u8::from(is_far);
            near |= !is_far;
            #[cfg(test)]
            {
                far.culled += usize::from(is_far);
            }
        }
    }
    near
}

#[cfg(test)]
mod tests {
    use super::super::Spring;
    use super::super::testkit::{Rig, chain, group};
    use crate::math::Vec3;

    /// Hair and a skirt against a torso carrying twenty colliders on one bone, enough to be split
    /// into several clusters, plus capsules, an inside sphere and colliders riding the hair.
    fn fixture(cull_disabled: bool) -> (Rig, Spring) {
        let mut rig = Rig::humanoid(0.01);
        let head = rig.bone("Head");
        let hips = rig.bone("Hips");
        let chest = rig.bone("UpperChest");
        let hair = chain(&mut rig, head, 3, [0.02, 0.05, -0.06], [0.0, -0.07, -0.03]);
        let hub = rig.add(hips, [0.0, 0.0, 0.0]);
        let mut skirt = Vec::new();
        for k in 0..6 {
            let a = k as f64 / 6.0 * std::f64::consts::PI * 2.0;
            skirt.push(chain(
                &mut rig,
                hub,
                3,
                [a.cos() * 0.12, -0.02, a.sin() * 0.1],
                [a.cos() * 0.02, -0.09, a.sin() * 0.02],
            ));
        }
        let mut spring = rig.spring();
        let head_c = spring.add_collider(head, Vec3::new(0.0, 0.08, 0.0), None, 0.09, false);
        let mut torso = Vec::new();
        for k in 0..20 {
            let a = k as f64 / 20.0 * std::f64::consts::PI * 2.0;
            let at = Vec3::new(a.cos() * 0.1, (k % 3) as f64 * 0.05 - 0.05, a.sin() * 0.08);
            let tail = (k % 2 == 0).then(|| Vec3::new(at.x, at.y + 0.1, at.z));
            torso.push(spring.add_collider(chest, at, tail, 0.03 + (k % 2) as f64 * 0.01, false));
        }
        let leg = spring.add_collider(
            hips,
            Vec3::new(0.09, -0.05, 0.0),
            Some(Vec3::new(0.09, -0.45, 0.02)),
            0.07,
            false,
        );
        let ribbon = spring.add_collider(hips, Vec3::new(0.0, -0.2, 0.0), None, 0.45, true);
        let hair_c = spring.add_collider(hair[2], Vec3::default(), None, 0.02, false);

        spring.begin_group(group(0.4, 0.2, 1.0));
        spring.add_group_root(hair[0]);
        assert!(spring.end_group() > 0);
        for &c in [head_c].iter().chain(&torso) {
            spring.add_group_collider(c);
        }
        spring.begin_group(group(0.3, 0.25, 0.8));
        for s in &skirt {
            spring.add_group_root(s[0]);
        }
        assert!(spring.end_group() > 0);
        for &c in [leg, ribbon, hair_c].iter().chain(&torso) {
            spring.add_group_collider(c);
        }
        spring.build();
        spring.far.disabled = cull_disabled;
        (rig, spring)
    }

    fn run(cull_disabled: bool) -> (Vec<Vec<u64>>, usize, usize) {
        const DTS: [f64; 8] = [
            1.0 / 72.0,
            1.0 / 72.0,
            1.0 / 50.0,
            1.0 / 144.0,
            1.0 / 60.0,
            1.0 / 30.0,
            0.05,
            1.0 / 90.0,
        ];
        let (rig, mut spring) = fixture(cull_disabled);
        let hips = rig.bone("Hips");
        let chest = rig.bone("UpperChest");
        let head = rig.bone("Head");
        let mut frames = Vec::new();
        let mut t = 0.0;
        for frame in 0..360 {
            let dt = DTS[frame % DTS.len()];
            t += dt;
            rig.rotate(
                &mut spring,
                hips,
                [(t * 2.1).sin() * 0.6, (t * 1.3).cos() * 0.9, 0.0],
            );
            rig.rotate(
                &mut spring,
                chest,
                [(t * 1.7).sin() * 0.4, 0.0, (t * 2.3).cos() * 0.3],
            );
            rig.rotate(
                &mut spring,
                head,
                [(t * 4.1).sin() * 0.8, (t * 3.7).sin() * 1.2, 0.0],
            );
            rig.world_update(&mut spring);
            spring.update(dt);
            frames.push(rig.state(&spring));
        }
        (frames, spring.far.culled, spring.far.contacts)
    }

    #[test]
    fn culling_changes_no_bit_against_testing_every_pair() {
        let (full, _, contacts) = run(true);
        let (culled, culls, _) = run(false);
        assert!(contacts > 0, "no contact was made");
        assert!(culls > 0, "nothing was culled");
        assert_eq!(full.len(), culled.len());
        for (frame, (a, b)) in full.iter().zip(&culled).enumerate() {
            let at = a.iter().zip(b).position(|(x, y)| x != y);
            assert_eq!(at, None, "frame {frame}");
        }
    }

    #[test]
    fn the_torso_is_split_into_several_clusters() {
        let (_, spring) = fixture(false);
        let clusters = spring.groups[0].clusters.as_ref().expect("clusters");
        let torso: Vec<_> = clusters.iter().filter(|c| c.members.len() > 1).collect();
        assert!(torso.len() >= 3, "{} clusters", torso.len());
        assert!(torso.iter().all(|c| c.members.len() <= super::CLUSTER_SIZE));
    }
}
