import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import RepoPage from "../pages/RepoPage";
import { featureSnapshot, readySnapshot, repoDetail } from "./fixtures";
import { renderAt } from "./render";
import { API, server } from "./server";

const open = () => renderAt("/repos/1", "/repos/:repoId", <RepoPage />);

describe("Repository page", () => {
  it("starts a scan and keeps checking until it is ready", async () => {
    let gets = 0;
    let scanned = false;
    server.use(
      http.post(`${API}/repos/1/scan`, async ({ request }) => {
        expect(await request.json()).toEqual({ ref: "main", dynamic: true });
        scanned = true;
        return HttpResponse.json({ snapshot: { ...readySnapshot, status: "queued" }, queue: "in-process" }, { status: 202 });
      }),
      http.get(`${API}/repos/1`, () => {
        if (!scanned) return HttpResponse.json({ ...repoDetail, snapshots: [] });
        gets++;
        const status = gets < 2 ? "scanning" : "ready";
        return HttpResponse.json({ ...repoDetail, snapshots: [{ ...readySnapshot, status }] });
      }),
    );
    const { user } = open();
    expect(await screen.findByText("Not scanned yet")).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Run the test suite to find hidden/));
    await user.click(screen.getByRole("button", { name: "Start scan" }));

    expect(await screen.findByText("Scanning code")).toBeInTheDocument();
    const list = screen.getByRole("table");
    expect(await within(list).findByRole("link", { name: "Open blast radius" }, { timeout: 4000 })).toHaveAttribute(
      "href",
      "/snapshots/7",
    );
    expect(within(list).getByText("with runtime data")).toBeInTheDocument();
  });

  it("shows a failed scan's reason", async () => {
    server.use(
      http.get(`${API}/repos/1`, () =>
        HttpResponse.json({
          ...repoDetail,
          snapshots: [{ ...readySnapshot, status: "failed", error: "fatal: Needed a single revision" }],
        }),
      ),
    );
    open();
    expect(await screen.findByText("fatal: Needed a single revision")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open blast radius" })).not.toBeInTheDocument();
  });

  it("shows what the default branch's scan found, and links another branch as a comparison", async () => {
    server.use(
      http.get(`${API}/repos/1`, () =>
        HttpResponse.json({ ...repoDetail, snapshots: [featureSnapshot, readySnapshot] }),
      ),
    );
    open();
    const status = await screen.findByRole("region", { name: "Default branch: main" });
    expect(await within(status).findByText("19 of 55")).toBeInTheDocument();
    expect(within(status).getByText("46 on feature")).toBeInTheDocument();
    expect(within(status).getByText("1 only at runtime")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Compare branches/ })[0]).toHaveAttribute("href", "/snapshots/8?base=main");
    const rows = within(screen.getByRole("table")).getAllByRole("link", { name: "Open blast radius" });
    expect(rows.map((a) => a.getAttribute("href"))).toEqual(["/snapshots/8?base=main", "/snapshots/7"]);
  });

  it("says when the repository does not exist", async () => {
    server.use(http.get(`${API}/repos/1`, () => HttpResponse.json({ detail: "Repository 1 not found" }, { status: 404 })));
    open();
    expect(await screen.findByText("Repository not found")).toBeInTheDocument();
  });

  it("asks before deleting", async () => {
    let deleted = false;
    server.use(
      http.delete(`${API}/repos/1`, () => {
        deleted = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = open();
    await user.click(await screen.findByRole("button", { name: "Delete repository" }));
    expect(deleted).toBe(false);
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(await screen.findByText("navigated away")).toBeInTheDocument();
    expect(deleted).toBe(true);
  });
});
