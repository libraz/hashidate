//! `rig/arm-path.ts`: the plan and its output, and the step solver.

pub mod plan;
pub mod solver;

pub use plan::{
    ArmPathBounds, ArmPathClearance, ArmPathEnvironment, ArmPathPlanOutput, ArmPathPoint,
    ArmPathPointKind, ArmPathRequest, ArmPathStatus, ClearanceKey, configuration_from_q,
    configuration_to_q, copy_forward, make_arm_path_plan_output,
};
pub use solver::ArmStepSolver;
