import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        risk: {
          low: "#16a34a",
          medium: "#d97706",
          high: "#dc2626",
          critical: "#7f1d1d",
        },
      },
    },
  },
  plugins: [],
};

export default config;
