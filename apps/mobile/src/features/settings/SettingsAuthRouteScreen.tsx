import { useAuth } from "@clerk/expo";
import { AuthView, type UserProfileCustomPage, UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";

import {
  hasAccountPublicConfig,
  hasCloudPublicConfig,
  hasCodeRelayAccounts,
} from "../cloud/publicConfig";
import { CodeRelayAccount } from "../cloud/CodeRelayAccount";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";

// Custom rows in Clerk's native profile. Mirrors the web UserButton pages.
const USER_PROFILE_CUSTOM_PAGES = [
  {
    path: "t3-connect",
    label: "CodeRelay Connect",
    icon: "globe",
    content: <T3ConnectProfilePage />,
  },
] satisfies UserProfileCustomPage[];

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    if (!hasAccountPublicConfig()) {
      navigation.dispatch(StackActions.replace("SettingsContent"));
    }
  }, [navigation]);

  return hasAccountPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const [authStarted, setAuthStarted] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const customPages: UserProfileCustomPage[] = [
    ...(hasCodeRelayAccounts()
      ? [
          {
            path: "coderelay-cloud",
            label: "CodeRelay Cloud",
            icon: "globe" as const,
            content: <CodeRelayAccount />,
          },
        ]
      : []),
    ...(hasCloudPublicConfig() ? USER_PROFILE_CUSTOM_PAGES : []),
  ];
  const handleHostBack = useCallback(
    () => navigation.dispatch(StackActions.popTo("SettingsContent")),
    [navigation],
  );
  const hasBeenSignedIn = useRef(isSignedIn);
  if (isSignedIn) {
    hasBeenSignedIn.current = true;
  }

  useEffect(() => {
    if (hasBeenSignedIn.current && isLoaded && isSignedIn === false) {
      navigation.dispatch(StackActions.popTo("SettingsContent"));
    }
  }, [isLoaded, isSignedIn, navigation]);

  if (isLoaded && hasCodeRelayAccounts() && (isSignedIn ? !showProfile : !authStarted)) {
    return (
      <CodeRelayAccount
        onSignIn={() => setAuthStarted(true)}
        onManageAccount={() => setShowProfile(true)}
        onContinue={handleHostBack}
      />
    );
  }

  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
      {isLoaded ? (
        hasBeenSignedIn.current ? (
          <UserProfileView
            customPages={customPages}
            isDismissible={false}
            onHostBack={handleHostBack}
          />
        ) : (
          <AuthView isDismissible={false} onHostBack={handleHostBack} />
        )
      ) : null}
    </View>
  );
}
