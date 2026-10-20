import { screen, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import ReposPage from "../pages/ReposPage";
import { repoDetail } from "./fixtures";
import { renderAt } from "./render";
import { API, server } from "./server";

const open = () => renderAt("/", "/", <ReposPage />);

describe("Repositories page", () => {
  it("shows a loading state, then the repositories", async () => {
    open();
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "shop_api" })).toHaveAttribute("href", "/repos/1");
  });

  it("explains the public demo only on the demo", async () => {
    open();
    await screen.findByRole("link", { name: "shop_api" });
    expect(screen.queryByRole("note")).not.toBeInTheDocument();

    server.use(
      http.get(`${API}/health`, () => HttpResponse.json({ ok: true, queue: "in-process", demo: true })),
    );
    open();
    expect(await screen.findByRole("note")).toHaveTextContent(/This is a live demo/);
  });

  it("shows each repository's scans and can scan it again", async () => {
    let body: unknown;
    server.use(
      http.post(`${API}/repos/1/scan`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ snapshot: { id: 9 }, queue: "in-process" }, { status: 202 });
      }),
    );
    const { user } = open();
    expect(await screen.findByText("4 API ROUTES")).toBeInTheDocument(); // from the latest ready scan's counts
    const card = within(screen.getByRole("listitem"));
    expect(card.getByText("Ready")).toBeInTheDocument();
    expect(card.getByText("with runtime data")).toBeInTheDocument();
    expect(card.getByText("Call graph + pytest trace")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Rescan" }));
    expect(body).toEqual({ ref: "main", dynamic: true });
  });

  it("has an account button that explains there is nothing to sign in to", async () => {
    const { user } = open();
    const button = screen.getByRole("button", { name: "Account" });
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Account" })).toHaveTextContent("nothing to sign in to");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Account" })).not.toBeInTheDocument();
  });

  it("explains what to do when there are none", async () => {
    server.use(http.get(`${API}/repos`, () => HttpResponse.json([])));
    open();
    expect(await screen.findByText("No repositories yet")).toBeInTheDocument();
  });

  it("offers a retry when the API is down, and recovers", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/repos`, () => (++calls === 1 ? HttpResponse.error() : HttpResponse.json([repoDetail]))),
    );
    const { user } = open();
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach the API");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "shop_api" })).toBeInTheDocument();
  });

  it("shows the API's validation error on the URL field and keeps the input", async () => {
    server.use(
      http.post(`${API}/repos`, () =>
        HttpResponse.json(
          { detail: [{ loc: ["body", "url"], msg: "Repository must be an https:// git URL or a folder on this machine" }] },
          { status: 422 },
        ),
      ),
    );
    const { user } = open();
    const url = screen.getByLabelText("Git URL or folder path");
    await user.type(url, "http://insecure.example/repo.git");
    await user.click(screen.getByRole("button", { name: "Add repository" }));

    const error = await screen.findByText(/must be an https:\/\/ git URL/);
    expect(url).toHaveAttribute("aria-invalid", "true");
    expect(url.getAttribute("aria-describedby")).toContain(error.id);
    expect(url).toHaveValue("http://insecure.example/repo.git");
  });

  it("sends only one request when the button is clicked twice", async () => {
    let posts = 0;
    server.use(
      http.post(`${API}/repos`, async () => {
        posts++;
        await delay(150);
        return HttpResponse.json(repoDetail, { status: 201 });
      }),
    );
    const { user } = open();
    await user.type(screen.getByLabelText("Git URL or folder path"), "https://github.com/acme/shop.git");
    const button = screen.getByRole("button", { name: "Add repository" });
    await user.dblClick(button);
    expect(await screen.findByText("navigated away")).toBeInTheDocument(); // went to the new repo
    expect(posts).toBe(1);
  });
});
