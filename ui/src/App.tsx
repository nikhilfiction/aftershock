import { QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Link, Route, Routes } from "react-router";

import { AppFooter, TopBar } from "./components/Shell";
import { Empty, SkeletonLines } from "./components/ui";
import RepoPage from "./pages/RepoPage";
import ReposPage from "./pages/ReposPage";
import { VERSION_TEXT } from "./lib/links";
import { makeQueryClient } from "./queryClient";

// the scan page pulls in the graph library, so it gets its own chunk
const SnapshotPage = lazy(() => import("./pages/SnapshotPage"));

function NotFound() {
  return (
    <div className="app">
      <TopBar />
      <main id="main" className="wrap page-pad">
        <div className="panel">
          <Empty title="There is nothing at this address">
            <Link to="/">Go to your repositories</Link>
          </Empty>
        </div>
      </main>
      <AppFooter items={[VERSION_TEXT]} />
    </div>
  );
}

export function AppRoutes() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Suspense
        fallback={
          <main className="wrap page-pad">
            <SkeletonLines rows={5} height={24} />
          </main>
        }
      >
        <Routes>
          <Route path="/" element={<ReposPage />} />
          <Route path="/repos/:repoId" element={<RepoPage />} />
          <Route path="/snapshots/:snapshotId" element={<SnapshotPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </>
  );
}

const queryClient = makeQueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
