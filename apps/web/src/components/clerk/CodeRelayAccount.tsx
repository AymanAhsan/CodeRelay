import { useUser } from "@clerk/react";
import {
  CLOUD_UPDATES_LABEL,
  cloudUpdatesMetadata,
  readsCloudUpdatesPreference,
} from "@t3tools/client-runtime/cloud-account";
import { useState } from "react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ClerkUserProfilePage } from "./ClerkUserProfilePage";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function CodeRelayAccount() {
  const { user, isLoaded } = useUser();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();

  return (
    <ClerkUserProfilePage
      title={user ? "Your CodeRelay account" : "Create your CodeRelay account"}
      description="Create an account now for future CodeRelay Cloud access. Cloud hosting is not available yet."
    >
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Accounts are optional. Your projects and conversations stay on your environment; creating
          an account does not upload them.
        </p>
        {user ? (
          <CodeRelayAccountPreferences key={user.id} />
        ) : (
          <Button disabled={!isLoaded} onClick={openAuthPrompt}>
            {isLoaded ? "Create account or sign in" : "Loading sign-in…"}
          </Button>
        )}
      </div>
    </ClerkUserProfilePage>
  );
}

function CodeRelayAccountPreferences() {
  const { user } = useUser();
  const savedPreference = readsCloudUpdatesPreference(user?.unsafeMetadata ?? {});
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const checked = draft ?? savedPreference;

  const save = async () => {
    if (!user || saving) return;
    setSaving(true);
    setStatus("");
    setFailed(false);
    try {
      await user.updateMetadata({ unsafeMetadata: cloudUpdatesMetadata(checked) });
      setDraft(null);
      setStatus("Email preference saved.");
    } catch {
      setFailed(true);
      setStatus("Could not save your preference. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">{user?.primaryEmailAddress?.emailAddress ?? "Signed in"}</p>
      <label className="flex items-start gap-3 text-sm">
        <Checkbox
          checked={checked}
          disabled={saving}
          onCheckedChange={(value) => {
            setDraft(value);
            setStatus("");
          }}
        />
        <span>{CLOUD_UPDATES_LABEL}</span>
      </label>
      <p className="text-xs text-muted-foreground">
        Optional. You can turn this off here at any time. Signing in does not subscribe you.
      </p>
      <Button disabled={saving || draft === null} onClick={() => void save()}>
        {saving ? "Saving…" : "Save email preference"}
      </Button>
      {status ? (
        <p role={failed ? "alert" : "status"} className="text-sm">
          {status}
        </p>
      ) : null}
    </div>
  );
}
