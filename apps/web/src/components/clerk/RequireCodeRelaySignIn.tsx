import { useAuth } from "@clerk/react";
import { useEffect, type ReactNode } from "react";

import { isElectron } from "../../env";
import { Button } from "../ui/button";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

/**
 * Builds with CodeRelay accounts require a signed-in Clerk session before the
 * app renders. Clerk persists the session, so signed-in users go straight in;
 * signing out from the account menu brings this screen back.
 *
 * It opens Clerk's sign-in modal rather than embedding <SignIn />: the embedded
 * form needs hash or path routing, which would fight the desktop hash router.
 */
export function RequireCodeRelaySignIn({ children }: { readonly children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (isLoaded && isSignedIn) return children;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8">
      {/* The frameless desktop window still needs a titlebar to drag. */}
      {isElectron ? (
        <div className="drag-region fixed inset-x-0 top-0 h-[var(--workspace-topbar-height)]" />
      ) : null}
      {isLoaded ? (
        <SignInPrompt />
      ) : (
        <p className="text-sm text-muted-foreground">Loading sign-in…</p>
      )}
    </main>
  );
}

function SignInPrompt() {
  const { openAuthPrompt } = useT3ConnectAuthPrompt();

  // Open once when the signed-out screen appears; the button reopens it if closed.
  useEffect(openAuthPrompt, []);

  return (
    <div className="flex max-w-sm flex-col items-center gap-4 text-center">
      <h1 className="text-lg font-semibold">Sign in to CodeRelay</h1>
      <p className="text-sm text-muted-foreground">
        Sign in or create an account to continue. Your projects and conversations stay on your
        environment.
      </p>
      <Button onClick={openAuthPrompt}>Sign in</Button>
    </div>
  );
}
