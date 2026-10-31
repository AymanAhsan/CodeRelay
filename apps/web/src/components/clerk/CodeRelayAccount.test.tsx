// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  user: {
    id: "user-a",
    unsafeMetadata: {} as Record<string, unknown>,
    primaryEmailAddress: { emailAddress: "early@example.com" },
  },
}));
vi.mock("@clerk/react", () => ({
  useUser: () => ({ isLoaded: true, user: { ...mocks.user, updateMetadata: mocks.update } }),
}));
vi.mock("./useT3ConnectAuthPrompt", () => ({
  useT3ConnectAuthPrompt: () => ({ openAuthPrompt: vi.fn() }),
}));

import { CodeRelayAccount } from "./CodeRelayAccount";

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  mocks.user.id = "user-a";
  mocks.user.unsafeMetadata = {};
  mocks.update.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<CodeRelayAccount />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function saveButton() {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Save email preference",
  )!;
}

it("does not subscribe on sign-in, persists an explicit choice, and allows retry after failure", async () => {
  expect(mocks.update).not.toHaveBeenCalled();
  expect(saveButton().disabled).toBe(true);
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  mocks.update.mockRejectedValueOnce(new Error("offline"));
  await act(async () => saveButton().click());
  expect(container.textContent).toContain("Could not save");
  expect(saveButton().disabled).toBe(false);
  mocks.update.mockImplementationOnce(async ({ unsafeMetadata }) => {
    mocks.user.unsafeMetadata = unsafeMetadata;
  });
  await act(async () => saveButton().click());
  expect(container.textContent).toContain("Email preference saved");
  expect(mocks.user.unsafeMetadata).toMatchObject({ codeRelayCloud: { updatesOptIn: true } });
});

it("saves withdrawal and discards an unsaved preference when accounts change", async () => {
  mocks.user.unsafeMetadata = { codeRelayCloud: { updatesOptIn: true } };
  await act(async () => root.render(<CodeRelayAccount />));
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  mocks.update.mockResolvedValueOnce(undefined);
  await act(async () => saveButton().click());
  expect(mocks.update).toHaveBeenCalledWith({
    unsafeMetadata: expect.objectContaining({
      codeRelayCloud: expect.objectContaining({ updatesOptIn: false }),
    }),
  });
  await act(async () => (container.querySelector('[role="checkbox"]') as HTMLElement).click());
  mocks.user.id = "user-b";
  mocks.user.unsafeMetadata = {};
  await act(async () => root.render(<CodeRelayAccount />));
  expect(saveButton().disabled).toBe(true);
  expect(container.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
});
