# Releasing Zenbook

A step-by-step guide to publishing Zenbook so anyone can download it, and to shipping
updates afterwards. You only need to do Part 1 once. Part 2 is what you repeat for every
new version.

Everything is already set up in the repo:

- `.github/workflows/ci.yml` tests every push on Windows, macOS and Linux.
- `.github/workflows/release.yml` builds the installers when you push a version tag.
- The app checks GitHub Releases for updates on its own.

---

## Part 1: One-time setup

### 1. Push the code and make the repo public

```sh
git push -u origin main
```

Then on GitHub: **Settings → General → Danger Zone → Change visibility → Public**.

The repo must be public. People download from its Releases page, and the app checks the
same page for updates. A private repo would need a token inside the app.

### 2. Check that CI passes

Open the **Actions** tab. The **CI** workflow runs on Windows, macOS and Ubuntu. Wait for
three green ticks (about 10 minutes).

If one fails, open it, click the red step and read the error. The most likely culprits on
the first run are the end-to-end tests on macOS or Linux, which have never run before.
Fix them before releasing (or ask Claude, pasting the failed step's log).

### 3. Allow the release workflow to publish

**Settings → Actions → General → Workflow permissions** → choose
**Read and write permissions** → **Save**.

(The workflow also asks for this itself, but some accounts block it by default.)

---

## Part 2: Every release

### 1. Make sure `main` is ready

- Everything you want in the release is committed and pushed.
- CI on `main` is green.

### 2. Pick the version and tag it

Zenbook uses version numbers like `0.1.0` (major.minor.patch):

| Change               | Command             | Example       |
| -------------------- | ------------------- | ------------- |
| Bug fixes only       | `npm version patch` | 0.1.0 → 0.1.1 |
| New features         | `npm version minor` | 0.1.1 → 0.2.0 |
| Big, breaking change | `npm version major` | 0.2.0 → 1.0.0 |

`npm version` updates `package.json`, commits it and creates a tag such as `v0.1.1`.
Then push the commit and the tag together:

```sh
npm version patch
git push --follow-tags
```

**For the very first release**, `package.json` already says `0.1.0`, so just tag it:

```sh
git tag v0.1.0
git push origin v0.1.0
```

### 3. Wait for the builds

In **Actions**, the **Release** workflow starts automatically (about 15–25 minutes). Each
OS builds its installers and uploads them to one **draft** release:

| OS      | Files                                                                                     |
| ------- | ----------------------------------------------------------------------------------------- |
| Windows | `Zenbook-0.1.0-win-x64.exe`, `Zenbook-0.1.0-win-arm64.exe`                                |
| macOS   | `Zenbook-0.1.0-mac-arm64.dmg`, `Zenbook-0.1.0-mac-x64.dmg`, plus `.zip` files for updates |
| Linux   | `Zenbook-0.1.0-linux-x86_64.AppImage`, `Zenbook-0.1.0-linux-amd64.deb`                    |

It also uploads `latest.yml`, `latest-mac.yml` and `latest-linux.yml`. **Don't delete
these**: the app reads them to find updates.

### 4. Test the draft

Go to **Releases**. You'll see the draft (only you can see it). Download the installer for
your computer, install it and give it a quick try:

- It opens and offers to create your notebook folder.
- You can draw, write a note, switch pages and search with `Ctrl K`.
- Quit and reopen: everything is still there.

### 5. Write the notes and publish

On the draft, click **Edit**:

- Click **Generate release notes**. GitHub lists the commits since the last release; tidy
  them into a few plain sentences ("New: …", "Fixed: …").
- For early, unsigned releases, add the install warnings so people aren't alarmed:

  > Zenbook isn't code-signed yet, so your system will warn you the first time.
  > Windows: _More info → Run anyway_. macOS: open it once, then _System Settings →
  > Privacy & Security → Open Anyway_. Linux AppImage: `chmod +x` the file first.

- Click **Publish release**.

### 6. Updates reach people on their own

Within 6 hours (or 10 seconds after they next open the app), installed copies find the
new version:

- **Windows and Linux AppImage:** it downloads quietly, then a small **Restart to update**
  pill appears at the bottom of the sidebar.
- **macOS (until signed) and Linux `.deb`:** a pill says **0.1.1 available** and opens the
  download page.

**Testing this the first time:** install `v0.1.0`, publish `v0.1.1`, open the old app and
wait about 10 seconds. You can also force it with **… → Check for updates now**.

---

## Part 3: Code signing (do this before announcing widely)

Unsigned apps work, but people see scary warnings, and **Macs can't auto-update an
unsigned app**. Signing is optional until you want a wider audience. Once the secrets are
added, the next release is signed automatically; no code changes are needed.

Add secrets under **Settings → Secrets and variables → Actions → New repository secret**.
The names must match exactly.

### macOS: Apple Developer ID ($99 a year)

1. Join the [Apple Developer Program](https://developer.apple.com/programs/).
2. In Xcode or at [developer.apple.com](https://developer.apple.com/account/resources/certificates)
   create a **Developer ID Application** certificate.
3. On a Mac, open **Keychain Access**, find that certificate, right-click → **Export** as a
   `.p12` file with a password.
4. Turn the file into text: `base64 -i certificate.p12 | pbcopy` (copies it).
5. Create an **app-specific password** at [account.apple.com](https://account.apple.com)
   → Sign-In and Security → App-Specific Passwords.
6. Find your **Team ID** at [developer.apple.com/account](https://developer.apple.com/account)
   → Membership details.

| Secret                        | Value                          |
| ----------------------------- | ------------------------------ |
| `MAC_CERT_P12_BASE64`         | the base64 text from step 4    |
| `MAC_CERT_PASSWORD`           | the password you set in step 3 |
| `APPLE_ID`                    | your Apple ID email            |
| `APPLE_APP_SPECIFIC_PASSWORD` | the password from step 5       |
| `APPLE_TEAM_ID`               | the 10-character Team ID       |

With these set, the release workflow signs and notarises the Mac build, and Mac users get
automatic updates like everyone else.

### Windows: removing the SmartScreen warning

Pick one:

- **A code-signing certificate file (`.pfx`)**, for example Certum's Open Source Code
  Signing certificate (low cost for open-source developers). Export it as `.pfx`, run
  `certutil -encode certificate.pfx cert.txt` (on Windows) and add:

  | Secret                | Value                                                   |
  | --------------------- | ------------------------------------------------------- |
  | `WIN_CERT_P12_BASE64` | the text inside `cert.txt`, without the BEGIN/END lines |
  | `WIN_CERT_PASSWORD`   | the `.pfx` password                                     |

  This works with the current workflow as-is.

- **[SignPath Foundation](https://signpath.org)**: free signing for open-source projects.
  Apply once the repo is public and has a release or two. SignPath signs through its own
  GitHub Action rather than a certificate file, so the release workflow needs a small
  change when you're approved.

- **Azure Trusted Signing** (about $10 a month, available only in some countries): also
  needs a small workflow change.

Even with a certificate, SmartScreen can still warn for a while until the app builds up a
download history.

---

## Before announcing publicly

- **Name.** "Zenbook" is the name of ASUS's laptop line. If you plan to grow the app,
  consider a distinct name now, while it's cheap: change `productName` and `appId` in
  `electron-builder.yml`, `productName` in `package.json`, the window title and the repo
  name. Changing it later breaks auto-updates for existing users (they'd need to reinstall).
- **Try it on a real Mac** (or ask a friend), since it has only been tested in CI there.
- **Screenshots** in `docs/images/` are used by the README; re-take them if the look changes.

---

## Troubleshooting

| Problem                                           | What to do                                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The Release workflow didn't start                 | The tag must start with `v` (`v0.1.1`). Check that you pushed the tag: `git push --follow-tags`.                                            |
| "Resource not accessible by integration"          | Part 1, step 3: give workflows read and write permission.                                                                                   |
| One OS failed, the others worked                  | Fix the problem, then delete the draft release and the tag (`git push --delete origin v0.1.1` and `git tag -d v0.1.1`) and tag again.       |
| A mistake slipped into a published release        | Don't edit or delete it; publish a new patch version. Installed apps only ever move forward.                                                |
| Users don't see an update                         | The release must be **published** (not a draft) and include the `latest*.yml` files. Apps check 10 seconds after opening and every 6 hours. |
| Building locally fails to download Electron (504) | Set the mirrors listed under _Gotchas_ in `CLAUDE.md`.                                                                                      |
