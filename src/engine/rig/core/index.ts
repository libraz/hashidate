/**
 * The rig run in the wasm core, behind the TS rig's public surface. Transitional: the
 * differential test runs it beside the TS rig until the TS rig is replaced by it.
 */

export { CoreArmAnatomy, CoreFaceSurface } from './anatomy';
export { CoreArmTransaction } from './arm-transaction';
export { CoreCharacterFrame } from './frame';
export { CoreRig } from './rig';
