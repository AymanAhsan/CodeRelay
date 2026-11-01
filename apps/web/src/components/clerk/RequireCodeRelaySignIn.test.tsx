// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  auth: { isLoaded: false, isSignedIn: false },
  openAuthPrompt: vi.fn(),
}));
vi.mock("@clerk/react", () => ({ useAuth: () => mocks.auth }));
vi.mock("./useT3ConnectAuthPrompt", () => ({
  useT3ConnectAuthPrompt: () => ({ openAuthPrompt: mocks.openAuthPrompt }),
}));

import { RequireCodeRelaySignIn } from "./RequireCodeRelaySignIn";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mocks.openAuthPrompt.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(state: { isLoaded: boolean; isSignedIn: boolean }) {
  Object.assign(mocks.auth, state);
  await act(async () =>
    root.render(
      <RequireCodeRelaySignIn>
        <div>app</div>
      </RequireCodeRelaySignIn>,
    ),
  );
  return container.textContent ?? "";
}

it("keeps the app hidden and prompts sign-in until a Clerk session exists", async () => {
  expect(await render({ isLoaded: false, isSignedIn: false })).toBe("Loading sign-in…");
  expect(mocks.openAuthPrompt).not.toHaveBeenCalled();

  expect(await render({ isLoaded: true, isSignedIn: false })).not.toContain("app");
  expect(mocks.openAuthPrompt).toHaveBeenCalledTimes(1);

  expect(await render({ isLoaded: true, isSignedIn: true })).toBe("app");
});

it("prompts again after signing out", async () => {
  await render({ isLoaded: true, isSignedIn: true });
  expect(mocks.openAuthPrompt).not.toHaveBeenCalled();

  expect(await render({ isLoaded: true, isSignedIn: false })).toContain("Sign in to CodeRelay");
  expect(mocks.openAuthPrompt).toHaveBeenCalledTimes(1);
});
