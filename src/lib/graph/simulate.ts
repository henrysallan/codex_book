import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceX,
  forceY,
  forceRadial,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import type { SimLink } from "./types";

export interface SimNode extends SimulationNodeDatum {
  index: number;
  orphan: boolean;
}

export interface SimulationHandle {
  sim: Simulation<SimNode, SimLink>;
  nodes: SimNode[];
}

export function createSimulation(opts: {
  nodeCount: number;
  positions: Float32Array;
  links: SimLink[];
  orphanFlags: Uint8Array;
  ringRadius: number;
  alpha: number;
}): SimulationHandle {
  const nodes: SimNode[] = new Array(opts.nodeCount);
  for (let i = 0; i < opts.nodeCount; i++) {
    nodes[i] = {
      index: i,
      x: opts.positions[i * 2],
      y: opts.positions[i * 2 + 1],
      vx: 0,
      vy: 0,
      orphan: opts.orphanFlags[i] === 1,
    };
  }

  const links: SimLink[] = opts.links.map((l) => ({ ...l }));

  const sim = forceSimulation(nodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.index)
        .distance((d) => d.distance)
        .strength((d) => d.strength)
    )
    .force("charge", forceManyBody<SimNode>().strength(-28).theta(0.9))
    .force("x", forceX<SimNode>(0).strength(0.016))
    .force("y", forceY<SimNode>(0).strength(0.016))
    .force(
      "radial",
      forceRadial<SimNode>(opts.ringRadius, 0, 0).strength((d) => (d.orphan ? 0.06 : 0))
    )
    .alpha(opts.alpha)
    .alphaMin(0.005)
    .stop();

  return { sim, nodes };
}

export function copyPositions(nodes: SimNode[], out: Float32Array) {
  for (let i = 0; i < nodes.length; i++) {
    out[i * 2] = nodes[i].x ?? 0;
    out[i * 2 + 1] = nodes[i].y ?? 0;
  }
}

export function tickBudget(handle: SimulationHandle, budgetMs: number): boolean {
  const t0 = performance.now();
  while (performance.now() - t0 < budgetMs && (handle.sim.alpha() ?? 0) >= 0.005) {
    handle.sim.tick();
  }
  return (handle.sim.alpha() ?? 0) < 0.005;
}
