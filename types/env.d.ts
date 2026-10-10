/**
 * Project-specific Workers type augmentation, equivalent to what
 * `wrangler types` generates: it teaches `env` (from `cloudflare:workers`) and
 * the `cloudflare:test` helpers about this worker's bindings and the main
 * module's default export.
 */
import type { Env as WuzapiQueueEnv } from "../shared/src/config";

declare global {
  namespace Cloudflare {
    interface Env extends WuzapiQueueEnv {}

    interface GlobalProps {
      mainModule: {
        default: ExportedHandler<WuzapiQueueEnv, unknown>;
      };
    }
  }
}
