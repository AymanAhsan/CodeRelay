import { UserButton, useAuth } from "@clerk/react";
import { LogInIcon, MailIcon } from "lucide-react";

import {
  hasAccountPublicConfig,
  hasCloudPublicConfig,
  hasCodeRelayAccounts,
} from "../../cloud/publicConfig";
import { CodeRelayAccount } from "./CodeRelayAccount";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { T3_CONNECT_ACCOUNT_PAGES } from "./T3ConnectAccountPages";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarSignIn() {
  if (!hasAccountPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectSidebarAvatar() {
  if (!hasAccountPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarAvatar />;
}

function ConfiguredT3ConnectSidebarAvatar() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      {hasCodeRelayAccounts() ? (
        <UserButton.UserProfilePage
          label="CodeRelay Cloud"
          url="coderelay-cloud"
          labelIcon={<MailIcon className="size-4" />}
        >
          <CodeRelayAccount />
        </UserButton.UserProfilePage>
      ) : null}
      {(hasCloudPublicConfig() ? T3_CONNECT_ACCOUNT_PAGES : []).map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={page.label}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();

  if (!isLoaded || isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>{hasCodeRelayAccounts() ? "Sign in to CodeRelay" : "Sign in to CodeRelay Connect"}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}
