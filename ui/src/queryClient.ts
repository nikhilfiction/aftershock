import { QueryClient } from "@tanstack/react-query";

import { ApiError } from "./api/client";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // retry only what may succeed next time: network failures and 5xx
        retry: (count, error) => count < 2 && (!(error instanceof ApiError) || error.retryable),
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
