import { controlPort } from '../shell/config';

/**
 * The port the control server listens on: `--port`, else a valid
 * `HASHIDATE_CONTROL_PORT`, else the default.
 *
 * The variable is read by `controlPort`, the rule the shell, the vite proxy and
 * `make stop` also follow, so moving it moves all of them together. Null for a
 * `--port` that is not a port, which is refused rather than replaced: a flag
 * was typed by someone who can be told.
 */
export function serverPort(
  flag: string | undefined,
  env: string | undefined = process.env.HASHIDATE_CONTROL_PORT,
): number | null {
  if (flag === undefined) return controlPort(env);
  const port = Number.parseInt(flag, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}
