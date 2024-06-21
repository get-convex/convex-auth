import { ConvexAuthProvider } from "@xixixao/convex-auth/react";
import {
  AuthLoading,
  Authenticated,
  ConvexReactClient,
  Unauthenticated,
} from "convex/react";
import { useMemo } from "react";

export function App() {
  const client = useMemo(
    () => new ConvexReactClient(process.env.CONVEX_URL!),
    [],
  );
  return (
    <ConvexAuthProvider client={client}>
      <AuthLoading>loading</AuthLoading>
      <Unauthenticated>unauthenticated</Unauthenticated>
      <Authenticated>authenticated</Authenticated>
    </ConvexAuthProvider>
  );
}
