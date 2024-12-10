import { isAuthenticatedNextjs } from "../../../dist/nextjs/server/index.js";

export async function GET() {
  const isAuthenticated = await isAuthenticatedNextjs();
  return Response.json(
    { someData: isAuthenticated },
    { status: isAuthenticated ? 200 : 403 },
  );
}
