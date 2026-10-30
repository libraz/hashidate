import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { takeBase } from '../cli/args';
import { ControlClient } from '../control/client';
import { createServer } from './server';

/**
 * The MCP adapter, over stdio.
 *
 * stdio and not HTTP. Binding to loopback is a licence condition rather than a
 * default (see `CLAUDE.md`), and a second listening socket would be one more
 * thing to have to explain every time somebody reads the tree — for no gain,
 * since an MCP client on this machine starts the process itself. Nothing here
 * listens on anything.
 *
 * **stdout is the wire.** Anything printed on it that is not JSON-RPC corrupts
 * the session; diagnostics go to stderr.
 *
 * The control server does not have to be running. Starting one before the other
 * is the operator's choice, and this end must survive being started first, and
 * survive the other end restarting under it.
 */

/**
 * `--base` names a control server somewhere other than the default, spelled the
 * same way the CLI spells it and read by the same code. The MCP client's own
 * configuration is the only place it can be said — there is no prompt here to
 * type it at.
 */
async function main(): Promise<void> {
  const control = new ControlClient(takeBase(process.argv.slice(2)).base);
  await createServer(control).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
