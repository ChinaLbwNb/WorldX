import type { CSSProperties } from "react";

export type GameIconName =
  | "world"
  | "character"
  | "inventory"
  | "online"
  | "chat"
  | "build"
  | "observer"
  | "resource";

export function GameIcon({
  name,
  size = 24,
  title,
  style,
}: {
  name: GameIconName;
  size?: number;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <img
      src={`/ui/icons/${name}.png`}
      alt={title || ""}
      title={title}
      draggable={false}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        display: "inline-block",
        verticalAlign: "middle",
        userSelect: "none",
        pointerEvents: "none",
        filter: "drop-shadow(0 3px 8px rgba(58, 178, 255, 0.2))",
        ...style,
      }}
    />
  );
}
