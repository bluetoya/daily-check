# Daily Check

macOS에서 쓰는 개인용 루틴 체크 앱입니다. 로컬 SQLite를 기본 저장소로 쓰고, 원하면 별도 sync-server + PostgreSQL로 여러 기기 간 동기화를 붙일 수 있습니다.

## 보안 원칙

- `.env` 파일은 저장소에 올리지 않습니다.
- sync-server는 기본적으로 `localhost`에만 바인딩되도록 두고, 외부 공개가 필요하면 별도 HTTPS 프록시 뒤에 둡니다.
- 공개 배포 전에 실제 서비스 주소, 인증 방식, CORS 정책을 다시 점검하세요.

## 로컬 전용 사용

동기화 없이 한 대의 Mac에서만 쓸 거라면 sync-server와 PostgreSQL 없이도 사용할 수 있습니다.

필요한 것:

- Node.js 20+
- Rust toolchain
- macOS용 Tauri 빌드 환경

실행:

```bash
npm install
npm run tauri dev
```

앱이 뜨면 원하는 동기화 키를 입력해 로컬에 저장하고, 서버가 없어도 오프라인 모드로 사용할 수 있습니다.

## Android 확장 준비

현재 코드베이스는 Android 대응을 염두에 두고 정리되어 있습니다.

이미 반영된 것:

- 하단 탭 기반 UI 유지
- 데스크톱 전용 트레이 코드를 모바일에서 분리
- Vite 개발 서버가 TAURI_DEV_HOST를 사용하도록 조정
- Android용 실행 스크립트 추가

Android로 실제 빌드하려면 추가로 필요합니다.

- Android Studio
- Android SDK / Platform-Tools / Build-Tools / NDK
- JAVA_HOME, ANDROID_HOME, NDK_HOME 설정
- rustup 설치와 Android Rust target 추가

준비가 끝나면 아래 순서로 진행합니다.

```bash
npm run android:init
npm run android:dev
npm run android:build
```

현재 스크립트 기준:

- `android:dev`: Android Studio를 열고 `arm64` 에뮬레이터나 실제 기기로 개발 실행
- `android:build`: 실제 폰에 설치하기 쉬운 `arm64` 디버그 APK 생성
- `android:build:release`: 배포용 `arm64` 릴리스 APK/AAB 생성

디버그 APK 산출물은 보통 아래 경로에 생성됩니다.

```
src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

릴리스 빌드는 서명이 추가로 필요할 수 있습니다.

현재 저장소는 macOS 데스크톱 사용에는 바로 쓸 수 있지만, Android 빌드는 위 환경 준비가 먼저 필요합니다.

실제 안드로이드 폰에서 테스트할 때는 아래 순서가 편합니다.

1. 휴대폰에서 개발자 옵션과 USB 디버깅을 켭니다.
2. USB로 연결한 뒤 기기 인식 확인:

```bash
npm run android:devices
```

3. 디버그 APK 빌드:

```bash
npm run android:build
```

4. 폰에 바로 설치:

```bash
npm run android:install
```

5. 앱 실행 중 문제가 있으면 로그 확인:

```bash
npm run android:logcat
```

기기가 연결되지 않은 상태에서 `android:install`을 실행하면 설치는 진행되지 않습니다.

## 동기화 포함 사용

두 대 이상의 기기에서 동기화하려면 sync-server와 PostgreSQL이 필요합니다.

1. 개발용이면 `sync-server/.env.development.local`, 배포용이면 배포 환경의 secret 설정을 사용합니다.
2. PostgreSQL 데이터베이스를 준비합니다.
3. 루트와 sync-server에서 각각 의존성을 설치합니다.
4. sync-server를 먼저 실행합니다.
5. 앱에서 동기화 키와 서버 주소를 입력합니다.

예시:

```bash
npm install
npm --prefix sync-server install
cp sync-server/.env.development.example sync-server/.env.development.local
npm --prefix sync-server run dev
npm run tauri dev
```

`*.local` 파일은 Git에 올리지 않는 로컬 전용 비밀 설정 파일입니다.

배포용 설정은 예시를 참고해 별도 관리하세요.

```bash
APP_ENV=production npm --prefix sync-server run start
```

비밀번호를 공개 저장소에 "암호화해서 넣는" 방법도 가능은 하지만, 이 프로젝트처럼 개인용 로컬/배포 설정이 분리되는 구조에서는 권장하지 않습니다.

- 권장: `.env.development.local`, 배포 플랫폼 secret, GitHub Actions secret처럼 저장소 밖에서 관리
- 대안: `sops + age`로 암호화 파일을 저장소에 두고 복호화 키는 별도 보관
- 비권장: 평문 비밀번호를 `.env.example`, 소스코드, 문서에 직접 넣기

## 공개 GitHub 업로드 전 체크

- `npm run clean:public` 실행으로 생성물 정리
- `npm run audit:public` 통과 확인
- `sync-server/.env`가 없는지 확인
- 번들 식별자와 배포 메타데이터가 개인 정보 없는 값인지 확인
- 공개 서버라면 HTTPS, 접근 제어, 백업 정책 준비
- `dist`, `node_modules`, `target` 같은 생성물 제외 확인

## 다른 사람이 바로 쓸 수 있나

소스코드를 그대로 받는 방식이면 추가 준비가 필요합니다.

- 로컬 전용: Node/Rust/Tauri 환경 필요
- 동기화 포함: 여기에 PostgreSQL + sync-server 설정까지 필요

즉, “다운로드 후 바로 사용” 경험을 원하면 소스 배포보다 빌드된 앱 번들과 운영 중인 sync-server를 함께 제공하는 쪽이 맞습니다.
