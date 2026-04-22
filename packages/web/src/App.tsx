import type * as React from "react";
/**
 * Route definitions + top-level providers.
 *
 * Providers order (outer → inner):
 *   BrowserRouter
 *     ToastProvider (so everything can toast)
 *       SseProvider  (so everything can subscribe to events)
 *         Routes
 *           AppShell — sidebar + hotkeys + command palette
 */

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell.js";
import { SseProvider } from "./lib/sse.js";
import { ToastProvider } from "./lib/toast.js";
import { NotFoundPage } from "./pages/NotFoundPage.js";
import { ProjectDetailPage } from "./pages/ProjectDetailPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { ReposPage } from "./pages/ReposPage.js";
import { ResolvePage } from "./pages/ResolvePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { SkillMatrixPage } from "./pages/SkillMatrixPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";

export function App(): React.JSX.Element {
  return (
    <BrowserRouter>
      <ToastProvider>
        <SseProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<DashboardPage />} />
              <Route path="/repos" element={<ReposPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route path="/matrix" element={<SkillMatrixPage />} />
              <Route
                path="/resolve/:project_id/:skill_id"
                element={<ResolvePage />}
              />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/index.html" element={<Navigate to="/" replace />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </SseProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
