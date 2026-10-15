import { useColorScheme } from "react-native";

// Matches the web app's globals.css tokens.
const palettes = {
  light: {
    background: "#ffffff",
    text: "#171717",
    muted: "#737373",
    border: "#e5e5e5",
    fill: "rgba(0,0,0,0.05)",
  },
  dark: {
    background: "#111111",
    text: "#ededed",
    muted: "#a1a1a1",
    border: "#2b2b2b",
    fill: "rgba(255,255,255,0.06)",
  },
};

export type Palette = (typeof palettes)["light"];

export function useScheme(): "light" | "dark" {
  return useColorScheme() === "dark" ? "dark" : "light";
}

export function usePalette(): Palette {
  return palettes[useScheme()];
}
