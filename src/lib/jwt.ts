import jwt from "jsonwebtoken";

export type JwtPayload = { sub: string };

export function signUserToken(userId: string, secret: string): string {
  return jwt.sign({ sub: userId } satisfies JwtPayload, secret, {
    expiresIn: "7d",
    algorithm: "HS256",
  });
}

export function verifyUserToken(token: string, secret: string): JwtPayload {
  const decoded = jwt.verify(token, secret) as JwtPayload;
  if (!decoded?.sub || typeof decoded.sub !== "string") {
    throw new Error("Invalid token payload");
  }
  return decoded;
}
