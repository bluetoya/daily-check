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
