/**
 * Tailwind config for @astack/web.
 *
 * Design system: Graphite UI (v0.3).
 * "Precision instrument, not a poster."
 *
 * Core ideas:
 *   - Surfaces use translucent white overlays on a near-black canvas,
 *     not opaque dark greys. Gives real depth on any LCD.
 *   - Single accent (green) reserved for state. No other color.
 *   - Typography hierarchy does the work normally done by color + badges.
 *   - Spacing is non-uniform (12/20/24/32, not 16/16/16).
 *
 * See the proposal in docs/version/v0.2-*.md → design redesign.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Canvas = the page itself. Single value, no ramp.
        canvas: "#0a0b0d",

        // Surface ramp. Implemented as translucent white overlays so every
        // surface benefits from the canvas below it. This reads as depth
        // on any LCD, not just calibrated OLED.
        surface: {
          1: "rgba(255, 255, 255, 0.025)", // cards
          2: "rgba(255, 255, 255, 0.04)",  // card hover / expanded area
          3: "rgba(255, 255, 255, 0.06)"   // modal / popover
        },

        // Border ramp. Very subtle by default — a hint, not a wall.
        line: {
          subtle: "rgba(255, 255, 255, 0.06)",
          DEFAULT: "rgba(255, 255, 255, 0.10)",
          strong: "rgba(255, 255, 255, 0.16)"
        },

        // Foreground ramp. Four distinct tiers; hierarchy is done here
        // instead of with color.
        fg: {
          primary: "#f2f3f5",
          secondary: "#a8acb4",
          tertiary: "#6b7079",
          quaternary: "#474a52"
        },

        // Single accent. Used for state (healthy / primary action) only.
        // Brighter than #10b981 so it reads as a pro-app green, not a
        // web-form success toast.
        accent: {
          DEFAULT: "#3dd68c",
          hover: "#55e09a",
          muted: "rgba(61, 214, 140, 0.12)",
          fg: "#003b1c"
        },

        // Semantic. Rare. Only for warning banners + destructive actions.
        warn: "#f5b955",
        error: "#ff6369",
        // Informational accent (distinct from the green state-accent).
        // Used sparingly for neutral labels like repo ownership.
        info: "#7da6ff",

        // Legacy aliases so we don't have to sweep every file at once.
        // New code should use the tokens above.
        base: "#0a0b0d",
        elevated: "rgba(255, 255, 255, 0.04)",
        border: "rgba(255, 255, 255, 0.10)",
        "text-primary": "#f2f3f5",
        "text-secondary": "#a8acb4",
        "text-muted": "#6b7079"
      },

      fontFamily: {
        // SF Pro first on macOS, Inter as cross-platform fallback.
        sans: [
          "-apple-system",
          "SF Pro Display",
          "SF Pro Text",
          "Inter",
          "system-ui",
          "sans-serif"
        ],
        // SF Mono is installed on every Mac. Geist Mono as a good fallback.
        mono: [
          "ui-monospace",
          "SF Mono",
          "Geist Mono",
          "JetBrains Mono",
          "monospace"
        ]
      },

      // Five-step scale. Anything outside this list is probably a mistake.
      fontSize: {
        xs: ["11px", { lineHeight: "16px", letterSpacing: "0.01em" }],
        sm: ["13px", { lineHeight: "20px" }],
        base: ["14px", { lineHeight: "22px" }],
        lg: ["17px", { lineHeight: "24px", letterSpacing: "-0.003em" }],
        xl: ["22px", { lineHeight: "28px", letterSpacing: "-0.01em" }],
        "2xl": ["28px", { lineHeight: "34px", letterSpacing: "-0.015em" }]
      },

      borderRadius: {
        DEFAULT: "6px",
        xs: "3px",
        sm: "4px",
        md: "6px",
        lg: "10px",
        xl: "14px"
      },

      spacing: {
        "sidebar-w": "232px",
        "content-max": "1200px"
      },

      transitionDuration: {
        fast: "120ms",
        DEFAULT: "180ms",
        slow: "240ms"
      },

      transitionTimingFunction: {
        // Apple-ish ease. Standard cubic-bezier for "motion should feel
        // physical, not CSS-linear".
        DEFAULT: "cubic-bezier(0.4, 0, 0.2, 1)",
        out: "cubic-bezier(0.16, 1, 0.3, 1)"
      }
    }
  },
  plugins: []
};
