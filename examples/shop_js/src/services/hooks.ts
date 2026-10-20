import type { Order } from "../db";
import { events } from "./events";

export const sent: number[] = [];

export function sendReceipt(order: Order): void {
  sent.push(order.id);
}

// Nothing calls sendReceipt directly: the event bus does, when an order is
// placed. This is the hidden dependency that tracing the tests finds.
events.on("order:placed", sendReceipt);
