export interface Item {
  price: number;
  qty: number;
}

export interface Order {
  id: number;
  userId: number;
  items: Item[];
  total: number;
}

export class OrderStore {
  private rows: Order[] = [];

  insert(row: Omit<Order, "id">): Order {
    const order = { ...row, id: this.rows.length + 1 };
    this.rows.push(order);
    return order;
  }

  forUser(userId: number): Order[] {
    return this.rows.filter((o) => o.userId === userId);
  }
}

export const store = new OrderStore();
