import express from "express";
import "./services/hooks";
import { ordersRouter } from "./routes/orders";
import { usersRouter } from "./routes/users";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(usersRouter);
  app.use(ordersRouter);
  return app;
}
