"use client";

import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

const FADE_MS = 180;
const HOLD_MS = 140;
const HEIGHT_MS = 220;

type Phase =
  | "enter"
  | "enter-open"
  | "shown"
  | "exit-fade"
  | "exit-hold"
  | "exit-collapse";

type Slot = {
  /** Stable across optimistic ID swaps; used as the React key. */
  id: string;
  /** Live child key (`doc.id` / `folder.id`). */
  key: string;
  phase: Phase;
  snapshot: ReactElement;
};

function reducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function liveElements(children: ReactNode): ReactElement[] {
  return Children.toArray(children).filter(isValidElement) as ReactElement[];
}

function shownSlots(live: ReactElement[]): Slot[] {
  return live.map((child) => {
    const key = String(child.key);
    return { id: key, key, phase: "shown" as Phase, snapshot: child };
  });
}

/**
 * Optimistic creates inject a temp UUID, then swap in the server id a
 * moment later. Treat a same-index 1:1 key swap as the same row so we
 * don't replay enter/exit.
 */
function remapOptimisticSwap(curr: Slot[], live: ReactElement[]): Slot[] {
  const liveKeys = live.map((child) => String(child.key));
  const liveSet = new Set(liveKeys);
  const present = curr.filter((slot) => !slot.phase.startsWith("exit"));
  const presentKeySet = new Set(present.map((slot) => slot.key));
  const added = live.filter((child) => !presentKeySet.has(String(child.key)));
  const removed = present.filter((slot) => !liveSet.has(slot.key));

  if (added.length !== 1 || removed.length !== 1) return curr;

  const oldKey = removed[0].key;
  const newChild = added[0];
  const newKey = String(newChild.key);
  if (present.findIndex((slot) => slot.key === oldKey) !== liveKeys.indexOf(newKey)) {
    return curr;
  }

  return curr.map((slot) =>
    slot.key === oldKey ? { ...slot, key: newKey, snapshot: newChild } : slot
  );
}

function mergeSlots(
  curr: Slot[],
  live: ReactElement[],
  latest: Map<string, ReactElement>
): Slot[] {
  const slots = remapOptimisticSwap(curr, live);
  const liveSet = new Set(live.map((child) => String(child.key)));

  const next: Slot[] = live.map((child) => {
    const key = String(child.key);
    const existing = slots.find((slot) => slot.key === key);
    if (existing && existing.phase.startsWith("exit")) {
      return { ...existing, phase: "shown", snapshot: child };
    }
    if (existing) {
      return { ...existing, snapshot: child };
    }
    return { id: key, key, phase: "enter", snapshot: child };
  });

  const exiting = slots.filter((slot) => !liveSet.has(slot.key));
  for (let i = exiting.length - 1; i >= 0; i--) {
    const slot = exiting[i];
    const oldIndex = slots.findIndex((s) => s.id === slot.id);
    const item: Slot = slot.phase.startsWith("exit")
      ? slot
      : {
          ...slot,
          phase: "exit-fade",
          snapshot: latest.get(slot.key) ?? slot.snapshot,
        };
    next.splice(Math.min(oldIndex, next.length), 0, item);
  }

  return next;
}

export function AnimatedTreeList({ children }: { children: ReactNode }) {
  const live = liveElements(children);
  const liveKeySig = live.map((child) => String(child.key)).join("\0");
  const skipEnter = useRef(true);

  const [slots, setSlots] = useState<Slot[]>(() => shownSlots(live));

  const liveMap = new Map<string, ReactElement>();
  const latestRef = useRef<Map<string, ReactElement>>(new Map());
  for (const child of live) {
    const key = String(child.key);
    liveMap.set(key, child);
    latestRef.current.set(key, child);
  }

  useLayoutEffect(() => {
    const nextLive = liveElements(children);
    setSlots((curr) => {
      if (skipEnter.current || reducedMotion()) return shownSlots(nextLive);
      return mergeSlots(curr, nextLive, latestRef.current);
    });
    if (liveKeySig) skipEnter.current = false;
    // children is read inside; liveKeySig is the structural dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKeySig]);

  const updatePhase = useCallback((id: string, phase: Phase | "gone") => {
    setSlots((curr) => {
      if (phase === "gone") {
        const gone = curr.find((slot) => slot.id === id);
        if (gone) latestRef.current.delete(gone.key);
        return curr.filter((slot) => slot.id !== id);
      }
      return curr.map((slot) => (slot.id === id ? { ...slot, phase } : slot));
    });
  }, []);

  return (
    <>
      {slots.map((slot) => (
        <TreeSlot
          key={slot.id}
          itemKey={slot.id}
          phase={slot.phase}
          onPhase={updatePhase}
        >
          {liveMap.get(slot.key) ?? slot.snapshot}
        </TreeSlot>
      ))}
    </>
  );
}

function TreeSlot({
  itemKey,
  phase,
  onPhase,
  children,
}: {
  itemKey: string;
  phase: Phase;
  onPhase: (key: string, phase: Phase | "gone") => void;
  children: ReactNode;
}) {
  const onPhaseRef = useRef(onPhase);
  useEffect(() => {
    onPhaseRef.current = onPhase;
  });

  useEffect(() => {
    const go = (next: Phase | "gone") => onPhaseRef.current(itemKey, next);

    if (reducedMotion()) {
      if (phase === "enter" || phase === "enter-open") go("shown");
      else if (phase.startsWith("exit")) go("gone");
      return;
    }

    if (phase === "enter") {
      let frame2 = 0;
      const frame1 = requestAnimationFrame(() => {
        frame2 = requestAnimationFrame(() => go("enter-open"));
      });
      return () => {
        cancelAnimationFrame(frame1);
        cancelAnimationFrame(frame2);
      };
    }

    if (phase === "enter-open") {
      const t = window.setTimeout(() => go("shown"), HEIGHT_MS);
      return () => window.clearTimeout(t);
    }

    if (phase === "exit-fade") {
      const t = window.setTimeout(() => go("exit-hold"), FADE_MS);
      return () => window.clearTimeout(t);
    }

    if (phase === "exit-hold") {
      const t = window.setTimeout(() => go("exit-collapse"), HOLD_MS);
      return () => window.clearTimeout(t);
    }

    if (phase === "exit-collapse") {
      const t = window.setTimeout(() => go("gone"), HEIGHT_MS);
      return () => window.clearTimeout(t);
    }
  }, [itemKey, phase]);

  return (
    <div className="tree-anim" data-phase={phase} aria-hidden={phase !== "shown"}>
      <div className="tree-anim-clip">
        <div className="tree-anim-inner">{children}</div>
      </div>
    </div>
  );
}
