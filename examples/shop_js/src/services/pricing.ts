import type { Item } from "../db";
import { settings } from "../config";

export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function applyDiscount(amount: number): number {
  return Math.round(amount * (1 - settings.discountRate) * 100) / 100;
}

export const orderTotal = (items: Item[]): number => applyDiscount(subtotal(items));
