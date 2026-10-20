import { store, type Item, type Order } from "../db";
import { events } from "./events";
import { orderTotal } from "./pricing";

export function createOrder(userId: number, items: Item[]): Order {
  const order = store.insert({ userId, items, total: orderTotal(items) });
  events.emit("order:placed", order);
  return order;
}

export function listOrders(userId: number): Order[] {
  return store.forUser(userId);
}
