/// <reference lib="webworker" />
import { copyPositions, createSimulation, tickBudget, type SimulationHandle } from "./simulate";
import type { SimLink } from "./types";

interface StartMsg {
  type: "start";
  nodeCount: number;
  positions: ArrayBuffer;
  links: SimLink[];
  orphanFlags: ArrayBuffer;
  ringRadius: number;
  alpha: number;
}

type InMsg = StartMsg | { type: "stop" };

let handle: SimulationHandle | null = null;
let running = false;
let nodeCount = 0;

function loop() {
  if (!running || !handle) return;
  const done = tickBudget(handle, 8);
  const buf = new Float32Array(nodeCount * 2);
  copyPositions(handle.nodes, buf);
  if (done) {
    running = false;
    postMessage({ type: "done", positions: buf }, [buf.buffer]);
    return;
  }
  postMessage({ type: "tick", positions: buf }, [buf.buffer]);
  setTimeout(loop, 0);
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "stop") {
    running = false;
    handle = null;
    return;
  }
  if (msg.type === "start") {
    running = false;
    nodeCount = msg.nodeCount;
    const positions = new Float32Array(msg.positions);
    const orphanFlags = new Uint8Array(msg.orphanFlags);
    handle = createSimulation({
      nodeCount,
      positions,
      links: msg.links,
      orphanFlags,
      ringRadius: msg.ringRadius,
      alpha: msg.alpha,
    });
    running = true;
    loop();
  }
};
