export { ControlClient, ControlError, DEFAULT_BASE } from '../control/client';

/**
 * What the CLI does about a failure, which is not what every caller does about
 * one.
 *
 * The transport moved to `src/control` when the MCP adapter began sharing it,
 * and it reports failure by throwing rather than by leaving — a server that is
 * meant to outlive a refused connection cannot have a transport that exits the
 * process. This is the other half of that split: for a command that does one
 * thing and is then done, printing and stopping is still the right answer, and
 * `main` routes anything thrown here.
 */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
