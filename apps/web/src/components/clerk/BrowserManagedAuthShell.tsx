import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";
import { hasCloudPublicConfig, hasCodeRelayAccounts } from "../../cloud/publicConfig";
import { RequireCodeRelaySignIn } from "./RequireCodeRelaySignIn";

/**
 * Browser half of the managed-auth boundary, loaded lazily from the entry so
 * cloudless local mode never downloads a Clerk runtime. The browser provider
 * stays small on its own: it hotloads clerk-js at runtime instead of bundling
 * it.
 */
export default function BrowserManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  const gated = hasCodeRelayAccounts() ? (
    <RequireCodeRelaySignIn>{children}</RequireCodeRelaySignIn>
  ) : (
    children
  );

  return (
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
      {hasCloudPublicConfig() ? (
        <ManagedRelayAuthProvider>{gated}</ManagedRelayAuthProvider>
      ) : (
        gated
      )}
    </ClerkProvider>
  );
}
