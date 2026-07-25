declare module "@decky/rollup" {
  import type { RollupOptions } from "rollup";

  export default function deckyPlugin(
    options?: Record<string, unknown>,
  ): RollupOptions;
}
