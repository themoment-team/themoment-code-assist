# PR Review Bot

PR을 자동으로 리뷰해주는 GitHub App입니다. PR이 열리면 요약과 인라인 코멘트를 하나의 리뷰로 묶어 게시합니다.

- **summary** — PR 메타데이터 + diff를 LLM에 한 번 보내 리뷰 본문 생성
- **inline comments** — [pi](https://www.npmjs.com/package/@earendil-works/pi-agent-core) 에이전트가 체크아웃된 코드를 읽기 전용 도구로 탐색하고, 구조화된 도구로 라인 기반 코멘트 제출

현재 **M0–M2** (리뷰 파이프라인 + `/review` + `/reply-review`) 구현 완료. M3 이후(자기 비판 게이트, 증분 퍼블리싱, 실행 격리, 에이전트 리플라이, 서브에이전트)는 미구현입니다.

## 동작 흐름

```
GitHub ──webhook──▶ Fastify (X-Hub-Signature-256 검증, 200 응답)
                        │
                        ▼
              Event Filter / Job Queue   (디바운스, PR당 1개 작업, 동시성 제어)
                        │
              Context Assembler          (메타데이터 + diff + 체크아웃 + review_guide.md)
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
   summary (one-shot)            review agent (pi, 읽기 전용 도구)
        │                                │  submit_inline_comment → 검증된 버퍼
        └───────────────┬────────────────┘
                        ▼
                    Publisher            (재검증, 정렬, 제한, 단일 COMMENT 리뷰)
```

- **자동 리뷰**는 `opened` / `reopened` / `ready_for_review` 이벤트에서만 실행 — `synchronize`(push)는 제외
- **봇 명령어**는 쓰기 권한(write) 이상이 필요하며, 권한 없는 사용자의 명령은 무시됨
- **무상태(stateless)**: DB 없음. 작업 큐는 인-프로세스/휘발성이며, 유실된 작업은 `/review`로 재실행 가능

## 보안 모델

PR diff는 **신뢰할 수 없는 입력**으로 취급 (프롬프트 인젝션 가능):

- 에이전트는 **읽기 전용 도구만** 보유 (`read_file`, `search`, `git_blame`) + `submit_inline_comment`는 버퍼링만 하고 GitHub API를 직접 호출하지 않음. `write`/`edit`/`bash`는 등록되지 않으며, 도구 화이트리스트로 이중 방어
- 모든 파일시스템 도구는 체크아웃 루트로 경로를 제한
- 코멘트 라인 범위는 제출 시점과 Publisher에서 **두 번 검증** — diff의 코멘트 가능 라인 집합을 기준으로
- 리뷰 이벤트는 항상 `COMMENT` — 봇은 절대 승인(APPROVE), 변경 요청(REQUEST_CHANGES), 머지 불가

> MVP는 신뢰할 수 있는 내부 조직을 대상으로 실행됩니다. 외부 조직에 노출하려면 SPEC M5 (작업별 컨테이너 격리)가 필요합니다.

## 설치 방법

### 1. GitHub App 생성

권한: **Pull requests** (읽기/쓰기), **Contents** (읽기), **Issues** (읽기/쓰기), **Metadata** (읽기). 구독 이벤트: **Pull request**, **Issue comment**, **Pull request review comment**. 웹훅 URL을 `https://<host>/webhook`으로 설정하고 웹훅 시크릿을 등록한 뒤, 조직/저장소에 앱을 설치합니다.

### 2. 환경 변수 설정

```bash
cp .env.example .env
# GITHUB_APP_ID, GITHUB_PRIVATE_KEY(_PATH), GITHUB_WEBHOOK_SECRET,
# LLM_* (OpenAI 호환 엔드포인트, 로컬/상용 모두 가능)을 채워넣으세요.
```

페이즈별 모델(`SUMMARY_MODEL`, `REVIEW_MODEL`, `REPLY_MODEL`, …)은 선택 사항이며 기본 `LLM_MODEL`로 폴백됩니다. 전체 변수 목록은 [`.env.example`](./.env.example) 또는 `SPEC.md §7`을 참고하세요.

### 3. 실행

```bash
npm install
npm run build
npm start
# 개발 중에는
npm run dev
```

Docker:

```bash
docker build -t pr-review-bot .
docker run --env-file .env -p 3000:3000 pr-review-bot
```

## 저장소별 설정

대상 저장소에 `.review/review_guide.md` 파일이 있으면 그 내용이 리뷰·리플라이 시스템 프롬프트에 주입됩니다. 저장소마다 카테고리 가중치, 집중 영역, 컨벤션을 조정할 수 있습니다.

## 봇 명령어

| 명령어 | 위치 | 효과 |
|---|---|---|
| `/review` | PR 코멘트 | 수동 전체 리리뷰 (자동 리뷰와 동일 파이프라인). 쓰기 권한 필요. |
| `/reply-review` | 인라인 리뷰 스레드 또는 PR 코멘트 | 봇이 해당 스레드 문맥으로 답변 (단일 LLM 호출). 쓰기 권한 필요. |

## 프로젝트 구조

```
src/
├─ index.ts            부트스트랩
├─ config.ts           환경 변수 → 설정 스키마
├─ env.ts              최소 .env 로더
├─ logger.ts           구조화 로깅
├─ server.ts           Fastify + 서명 검증
├─ github/             앱 인증, 웹훅, 체크아웃, diff, 퍼블리셔
├─ queue/              p-queue 디바운스 / PR당 단일 작업
├─ pipeline/           어셈블러, 오케스트레이터, 요약, findings, 프롬프트
├─ agent/              pi 세션, 예산, 읽기 전용 도구 + submit_inline_comment
├─ commands/           파싱 + 권한, review, reply
└─ llm/                pi-ai 모델 레지스트리 (페이즈별)
```

## 미구현 항목

M3 자기 비판 게이트 · M4 증분·멱등 퍼블리싱 · M5 실행 격리 · M6 에이전트 리플라이 · M7 서브에이전트 — 아키텍처상 플레이스홀더는 존재하나 MVP 범위 밖입니다.
