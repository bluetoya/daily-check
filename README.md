# Daily Check

Daily Check is a personal routine tracker for macOS, with Android support in progress.

It is built around recurring routines, quick daily check-ins, a weekly grid, Pomodoro timers, local-first storage, and optional multi-device sync.

## What It Does

- Manage recurring routines with simple repeat rules
- Check off today's routines quickly
- Review progress in a weekly grid
- See completion stats by routine
- Run Pomodoro timers tied to a routine
- Use local notifications for routine reminders and Pomodoro completion
- Work offline with local SQLite storage
- Sync across devices with `sync-server` and PostgreSQL when needed

## App Structure

- `오늘`: today's routines and daily completion rate
- `주간 체크`: weekly grid with clickable completion cells
- `통계`: completion summaries and per-routine trends
- `뽀모도로`: focus and break timer
- `루틴`: create, edit, and delete routines
- `설정`: sync key, sync status, notification permission, and test notification

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
- use manual or automatic sync from `설정`

See [sync-server/README.md](sync-server/README.md) for backend details.

## Notifications

The app supports:

- routine reminder notifications
- Pomodoro completion notifications
- notification permission request inside `설정`
- test notification inside `설정`

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
