import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";

/** Renders a page at a URL, with a fresh query cache and no retries. */
export function renderAt(path: string, routePattern: string, page: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePattern} element={page} />
          <Route path="*" element={<p>navigated away</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { user, ...utils };
}
