import { expect, it } from "vitest";
import { useConsole } from "./console";
import { useNetwork } from "./network";
import type { ConsoleEntry, NetworkEvent } from "../lib/ipc";

// Explicit local microbenchmark, not a timing assertion in CI or native CPU claim.
// VITE_TELEMETRY_BENCHMARK=1 pnpm --filter @dive/desktop exec vitest run src/store/telemetry.benchmark.test.ts --reporter=json --outputFile=/tmp/dive-telemetry.json
it.skipIf(import.meta.env.VITE_TELEMETRY_BENCHMARK !== "1")("measures immediate versus batched display publication", ({ task }) => {
  const consoleEntries: ConsoleEntry[] = Array.from({ length: 5000 }, (_, i) => ({ tab_id: "bench", level: "info", text: String(i), source: "console", url: null, line: null, column: null, timestamp: i }));
  const frames: NetworkEvent[] = Array.from({ length: 5000 }, (_, i) => ({ type: "frame", data: { tab_id: "bench", request_id: "socket", direction: "received", payload: String(i), timestamp: i } }));
  const results: Record<string, { milliseconds: number; publications: number }[]> = {};
  for (let round = 0; round < 6; round++) {
    for (const batched of [false, true]) {
      const consoleState = useConsole.getState();
      consoleState.flush();
      useConsole.setState({ byTab: {} });
      let publications = 0;
      const off = useConsole.subscribe(() => { publications++; });
      const started = performance.now();
      for (const entry of consoleEntries) (batched ? consoleState.enqueue : consoleState.push)(entry);
      consoleState.flush();
      const milliseconds = performance.now() - started;
      off();
      expect(publications).toBe(batched ? 1 : 5000);
      expect(useConsole.getState().byTab.bench?.at(-1)?.text).toBe("4999");
      if (round) (results[batched ? "console_batched" : "console_immediate"] ??= []).push({ milliseconds, publications });

      const network = useNetwork.getState();
      network.flush();
      useNetwork.setState({ byTab: {}, frames: {} });
      network.apply({ type: "socket", data: { tab_id: "bench", request_id: "socket", url: "wss://bench.invalid", timestamp: 0 } });
      publications = 0;
      const unlisten = useNetwork.subscribe(() => { publications++; });
      const start = performance.now();
      for (const frame of frames) (batched ? network.enqueue : network.apply)(frame);
      network.flush();
      const elapsed = performance.now() - start;
      unlisten();
      expect(publications).toBe(batched ? 1 : 5000);
      expect(useNetwork.getState().frames["bench:socket"]?.at(-1)?.payload).toBe("4999");
      if (round) (results[batched ? "frames_batched" : "frames_immediate"] ??= []).push({ milliseconds: elapsed, publications });
    }
  }
  Object.assign(task.meta, { telemetry: { events: 5000, rounds: results } });
});
