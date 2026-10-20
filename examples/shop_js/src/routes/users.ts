import { Router, type Request, type Response } from "express";
import { createToken, currentUser } from "../auth";

export const usersRouter = Router();

export function me(req: Request, res: Response): void {
  res.json({ userId: currentUser(req.headers.authorization) });
}

usersRouter.post("/users/login", (req, res) => {
  res.json({ token: createToken(Number(req.body.userId)) });
});

usersRouter.get("/users/me", me);
