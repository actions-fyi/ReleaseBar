# Privacy policy

> **Draft.** The entries marked `TODO` are the operator's to fill in, and the text has not been reviewed by a lawyer. Do not link to it as the policy of a live deployment before both are done.

This policy covers the ReleaseBar deployment at `releasebar.actions.fyi`. Someone who runs their own deployment is the controller of that deployment and needs a policy of their own; the sections "What is stored" and "How long" describe what the software does anywhere.

## Who is responsible

- Controller: `TODO: name and postal address of the person or company that runs releasebar.actions.fyi`
- Contact for privacy requests: `TODO: email address`

## What ReleaseBar is

ReleaseBar shows release health for public GitHub repositories. It reads public data through the GitHub API and shows it as a dashboard for an account or a repository. Signing in with GitHub and installing the ReleaseBar GitHub App are optional.

## What is stored

### Without signing in

| Data                                                                                                                                                                                                                    | Where it comes from                   | Why                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| Public GitHub data about the accounts and repositories a dashboard shows: names, descriptions, releases, issue and pull request counts, CI state, public activity, public stargazers and contributors, avatar addresses | The GitHub API                        | To show the dashboard without asking GitHub on every visit                                |
| Signals computed from that public data: an account's age, reach and footprint ("trust profile"), and a summary of a repository's recent stargazers                                                                      | Computed by ReleaseBar                | To give context on an owner or a repository; no decision about a person is made from them |
| Which dashboards were opened and when (the dashboard's address, not who opened it)                                                                                                                                      | Your request                          | To keep recently opened dashboards fresh                                                  |
| Page load timings your browser reports, without an identifier                                                                                                                                                           | Your browser                          | To find slow pages                                                                        |
| A counter per client and minute, keyed by a truncated hash of the IP address                                                                                                                                            | Your request                          | To limit requests to two endpoints                                                        |
| Theme, hidden owners and repositories, custom sources                                                                                                                                                                   | Stays in your browser's local storage | To remember your view                                                                     |

Private repositories are never shown. A repository that turns private or is deleted is removed from dashboards and caches when GitHub reports it (see "Public data and removal").

### When you sign in with GitHub

| Data                                                                                                                                                    | Why                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Your GitHub user id, login, display name, avatar and profile address                                                                                    | To show who is signed in and which dashboards are yours  |
| The access token and refresh token GitHub issues for you                                                                                                | To ask GitHub which installations of the app you can use |
| The list of ReleaseBar installations you can use                                                                                                        | To decide which dashboards get the app's own API quota   |
| A session cookie, `rd_session`, that points to the above; short-lived cookies during sign-in and installation (`rd_oauth_state_*`, `rd_install_return`) | To keep you signed in and to protect the sign-in         |
| Sign-in and installation events: time, step, account login, installation id, outcome                                                                    | To see where sign-in fails                               |
| A counter of the AI summaries you started in the current hour, by user id                                                                               | To limit their cost                                      |

ReleaseBar stores no email address, and of the repositories an installation covers only the names of the public ones.

### When you save a dashboard profile

The owners and repositories your dashboard adds or hides, when it was saved and by which login. A profile is public: it decides what everyone sees at your dashboard's address.

### When the GitHub App is installed on an account

The installation id, the account's login, type, avatar and address, whether it covers all or selected repositories, and the names of the public repositories it covers. An installation token, valid for under an hour, is cached while it is in use.

## Legal basis

`TODO: confirm with counsel.` The intended bases under the GDPR are:

- Sign-in, sessions, profiles and installations: performance of the service you asked for (Art. 6(1)(b)).
- Showing public GitHub data, keeping dashboards fresh, request limits, timings and the event logs: legitimate interests (Art. 6(1)(f)) in offering a public release dashboard and in keeping it working and secure.

## How long

| Data                                                               | Kept for                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Session with its tokens                                            | 30 days, or until you log out, revoke the authorization or delete the account        |
| Dashboard profile                                                  | Until you reset it or delete the account                                             |
| Snapshots of a profile, and the record that a dashboard was opened | 90 days after it was last used                                                       |
| Installation                                                       | Until the app is uninstalled; at the latest 90 days after it was last confirmed      |
| Installation token                                                 | 50 minutes                                                                           |
| Sign-in and installation events                                    | 90 days                                                                              |
| Refresh and GitHub access logs, page timings                       | 14 days                                                                              |
| Cached public GitHub data and the signals computed from it         | Up to 90 days, depending on the kind; it is fetched again when a dashboard is opened |
| Request counters                                                   | About two minutes; the AI summary counter one hour                                   |

## Who receives data

- **Cloudflare** hosts the service. All stored data is in Cloudflare's EU jurisdiction. Cloudflare processes your IP address to deliver the pages. The request logs that would hold IP addresses and headers are switched off for ReleaseBar, and query strings are removed from its logs and traces.
- **GitHub** receives the API requests that fetch public data, and handles sign-in and installation.
- **Anthropic** receives public activity and commit titles of public repositories when an AI summary is generated. No session or account data is sent.

`TODO: name the contracts in place (data processing agreements, transfer mechanism for processing outside the EU) and whether AI summaries are enabled on this deployment.`

## Your choices

- **Log out**: deletes the session and its tokens.
- **Delete Account** (account menu, or `DELETE /api/me`): deletes every session of yours with its tokens, your dashboard profile with its snapshots and the dashboards built from it, the installation record of your own account, and your sign-in events. The logs of the last 14 days are not searched; they expire.
- **Revoke the authorization** (GitHub: Settings → Applications → Authorized GitHub Apps): GitHub tells ReleaseBar, which deletes every session of yours.
- **Uninstall the app** (GitHub: Settings → Applications → Installed GitHub Apps): GitHub tells ReleaseBar, which deletes the installation record and its token.

Deleting the account does not uninstall the app or revoke the authorization: only you can do that on GitHub. While the app stays installed, ReleaseBar learns of the installation again the next time a dashboard of that account is built.

## Public data and removal

A dashboard exists for every public GitHub account, whether its owner uses ReleaseBar or not, and shows only what GitHub publishes. Deleting your ReleaseBar account does not remove it.

- A repository you delete or make private disappears from ReleaseBar when GitHub reports the change (accounts with the app installed) or the next time its dashboard is refreshed, and from every cache within the times above.
- To have the public data of your account removed, or kept from being shown, write to the contact above. `TODO: describe how such a request is carried out; the software has no block list yet.`

## Your rights

Under the GDPR you may ask for access to your data, its correction, its deletion, the restriction of its processing and a copy in a portable format, and you may object to processing that rests on legitimate interests. Write to the contact above. You may also complain to a supervisory authority: `TODO: name the competent authority`.

## Changes

This file's history in the repository shows every change to this policy.
