/**
 * Tailwind config for @astack/web.
 *
 * Design tokens mirror docs/asset/design.md § Design Review decision 4
 * (Dark-first tool feel, Linear × Vercel × GitHub):
 *   - single accent color (green = healthy)
 *   - semantic colors red (conflict) / yellow (behind)
 *   - 4px radius (not bubbly 12px)
 *   - Geist Sans / Geist Mono fonts
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Base surfaces (dark theme).
        base: "#0b0d10",
        surface: "#14171c",
        elevated: "#1a1e24",
        border: "#2a2f37",

        // Text ramp.
        "text-primary": "#e5e7eb",
        "text-secondary": "#9ca3af",
        "text-muted": "#6b7280",

        // Accent + semantic.
        accent: {
          DEFAULT: "#10b981",
          hover: "#059669",
          muted: "#064e3b"
        },
        warn: "#f59e0b",
        error: "#ef4444"
      },
      fontFamily: {
        sans: [
          "Geist Sans",
          "Inter Display",
          "system-ui",
          "-apple-system",
          "sans-serif"
        ],
        mono: ["Geist Mono", "JetBrains Mono", "ui-monospace", "monospace"]
      },
      fontSize: {
        xs: ["12px", "16px"],
        sm: ["13px", "18px"],
        base: ["14px", "20px"],
        lg: ["16px", "24px"],
        xl: ["20px", "28px"],
        "2xl": ["24px", "32px"],
        "3xl": ["32px", "40px"]
      },
      borderRadius: {
        DEFAULT: "4px",
        xs: "2px",
        sm: "4px",
        md: "6px",
        lg: "8px"
      },
      spacing: {
        "sidebar-w": "240px",
        "content-max": "1400px"
      },
      transitionDuration: {
        fast: "150ms",
        default: "200ms"
      }
    }
  },
  plugins: []
};
