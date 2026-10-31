import { useUser } from "@clerk/expo";
import {
  CLOUD_UPDATES_LABEL,
  cloudUpdatesMetadata,
  readsCloudUpdatesPreference,
} from "@t3tools/client-runtime/cloud-account";
import { useState } from "react";
import { ScrollView, Switch, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";

export function CodeRelayAccount({
  onSignIn,
  onContinue,
  onManageAccount,
}: {
  readonly onSignIn?: () => void;
  readonly onContinue?: () => void;
  readonly onManageAccount?: () => void;
}) {
  const { user, isLoaded } = useUser();
  return (
    <ScrollView contentContainerClassName="gap-5 p-6" className="flex-1 bg-sheet">
      <Text className="text-2xl font-t3-semibold text-foreground">
        {user ? "Your CodeRelay account" : "Create your CodeRelay account"}
      </Text>
      <Text className="text-base text-foreground-muted">
        Create an account now for future CodeRelay Cloud access. Cloud hosting is not available yet.
        Accounts are optional. Creating an account does not upload your projects or conversations.
      </Text>
      {user ? (
        <AccountPreferences key={user.id} />
      ) : (
        <ControlPill
          label="Create account or sign in"
          variant="primary"
          disabled={!isLoaded}
          onPress={onSignIn}
        />
      )}
      {user && onManageAccount ? (
        <ControlPill label="Manage account" variant="pill" onPress={onManageAccount} />
      ) : null}
      {onContinue ? (
        <ControlPill label="Continue without cloud" variant="pill" onPress={onContinue} />
      ) : null}
    </ScrollView>
  );
}

function AccountPreferences() {
  const { user } = useUser();
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const checked = draft ?? readsCloudUpdatesPreference(user?.unsafeMetadata ?? {});

  const save = async () => {
    if (!user || saving) return;
    setSaving(true);
    setStatus("");
    try {
      await user.updateMetadata({ unsafeMetadata: cloudUpdatesMetadata(checked) });
      setDraft(null);
      setStatus("Email preference saved.");
    } catch {
      setStatus("Could not save your preference. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View className="gap-4">
      <Text className="text-base text-foreground">
        {user?.primaryEmailAddress?.emailAddress ?? "Signed in"}
      </Text>
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-base text-foreground">{CLOUD_UPDATES_LABEL}</Text>
        <Switch
          accessibilityLabel={CLOUD_UPDATES_LABEL}
          value={checked}
          disabled={saving}
          onValueChange={(value) => {
            setDraft(value);
            setStatus("");
          }}
        />
      </View>
      <Text className="text-sm text-foreground-muted">
        Optional. You can turn this off here at any time. Signing in does not subscribe you.
      </Text>
      <ControlPill
        label={saving ? "Saving…" : "Save email preference"}
        variant="primary"
        disabled={saving || draft === null}
        onPress={() => void save()}
      />
      {status ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
          {status}
        </Text>
      ) : null}
    </View>
  );
}
