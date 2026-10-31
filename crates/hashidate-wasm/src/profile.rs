//! Exports that assemble the numeric profile a rig is made from. The functions, codes and record
//! layouts are tabled in `src/core/abi/profile.ts`.

use hashidate_core::anatomy::joints::{JointDof, JointTable};
use hashidate_core::anatomy::surface::MeasuredVolume;
use hashidate_core::math::Vec3;
use hashidate_core::profile::{
    ArmTwistBinding, BONE_SLOTS, BodyFrame, FaceFrame, FaceSkin, Limb, NO_NODE, Profile,
};

/// f64 in the scratch record; the longest is FACE.
const SCRATCH: usize = 16;

/// A profile under construction and the scratch its record-taking calls read.
pub struct Builder {
    pub profile: Profile,
    scratch: [f64; SCRATCH],
}

/// The builder behind `p`.
///
/// # Safety
/// `p` must come from `hd_profile_new` and not have been freed or handed to `hd_rig_new`.
unsafe fn builder<'a>(p: *mut Builder) -> &'a mut Builder {
    // SAFETY: the caller passes a live pointer from `Box::into_raw` in `hd_profile_new`, and the
    // single-threaded module never holds two references to it at once.
    unsafe { &mut *p }
}

/// Takes the profile out of a builder, freeing the builder.
///
/// # Safety
/// As for [`builder`]; the pointer is dead afterwards.
pub unsafe fn take(p: *mut Builder) -> Profile {
    // SAFETY: the caller passes the pointer `Box::into_raw` returned, once.
    unsafe { Box::from_raw(p) }.profile
}

fn vec3(s: &[f64]) -> Vec3 {
    Vec3::new(s[0], s[1], s[2])
}

fn side(code: u32) -> usize {
    assert!(code < 2, "side code {code} out of range");
    code as usize
}

fn finger(code: u32) -> usize {
    assert!(code < 5, "finger code {code} out of range");
    code as usize
}

fn chain(side_code: u32, finger_code: u32) -> usize {
    side(side_code) * 5 + finger(finger_code)
}

fn limb_field(limb: &mut Limb, key: u32) -> &mut Option<f64> {
    match key {
        0 => &mut limb.upper,
        1 => &mut limb.lower,
        2 => &mut limb.thigh,
        3 => &mut limb.shin,
        4 => &mut limb.pitch,
        5 => &mut limb.proximal,
        6..=10 => &mut limb.tip[key as usize - 6],
        _ => panic!("limb key {key} out of range"),
    }
}

/// A required degree of freedom of the joint table, or an optional digit segment.
enum DofSlot<'a> {
    Required(&'a mut JointDof),
    Optional(&'a mut Option<JointDof>),
}

fn dof_slot(t: &mut JointTable, code: u32) -> DofSlot<'_> {
    use DofSlot::{Optional, Required};
    match code {
        0 => Required(&mut t.shoulder.rotation),
        1 => Required(&mut t.elbow.flexion),
        2 => Required(&mut t.elbow.rotation),
        3 => Required(&mut t.wrist.flexion),
        4 => Required(&mut t.wrist.deviation),
        5 => Optional(&mut t.finger.proximal),
        6 => Optional(&mut t.finger.intermediate),
        7 => Optional(&mut t.finger.distal),
        8 => Optional(&mut t.thumb.proximal),
        9 => Optional(&mut t.thumb.intermediate),
        10 => Optional(&mut t.thumb.distal),
        11 => Required(&mut t.neck.pitch),
        12 => Required(&mut t.neck.yaw),
        13 => Required(&mut t.neck.roll),
        14 => Required(&mut t.spine.pitch),
        15 => Required(&mut t.spine.yaw),
        16 => Required(&mut t.spine.roll),
        _ => panic!("joint dof code {code} out of range"),
    }
}

fn anatomy(b: &mut Builder) -> &mut JointTable {
    b.profile
        .anatomy
        .as_mut()
        .expect("hd_profile_anatomy opens the override first")
}

/// Creates an empty profile: every slot unresolved, `sideSign` 1.
#[unsafe(no_mangle)]
pub extern "C" fn hd_profile_new() -> *mut Builder {
    Box::into_raw(Box::new(Builder {
        profile: Profile::empty(),
        scratch: [0.0; SCRATCH],
    }))
}

/// Frees a profile that was never handed to `hd_rig_new`.
///
/// # Safety
/// `p` must come from `hd_profile_new` and not have been freed or handed to `hd_rig_new`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_free(p: *mut Builder) {
    // SAFETY: forwarded from this function's contract.
    drop(unsafe { take(p) });
}

/// The scratch record `hd_profile_face` and `hd_profile_body` read.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_scratch(p: *mut Builder) -> *mut f64 {
    // SAFETY: forwarded from this function's contract.
    unsafe { builder(p) }.scratch.as_mut_ptr()
}

/// Sets the node filling a bone slot (`NO_NODE` for none).
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_bone(p: *mut Builder, slot: u32, node: u32) {
    assert!(
        (slot as usize) < BONE_SLOTS,
        "bone slot {slot} out of range"
    );
    // SAFETY: forwarded from this function's contract.
    unsafe { builder(p) }.profile.bones[slot as usize] = node;
}

/// Sets a bone slot's rest direction.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_rest_dir(p: *mut Builder, slot: u32, x: f64, y: f64, z: f64) {
    assert!(
        (slot as usize) < BONE_SLOTS,
        "bone slot {slot} out of range"
    );
    // SAFETY: forwarded from this function's contract.
    unsafe { builder(p) }.profile.rest_dir[slot as usize] = Some(Vec3::new(x, y, z));
}

/// Sizes a finger's chain to `len` bones, every one `NO_NODE` with a zero rest direction until
/// `hd_profile_finger_bone` fills it.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_finger(p: *mut Builder, side: u32, finger: u32, len: u32) {
    let k = chain(side, finger);
    // SAFETY: forwarded from this function's contract.
    let profile = &mut unsafe { builder(p) }.profile;
    profile.finger_bones[k] = vec![NO_NODE; len as usize];
    profile.finger_rest_dir[k] = vec![Vec3::default(); len as usize];
}

/// Fills bone `i` of a finger's chain and its rest direction.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_profile_finger_bone(
    p: *mut Builder,
    side: u32,
    finger: u32,
    i: u32,
    node: u32,
    x: f64,
    y: f64,
    z: f64,
) {
    let k = chain(side, finger);
    // SAFETY: forwarded from this function's contract.
    let profile = &mut unsafe { builder(p) }.profile;
    profile.finger_bones[k][i as usize] = node;
    profile.finger_rest_dir[k][i as usize] = Vec3::new(x, y, z);
}

/// Sets `sideSign`.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_side_sign(p: *mut Builder, value: f64) {
    // SAFETY: forwarded from this function's contract.
    unsafe { builder(p) }.profile.side_sign = value;
}

/// Sets one `limb` length of one side.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_limb(p: *mut Builder, side_code: u32, key: u32, value: f64) {
    let s = side(side_code);
    // SAFETY: forwarded from this function's contract.
    let limb = &mut unsafe { builder(p) }.profile.limb[s];
    *limb_field(limb, key) = Some(value);
}

/// Sets the face frame from the FACE record in scratch; the mouth is read only with `has_mouth`.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_face(p: *mut Builder, has_mouth: u32) {
    // SAFETY: forwarded from this function's contract.
    let b = unsafe { builder(p) };
    let s = &b.scratch;
    b.profile.face = Some(FaceFrame {
        origin: vec3(&s[0..]),
        right: vec3(&s[3..]),
        up: vec3(&s[6..]),
        forward: vec3(&s[9..]),
        ipd: s[12],
        mouth: (has_mouth != 0).then(|| vec3(&s[13..])),
    });
}

/// Sets the body frame from the BODY record in scratch; `span` is read only with `has_span`.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_body(p: *mut Builder, has_span: u32) {
    // SAFETY: forwarded from this function's contract.
    let b = unsafe { builder(p) };
    let s = &b.scratch;
    b.profile.body = Some(BodyFrame {
        right: vec3(&s[0..]),
        up: vec3(&s[3..]),
        forward: vec3(&s[6..]),
        span: (has_span != 0).then_some(s[9]),
    });
}

/// Opens the joint-table override: the human table with no elevation rows, room for `rows`.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_anatomy(p: *mut Builder, rows: u32) {
    let mut table = JointTable::human();
    table.shoulder.elevation = Vec::with_capacity(rows as usize);
    // SAFETY: forwarded from this function's contract.
    unsafe { builder(p) }.profile.anatomy = Some(table);
}

/// Sets one degree of freedom of the override, in radians; `present` 0 leaves a digit segment
/// out and traps on any other dof.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_profile_joint(
    p: *mut Builder,
    dof: u32,
    present: u32,
    free_lo: f64,
    free_hi: f64,
    max_lo: f64,
    max_hi: f64,
) {
    let value = JointDof {
        free: [free_lo, free_hi],
        max: [max_lo, max_hi],
    };
    // SAFETY: forwarded from this function's contract.
    match dof_slot(anatomy(unsafe { builder(p) }), dof) {
        DofSlot::Required(slot) => {
            assert!(present != 0, "joint dof {dof} is required");
            *slot = value;
        }
        DofSlot::Optional(slot) => *slot = (present != 0).then_some(value),
    }
}

/// Appends a shoulder elevation row to the override, in degrees.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_elevation(p: *mut Builder, plane: f64, free: f64, max: f64) {
    // SAFETY: forwarded from this function's contract.
    let rows = &mut anatomy(unsafe { builder(p) }).shoulder.elevation;
    assert!(
        rows.len() < rows.capacity(),
        "more elevation rows than opened"
    );
    rows.push([plane, free, max]);
}

/// Sets the twist helper beside one arm link.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_arm_twist(
    p: *mut Builder,
    slot: u32,
    primary: u32,
    next: u32,
    helper: u32,
) {
    assert!(slot < 4, "arm twist slot {slot} out of range");
    // SAFETY: forwarded from this function's contract.
    unsafe { builder(p) }.profile.arm_twists[slot as usize] = Some(ArmTwistBinding {
        primary,
        next,
        helper,
    });
}

/// Sets `avatar.armRest` for one arm link.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_arm_rest(p: *mut Builder, slot: u32, x: f64, y: f64, z: f64) {
    assert!(slot < 4, "arm slot {slot} out of range");
    // SAFETY: forwarded from this function's contract.
    unsafe { builder(p) }.profile.arm_rest[slot as usize] = Some(Vec3::new(x, y, z));
}

/// Sets a measured volume. With `measured` the radius table is allocated at `cells` f32 and its
/// address returned for the caller to fill; without, the volume is the fallback cylinder and the
/// result is null.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_profile_volume(
    p: *mut Builder,
    part: u32,
    measured: u32,
    cells: u32,
    bands: f64,
    sectors: f64,
    top: f64,
    bottom: f64,
    radius: f64,
) -> *mut f32 {
    // SAFETY: forwarded from this function's contract.
    let m = &mut unsafe { builder(p) }.profile.measured;
    let slot = match part {
        0 => &mut m.torso,
        1 => &mut m.head,
        _ => panic!("volume part {part} out of range"),
    };
    let volume = slot.insert(MeasuredVolume {
        r: (measured != 0).then(|| vec![0.0; cells as usize]),
        bands,
        sectors,
        top,
        bottom,
        radius,
    });
    volume
        .r
        .as_mut()
        .map_or(std::ptr::null_mut(), |r| r.as_mut_ptr())
}

/// Sets the face skin to `vertices` vertices and returns the address of its positions, 3 f32
/// each, for the caller to fill.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_face_skin(p: *mut Builder, vertices: u32) -> *mut f32 {
    let len = 3 * vertices as usize;
    // SAFETY: forwarded from this function's contract.
    let skin = unsafe { builder(p) }
        .profile
        .measured
        .face
        .insert(FaceSkin {
            pos: vec![0.0; len],
            nrm: vec![0.0; len],
        });
    skin.pos.as_mut_ptr()
}

/// The address of the face skin's normals, 3 f32 per vertex; traps before `hd_profile_face_skin`.
///
/// # Safety
/// As for `hd_profile_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_profile_face_normals(p: *mut Builder) -> *mut f32 {
    // SAFETY: forwarded from this function's contract.
    unsafe { builder(p) }
        .profile
        .measured
        .face
        .as_mut()
        .expect("hd_profile_face_skin sizes the skin first")
        .nrm
        .as_mut_ptr()
}
