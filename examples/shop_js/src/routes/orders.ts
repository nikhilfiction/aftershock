import { Router } from "express";
import { currentUser } from "../auth";
import { createOrder, listOrders } from "../services/orders";

export const ordersRouter = Router();

ordersRouter.post("/orders", (req, res) => {
  const userId = currentUser(req.headers.authorization);
  res.status(201).json(createOrder(userId, req.body.items));
});

ordersRouter.get("/orders", (req, res) => {
  res.json(listOrders(currentUser(req.headers.authorization)));
});
