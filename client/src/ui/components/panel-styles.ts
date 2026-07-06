import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

let floatingWindowZIndex = 2000;

export const darkGlassPanelStyle: CSSProperties = {
  background: "linear-gradient(180deg, rgba(13,17,32,0.9), rgba(9,12,24,0.76))",
  border: "1px solid rgba(238,244,255,0.12)",
  boxShadow: "0 18px 48px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.04)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
};

export const darkGlassSubtlePanelStyle: CSSProperties = {
  background: "linear-gradient(180deg, rgba(15,19,34,0.82), rgba(10,13,26,0.66))",
  border: "1px solid rgba(238,244,255,0.1)",
  boxShadow: "0 12px 34px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.035)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
};

function allocateFloatingWindowZIndex(baseZIndex: number): number {
  floatingWindowZIndex = Math.max(floatingWindowZIndex + 1, baseZIndex);
  return floatingWindowZIndex;
}

export function useFloatingWindowZIndex(open = true, baseZIndex = 840) {
  const [zIndex, setZIndex] = useState(baseZIndex);
  const bringToFront = useCallback(() => {
    setZIndex(allocateFloatingWindowZIndex(baseZIndex));
  }, [baseZIndex]);

  useEffect(() => {
    if (open) bringToFront();
  }, [bringToFront, open]);

  return { zIndex, bringToFront };
}

export function centeredWindowStyle(widthPx = 560, zIndex = 820): CSSProperties {
  return {
    position: "fixed",
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
    width: `min(${widthPx}px, calc(100vw - 32px))`,
    maxHeight: "min(760px, calc(100vh - 32px))",
    zIndex,
    pointerEvents: "auto",
    borderRadius: 16,
    ...darkGlassPanelStyle,
    color: "#eef4ff",
    fontFamily: "system-ui, sans-serif",
    overflow: "hidden",
  };
}

export const centeredBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(2, 6, 18, 0.42)",
  zIndex: 810,
  pointerEvents: "auto",
};
