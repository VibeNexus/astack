/**
 * @astack/web entry point.
 *
 * React 19 + React Router 7. All providers live in App.tsx.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
