# Daily Check

Daily Check is a personal routine tracker for macOS with a calm sci-fi interface inspired by mission control panels, deep-space dashboards, and astronaut flight systems.

It focuses on recurring routines, quick daily check-ins, progress-based habits, Pomodoro timing, local-first storage, and optional multi-device sync.

## What It Does

- Manage recurring protocols with simple repeat rules
- Track both binary routines and progress-based routines
- Log today's routines from a focused mission queue
- Review completions in a weekly orbit grid
- Inspect completion telemetry and streaks
- Run Pomodoro-style focus and recovery cycles
- Use local notifications for routine reminders and timer completion
- Work offline with local SQLite storage
- Sync across devices with `sync-server` and PostgreSQL when needed

## Mission UI

The current app UI uses:

- `Space Grotesk` for primary interface typography
- `IBM Plex Mono` for telemetry, time, and technical labels
- space-mission terminology such as `Bridge`, `Orbit Grid`, `Telemetry`, and `Burn Cycle`
- planet-style color signatures for routines
- a darker “flight deck” visual direction instead of a generic productivity dashboard

## App Structure

- `Bridge`: today's mission queue and completion snapshot
- `Orbit Grid`: weekly completion board
- `Telemetry`: summary cards, streaks, and routine trends
- `Burn Cycle`: focus and recovery timer
- `Protocols`: create, edit, and tune routines
- `Systems`: sync, alerts, and sync key controls

## Tech Stack

- Frontend: React + TypeScript + Vite
- Desktop shell: Tauri 2
- Local database: SQLite via Rust
- Sync backend: Node.js + PostgreSQL
- Mobile path: Tauri Android

## Project Layout

```text
.
├── src/                 # React UI
├── src-tauri/           # Tauri + Rust + local SQLite
├── sync-server/         # Optional sync backend
├── docs/                # Product/design notes
├── scripts/             # Public audit and cleanup helpers
└── README.md
```

## Quick Start

### 1. Local-only macOS usage

If you want to use the app on one Mac without sync, this is enough.

Requirements:

- Node.js 20+
- Rust toolchain
- Tauri build environment for macOS

Install and run:

```bash
npm install
npm run tauri dev
```

You can enter a sync key in the app even if the sync server is not running. The app will still work in offline/local mode.

### 1-1. Use From GitHub Source On Another Mac

If you clone this repository on another local Mac and want to run it from source, follow this order:

1. Clone the repository
2. Install Node.js 20+
3. Install the Rust toolchain
4. Install the Tauri macOS build prerequisites
5. Install project dependencies
6. Run the app in dev mode or build a DMG

Example:

```bash
git clone https://github.com/bluetoya/daily-check.git
cd daily-check
npm install
npm --prefix sync-server install
npm run tauri dev
```

If you only want to use the desktop app and do not need to develop it, downloading the DMG from GitHub Releases is the easier path.

### 2. Build a macOS app bundle

```bash
npm run build
npm run bundle:mac
```

Main output:

```text
src-tauri/target/release/bundle/macos/Daily Check.app
src-tauri/target/release/bundle/dmg/Daily Check_0.1.0_aarch64.dmg
```

## Recommended Distribution

If you want to use this app on another Mac without rebuilding everything locally, do not commit the `.dmg` into the repository.

Use **GitHub Releases** instead:

1. Build the DMG locally
2. Create a GitHub release
3. Upload the `.dmg` as a release asset

That gives you:

- a clean source repository
- a direct download link for the app
- no need to install Node, Rust, Tauri, or PostgreSQL just to try the desktop app

For source users, the repository stays lightweight. For app users, the DMG is the correct download target.

## Sync Setup

Sync is optional. If you want to use the same data across multiple devices, run `sync-server` with PostgreSQL.

### 1. Prepare the backend

```bash
npm install
npm --prefix sync-server install
cp sync-server/.env.development.example sync-server/.env.development.local
```

Then set your real PostgreSQL connection string in `sync-server/.env.development.local`.

### 2. Start the sync server

```bash
npm run sync:dev
```

By default, the server runs at:

```text
http://localhost:8787
```

### 3. Start the app

```bash
npm run tauri dev
```

Then in the app:

- enter your sync key
- set the server URL
- use manual or automatic sync from `Systems`

See [sync-server/README.md](sync-server/README.md) for backend details.

## Notifications

The app supports:

- routine reminder notifications
- Pomodoro completion notifications
- notification permission request inside `Systems`
- test notification inside `Systems`

On macOS, the app appears in system notification settings after permission is requested once from inside the app.

## Android

The codebase is prepared for Android, but Android development still requires local environment setup.

Requirements:

- Android Studio
- Android SDK / Platform-Tools / Build-Tools / NDK
- `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `NDK_HOME`
- Rust Android target

Commands:

```bash
npm run android:init
npm run android:dev
npm run android:build
```

Useful helpers:

```bash
npm run android:devices
npm run android:install
npm run android:logcat
```

Current debug APK output:

```text
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

## Security Notes

- Do not commit real `.env` files
- Use `.env.development.local` or deployment secrets for real credentials
- Keep the sync server bound to `localhost` unless you intentionally deploy it
- If you expose `sync-server` to the internet, add HTTPS, stronger authentication, and rate limiting
- Keep DMG files in GitHub Releases, not inside the tracked repository history

## Public GitHub Checklist

Before pushing to a public repository:

```bash
npm run clean:public
npm run audit:public
```

Also verify:

- no real `.env` files are tracked
- no generated build artifacts are tracked
- no private URLs, passwords, or local machine paths are present

## Useful Commands

```bash
# desktop app
npm run tauri dev
npm run build
npm run bundle:mac

# sync backend
npm run sync:dev
npm run sync:build

# public safety checks
npm run clean:public
npm run audit:public

# android
npm run android:init
npm run android:build
npm run android:install
```

## What To Improve Next

- Background and scheduled sync reliability
- Better conflict visibility when two devices edit the same item
- Richer stats such as streaks and monthly heatmaps
- Android UX tuning for smaller screens
- Release automation for DMG and APK builds
