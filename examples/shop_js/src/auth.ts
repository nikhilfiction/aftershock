import { settings } from "./config";

export function createToken(userId: number): string {
  return Buffer.from(JSON.stringify({ userId, secret: settings.jwtSecret })).toString("base64");
}

export function decodeToken(token: string): number {
  const payload = JSON.parse(Buffer.from(token, "base64").toString());
  if (payload.secret !== settings.jwtSecret) {
    throw new Error("bad token");
  }
  return payload.userId;
}

export function currentUser(header: string | undefined): number {
  return decodeToken((header ?? "").replace("Bearer ", ""));
}
