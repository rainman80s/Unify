# Running Unify.js on your Mac

## Easiest: install the app
1. Download the .dmg from https://github.com/rainman80s/Unify/releases/latest: `Unify.js-<version>-arm64.dmg` for Apple Silicon (M1 or newer), `Unify.js-<version>.dmg` for Intel Macs.
   (To build them yourself: `cd desktop && npm install && npm run dist:mac`; they land in `desktop/dist/`.)
2. Open it and drag **Unify.js** into **Applications**.
3. The first time, macOS blocks it because it isn't signed with an Apple Developer ID yet. Double-click it once, choose
   **Done**, then open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Unify.js.
   You only do this once.
4. The **Get started** screen checks for Claude Code and Codex, installs them if needed (in Terminal, with their official
   installers), opens each sign-in, and sends a tiny test message. Then pick a project folder.

When a new version is out, the app shows **Update available** at the bottom of the sidebar; download it the same way and replace the app in Applications.

The rest of this page is for running from source (developers, or to try unreleased changes).

About 15 minutes. Everything runs locally; nothing here costs money unless you choose the `--paid` test.

## 1. Tools (one time)
Open **Terminal** and check what you already have:
```sh
node --version   # need v22.13 or newer
git --version    # if missing, macOS will offer to install the developer tools; accept
```
If Node is missing or older, install it from https://nodejs.org (the LTS installer) or with Homebrew: `brew install node@22`.

## 2. Get the code
```sh
cd ~
git clone https://github.com/rainman80s/unify.git
cd unify
npm test            # should end with "fail 0"
```
If git asks you to sign in, use GitHub Desktop or `gh auth login` (GitHub CLI).

## 3. Sign in to the AI tools (your own accounts)
```sh
npm install -g @anthropic-ai/claude-code @openai/codex
claude          # follow the login prompt, then type /exit
codex login     # choose "Sign in with ChatGPT"
```
Unify.js never sees these logins. It runs these tools the same way you would.

## 4. Test the real connections
```sh
npm run doctor -- --handoff
```
This checks that each tool is installed, replies, and remembers the conversation. With `--handoff`, it also runs a real
Claude Code → Codex handoff in a throwaway folder. It uses a few tiny messages from your plans.

Optional:
- **NVIDIA (free trial):** create a key at https://build.nvidia.com, then:
  `read -s NVIDIA_API_KEY && export NVIDIA_API_KEY && npm run doctor`
  (`read -s` keeps the key out of your shell history; paste it and press Return, nothing will show.)
- **DeepSeek (paid, well under one cent):** `read -s DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY && npm run doctor -- --paid`

The doctor prints where it saved `report.md`. Send me that file's contents. It has no keys in it.

## 5. Use it
**Desktop app (recommended):**
```sh
cd desktop
npm install       # downloads Electron and rebuilds the database module for it
npm start         # opens in demo mode
```
Node 22 LTS is the smoothest choice for the desktop app. Newer Node (for example 26, which Homebrew's `node` installs) also
works: `npm install` skips better-sqlite3's build for your system Node (the app only needs the Electron build, which the
postinstall makes) and finishes unpacking Electron if its own installer stops partway. If `npm start` still says
"Electron failed to install correctly", delete `desktop/node_modules` and run `npm install` again.

Then use **File → Open Project Folder…** and pick a test folder first, because the AIs can edit files there.
In **My AIs**, add NVIDIA and DeepSeek keys; the app stores them encrypted with your Keychain.

**Browser version:** `npm start` (demo) or `UNIFY_CWD=~/some-test-folder npm run start:real`, then open http://127.0.0.1:4317.

**Build a .app / .dmg:** `cd desktop && npm run dist:mac`. Until it's signed with an Apple Developer ID, right-click → Open the
first time.

## Continuing in a local session
To have Claude work directly on your Mac (run the doctor, fix what it finds, try the desktop app), open this `unify` folder in the
**Claude desktop app** (Code tab), or run `claude` in Terminal inside it. Tell it:

> Read README.md, docs/PLAN.md and docs/MAC_SETUP.md, then run `npm run doctor -- --handoff` and fix whatever fails.

Everything that session needs is in the repo. The `.jsonl` files the doctor saves are the real tool output, which are what any parser fixes should be based on.
