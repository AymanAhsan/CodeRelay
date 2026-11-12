# CodeRelay accounts

CodeRelay can collect optional accounts before a cloud service is available. It uses
Clerk for email verification, social sign-in, account deletion, and sessions. No
cloud database or Clerk secret key is needed in the app.

## Configure your build

Create your own Clerk application. Enable email sign-in and the social providers you
want in its dashboard; production providers require your own OAuth credentials.
Configure the app name, privacy policy, terms, permitted origins, and redirect URLs
for your deployment. Desktop and mobile builds also need their native redirect and
passkey configuration, as with the existing Clerk integration.

Set these in the root `.env.local` or build environment:

```dotenv
CODERELAY_ACCOUNTS=1
T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_your_own_key
```

Remove the upstream relay URL, JWT template, and CLI OAuth client ID from your root
env files and build environment, including any `VITE_` or `EXPO_PUBLIC_` aliases.
The example env file contains T3's service configuration; do not use it for your
own accounts. Empty overrides do not mask nonempty values in other env files.
Build configuration rejects CodeRelay account mode with the known T3 Clerk domain
or T3 relay. Rebuild web, desktop, and mobile after changing configuration.

With only your Clerk key, account sign-in is available but relay features stay
disabled. `CODERELAY_ACCOUNTS=1` makes web and desktop require a signed-in Clerk
session before the app renders, and adds CodeRelay account preferences on all
clients. Mobile does not require sign-in; it exposes the introduction through
Settings → CodeRelay account. Without a key, local mode loads no Clerk provider.
Setting the flag to `0` removes the sign-in requirement and early-access onboarding.

The published desktop installers (`desktop-latest.yml`) read the key from
the `CLERK_PUBLISHABLE_KEY` repository variable and fails if it is missing, since
the key is baked into the bundle at build time.

## User data and email preferences

Clerk stores the user's ID, verified email addresses, and linked login identities.
The app does not copy emails into environment SQLite databases or upload projects,
conversations, or coding-provider credentials when an account is created.

After signing in, users can explicitly save an email-updates preference. It defaults
to off and can be withdrawn in the same account page. The preference is stored in
`user.unsafeMetadata.codeRelayCloud`, with `updatesOptIn`, `updatedAt`, `wordingVersion`,
and `wording`. Clerk's metadata merge preserves unrelated fields.

This is deliberately user-editable preference data; timestamps are client-reported.
It is not a trusted consent audit, billing entitlement, or authorization record.
If an auditable consent history becomes necessary, record events in a hosted
service with server timestamps. Never put a Clerk secret key in a client or require
every local environment to have one just to update a preference.

Use Clerk's dashboard or Backend API from trusted operator tooling to retrieve
accounts. Before sending announcements, select only explicitly opted-in accounts
with a verified primary email, honor your email service's unsubscribe/suppression
list, and include an unsubscribe link. Account creation alone is not a mailing-list
subscription. This change does not send mail or provision an email service.

When adding a hosted backend, link its records to Clerk user IDs, not email addresses.
Keep cloud environment ownership and billing in that service's database.
