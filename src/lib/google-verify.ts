import { OAuth2Client } from "google-auth-library";

export type GoogleIdTokenPayload = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

export async function verifyGoogleIdToken(
  credential: string,
  audience: string,
): Promise<GoogleIdTokenPayload> {
  const allowTestCredential =
    credential.startsWith("test:") &&
    (process.env.VITEST === "true" ||
      process.env.NODE_ENV === "development" ||
      process.env.USE_PGLITE === "1");
  if (allowTestCredential) {
    const sub = credential.slice("test:".length);
    return {
      sub,
      email: `${sub}@test.local`,
      name: "Test User",
      picture: undefined,
    };
  }

  if (!audience) {
    throw new Error("GOOGLE_CLIENT_ID is not configured");
  }

  const client = new OAuth2Client(audience);
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new Error("Invalid Google token");
  }
  return {
    sub: payload.sub,
    email: payload.email ?? undefined,
    name: payload.name ?? undefined,
    picture: payload.picture ?? undefined,
  };
}
