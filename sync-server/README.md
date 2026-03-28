# Sync Server

데스크톱 앱의 로컬 SQLite와 별도로, 두 기기 간 동기화를 위해 쓰는 작은 HTTP 서버입니다.

## 준비

1. PostgreSQL 데이터베이스를 준비합니다.
2. 환경에 맞는 예시 파일을 복사해 환경변수를 설정합니다.
3. `.env`는 절대 저장소에 커밋하지 않습니다.

```bash
cp .env.development.example .env.development.local
```

기본값 예시:

```env
DATABASE_URL=postgres://app_user:replace_me@localhost:5432/daily_check_development
PORT=8787
HOST=localhost
CORS_ORIGIN=http://localhost:1420,tauri://localhost
```

`.env.development.local`은 로컬에서만 쓰는 비밀 설정 파일이고, Git에는 올리지 않습니다.

배포용 예시는 `.env.production.example`을 참고하고, 실제 비밀번호는 배포 환경의 secret로 주입하는 쪽을 권장합니다.

## 실행

```bash
npm install
npm run dev
```

서버가 시작되면 기본적으로 로컬호스트에만 바인딩됩니다.

```text
http://localhost:8787
```

## 보안 메모

- 기본값은 로컬 개발용입니다.
- 인터넷에 공개하려면 `HOST`, `CORS_ORIGIN`, HTTPS 프록시 구성을 따로 잡아야 합니다.
- 현재 인증은 sync key 기반이라, 공개 서비스로 키우려면 추가 인증/제한 장치가 필요합니다.
- `APP_ENV=production`으로 실행하면 `.env.production`, `.env.production.local`도 함께 읽습니다.
- 저장소에 비밀번호를 암호화해서 넣고 싶다면 `sops + age` 같은 방식을 쓸 수 있지만, 개인용 로컬 개발에는 `.env.development.local` + Git 무시가 더 단순하고 안전합니다.

## 엔드포인트

- `GET /health`
- `POST /v1/sync/attach`
- `POST /v1/sync`
- `POST /v1/sync/regenerate-key`

## 동작 방식

- 앱은 먼저 로컬 SQLite에 저장합니다.
- 아직 서버에 보내지 않은 변경은 로컬 outbox에 남습니다.
- 서버는 변경을 PostgreSQL에 반영하고, `sync_events`를 통해 증분 동기화를 제공합니다.
- 서버가 내려가 있어도 앱은 로컬 SQLite로 계속 사용할 수 있습니다.
