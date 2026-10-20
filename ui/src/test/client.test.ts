import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { ApiError, request } from "../api/client";
import { API, server } from "./server";

describe("API client", () => {
  it("turns FastAPI field errors into a field map", async () => {
    server.use(
      http.post(`${API}/repos`, () =>
        HttpResponse.json(
          { detail: [{ loc: ["body", "url"], msg: "Repository must be an https:// git URL", type: "value_error" }] },
          { status: 422 },
        ),
      ),
    );
    const err = (await request("/repos", { method: "POST", body: {} }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.fieldErrors).toEqual({ url: "Repository must be an https:// git URL" });
    expect(err.retryable).toBe(false);
  });

  it("uses the server's message for plain errors", async () => {
    server.use(http.get(`${API}/snapshots/9`, () => HttpResponse.json({ detail: "Snapshot 9 not found" }, { status: 404 })));
    await expect(request("/snapshots/9")).rejects.toMatchObject({ status: 404, message: "Snapshot 9 not found" });
  });

  it("explains a network failure in plain words and allows retry", async () => {
    server.use(http.get(`${API}/repos`, () => HttpResponse.error()));
    const err = (await request("/repos").catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Can't reach the API/);
    expect(err.retryable).toBe(true);
  });

  it("never shows a raw 500 body", async () => {
    server.use(http.get(`${API}/repos`, () => new HttpResponse("Traceback (most recent call last)...", { status: 500 })));
    const err = (await request("/repos").catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe("The server had a problem (500). Try again in a moment.");
  });
});
