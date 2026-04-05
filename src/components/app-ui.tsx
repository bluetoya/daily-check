import type { CSSProperties } from "react";

type TabId = "today" | "weekly" | "stats" | "pomodoro" | "routines" | "settings";
type PlanetVariant = "gas" | "storm" | "crater" | "ice" | "dune";

export function TabIcon({ tab, active }: { tab: TabId; active: boolean }) {
  const stroke = active ? "#17140f" : "#92a099";
  const common = {
    fill: "none",
    stroke,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (tab) {
    case "today":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M4 10.5L12 4l8 6.5V20H4z" />
          <path {...common} d="M9.5 20v-5h5v5" />
        </svg>
      );
    case "weekly":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect {...common} x="4" y="5" width="16" height="15" rx="3" />
          <path {...common} d="M4 10h16M9.3 5v15M14.7 5v15" />
        </svg>
      );
    case "stats":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M6 18V11M12 18V7M18 18v-4" />
          <path {...common} d="M4 18h16" />
        </svg>
      );
    case "pomodoro":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M9 4h6M8 7h8" />
          <path {...common} d="M12 7c4 0 6.5 2.7 6.5 6.4S16 20 12 20s-6.5-2.9-6.5-6.6S8 7 12 7z" />
          <path {...common} d="M12 10.2v3.3l2.2 1.5" />
        </svg>
      );
    case "routines":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path {...common} d="M8 7h11M8 12h11M8 17h11" />
          <path {...common} d="M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
        </svg>
      );
    case "settings":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            {...common}
            d="M12 4.8l1.7.5.9 1.7 1.9.4 1.4 1.4-.4 1.9 1 1.5-1 1.5.4 1.9-1.4 1.4-1.9.4-.9 1.7-1.7.5-1.7-.5-.9-1.7-1.9-.4-1.4-1.4.4-1.9-1-1.5 1-1.5-.4-1.9 1.4-1.4 1.9-.4.9-1.7z"
          />
          <circle {...common} cx="12" cy="12" r="3.1" />
        </svg>
      );
    default:
      return null;
  }
}

export function PlanetBadge({
  accent,
  size = "label",
  ringed = false,
  intense = false,
  variant = "gas",
}: {
  accent: string;
  size?: "label" | "chip" | "swatch";
  ringed?: boolean;
  intense?: boolean;
  variant?: PlanetVariant;
}) {
  return (
    <span
      className={`planet-badge planet-badge-${size} ${ringed ? "planet-badge-ringed" : ""} ${
        intense ? "planet-badge-intense" : ""
      }`}
      style={{ "--planet": accent } as CSSProperties}
    >
      <span className={`planet-badge-core planet-badge-variant-${variant}`}>
        <span className="planet-badge-surface" />
      </span>
    </span>
  );
}
