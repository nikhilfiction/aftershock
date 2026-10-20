import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createToken } from "../src/auth";
import { sent } from "../src/services/hooks";
import { orderTotal } from "../src/services/pricing";

const ITEMS = [{ price: 10, qty: 2 }, { price: 5, qty: 1 }];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function placeOrder(userId: number) {
  return fetch(`${base}/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${createToken(userId)}`, "content-type": "application/json" },
    body: JSON.stringify({ items: ITEMS }),
  });
}

describe("pricing", () => {
  it("applies the discount", () => {
    expect(orderTotal(ITEMS)).toBe(22.5);
  });
});

describe("orders", () => {
  it("sends a receipt when an order is placed", async () => {
    const order = await (await placeOrder(7)).json();
    expect(order.total).toBe(22.5);
    expect(sent).toContain(order.id);
  });

  it("lists only my orders", async () => {
    await placeOrder(8);
    const res = await fetch(`${base}/orders`, { headers: { authorization: `Bearer ${createToken(8)}` } });
    const orders = await res.json();
    expect(orders.every((o: { userId: number }) => o.userId === 8)).toBe(true);
  });
});
