# LLMTally

> Tally up your LLM usage — 로컬 AI 코딩 에이전트들의 사용량을 한곳에서 세고, 기록하고, 지켜본다.

LLMTally는 로컬에서 사용하는 AI 코딩 에이전트(Claude Code, Codex CLI, OpenCode, Cline, Antigravity, Grok Build)의
세션 로그를 스캔하여 **per-prompt 사용 원장**을 만들고, **잔여 사용량과 멀티 계정을 터미널 대시보드(TUI)에서
모니터링**하는 도구입니다. (macOS 메뉴바 앱은 로드맵에 있으며 아직 구현되지 않았습니다.)

## 핵심 기능

- **Per-prompt 원장**: 프롬프트 원문, 토큰(input/output/cache read·write/reasoning), 모델명, effort,
  provider, 비용, 사용 시각(로컬 타임존)을 프롬프트 단위로 기록·검색
- **TUI 대시보드**: 구독 잔여 사용량(쿼터) 게이지, 멀티 계정 볼트·전환, 모델별·날짜별 집계
  리포트와 프롬프트 전문 검색 — 전부 탭 안에 있습니다
- **비침습 수집**: 각 에이전트가 이미 남기는 로컬 로그만 읽음 — 에이전트 쪽 설정 변경 불필요

## 아키텍처

```
[에이전트 로컬 로그 6종] --(최초 풀스캔 + launchd 주기 증분 수집)--> [SQLite 원장]
                                                                     ├── TUI (조회 직전 증분 수집)
                                                                     └── macOS 메뉴바 앱 (예정)
```

- 비용은 저장하지 않고 조회 시점에 가격표(LiteLLM/models.dev/OpenRouter)를 곱해 계산
  (원본 로그에 비용이 기록되는 OpenCode/Cline은 예외)
- 증분 수집은 파일 offset 커서 + 자연키 UNIQUE로 멱등하게 동작

## 설치와 사용법

[Bun](https://bun.sh) 런타임이 **필수**입니다 (>= 1.3) — 코어가 `bun:sqlite` 위에서 동작하므로
node로는 실행되지 않습니다. npm으로 설치해도 실행에는 Bun이 필요하며, Bun이 없으면
설치 안내를 출력하고 종료합니다.

```bash
bun install -g llmtally     # 또는 npm install -g llmtally (실행엔 Bun 필요)
```

```bash
llmtally                          # 대시보드 진입 (그 자체가 전부입니다)
llmtally --theme tokyo-night      # default | tokyo-night | dracula | mono
llmtally --chart braille          # 일별 차트 2배 밀도 (기본 block)
llmtally --refresh 300            # 자동 새로고침 초기값(초, 최소 30)
llmtally --db /path/ledger.db     # 원장 경로 지정
```

서브커맨드는 없습니다. **최초 실행 시 로컬 에이전트 로그를 전부 수집**하며(진행 중임을 화면에
표시), 이후 실행은 변경분만 증분 수집합니다. 수집·리포트·쿼터·계정·진단이 모두 탭 안에 있습니다.

| 탭 | 내용 |
|---|---|
| `1` Overview | 일별 토큰 차트, Actual/Nominal 비용 |
| `2` Accounts | 계정별 쿼터 + 볼트 관리(추가·전환·제거) |
| `3` Agents / `4` Models | 에이전트·모델별 집계 (정렬 가능). Models에서 `↑↓`+`Enter`로 모델을 열면 최신순 프롬프트 목록 |
| `5` Search | 프롬프트 전문 검색 (`/`로 입력) |
| `6` Doctor | 진단 + 백그라운드 수집 데몬 설치/해제 |

### 쿼터 소스와 정책

- **Claude (활성 계정)**: OAuth usage API 1회 읽기 조회 — 5h/7d/모델별 주간 한도(`7d <모델>`)/
  extra usage(별도 축)까지 표시. 토큰은 저장·갱신·출력하지 않습니다
- **Claude (다른 계정)**: 볼트에 저장된 계정은 각자의 토큰으로 **라이브 조회**합니다. 토큰이
  만료됐으면 갱신 후 회전된 토큰을 볼트에 다시 저장합니다(저장하지 않으면 서버가 이미 무효화한
  토큰만 남습니다). 볼트에 없는 계정은 쿼터 수치가 없고 목록에만 나타납니다
- **조회 빈도**: 성공한 조회는 Claude·Codex는 180초, OpenCode Go·ClinePass는 300초간
  재사용합니다(두 구독 엔드포인트는 벤더가 폴링 계약을 공개하지 않아 더 보수적으로 잡은
  자체 정책입니다). 벤더가 429를 주면 5분부터 최대 30분까지 지수 백오프하며 그동안
  **마지막 정상 수치를 유지**한 채 "retrying in Nm"만 덧붙입니다.
  `r`을 누르면 캐시를 버리고 즉시 다시 읽습니다
- **Codex**: `~/.codex/auth.json`의 토큰으로 wham usage 엔드포인트를 읽기 전용 조회합니다
  (주/Spark 등 모든 한도 창 + 리셋 시각). 토큰이 없거나 조회가 실패하면 로컬 rollout 로그의
  마지막 `rate_limits` 관측치로 폴백하고 실패 사유를 경고로 남깁니다
- **OpenCode Go**: OpenCode의 `auth.json`에 있는 `opencode-go` API 키로 공식 호스팅
  엔드포인트를 읽기 전용 조회합니다(5h 롤링/주간/월간). 벤더는 백분율과 리셋 시각만 주고
  실제 사용액이나 요청 수는 공개하지 않으므로 역산하지 않습니다
- **ClinePass**: 같은 `auth.json`의 `cline-pass` API 키로 Cline 계정 API를 조회합니다.
  ClinePass는 Cline 구독이므로 OpenCode가 아니라 **`cline` 계정 행**으로 따로 표시됩니다
  (계정 식별자는 Cline user id). 사용량 엔드포인트는 공식 문서에 없는 대시보드 내부
  경로라, 응답이 예상과 다르면 값을 지어내지 않고 표시를 접으며 404/410이면 재시작 전까지
  폴링을 멈춥니다
- **Antigravity(Gemini)**: antigravity-usage CLI(MIT)의 토큰 저장소를
  읽어 daily Cloud Code 엔드포인트를 조회합니다. 만료 임박 토큰은 **메모리 내에서만** refresh해
  즉시 사용하고 저장소 파일은 절대 수정하지 않습니다 (내부적으로 완전 읽기 전용 모드도 지원).
  refresh 실패 시 CLI 캐시 스냅샷으로 강등합니다
- 성공한 조회는 원장 DB의 `quota_samples`에 이력으로 적재되고(30일 보존), 모든 소스가
  비어 있으면 24시간 이내의 저장된 last-good을 `stored, as of …`로 표시합니다
- 단, 벤더가 **크레덴셜 자체를 거절**하면(401/403) 그 계정의 저장된 수치는 더 이상 표시하지
  않습니다. 네트워크 오류나 429는 마지막 수치가 여전히 참이지만, 폐기된 키의 수치는
  아무도 보증할 수 없기 때문입니다. 다시 로그인해 조회가 한 번 성공하면 원래대로 돌아옵니다
- 한 계정이 여러 소스에 잡히면 **가장 신선한 관측치 하나만** 표시하고, 실패한 조회의
  사유는 살아남은 행의 경고로 옮겨 붙습니다 (예: 라이브 429 → 캐시 표시 + 429 경고)
- 계정 레지스트리(`account_profiles`)는 쿼터 라벨링·발견 전용입니다 — 기존 원장 row를
  현재 로그인 계정으로 소급 귀속하지 않습니다 (오귀속 방지 정책)

### 계정 전환 (Accounts 탭)

Accounts 탭에서 `n`으로 저장해 둔 계정으로 `s`(또는 Enter)를 눌러 Claude Code 로그인을
바꿉니다. 크레덴셜은
llmtally 자체 볼트(macOS Keychain 서비스 `llmtally`, 없으면 `~/.llmtally/accounts` 0600)에
보관하며, 전환 시 Claude Code가 읽는 저장소(Keychain `Claude Code-credentials` 또는
`~/.claude/.credentials.json`)를 교체하고 `~/.claude.json`의 **`oauthAccount` 섹션만** 바꿉니다.
projects·settings·히스토리는 그대로 유지됩니다.

안전장치 — ① Claude Code의 락 파일을 같은 순서로 잡아 토큰 갱신과 겹치지 않게 하고(락 보유 중
네트워크 호출 없음), ② 나가는 크레덴셜을 먼저 볼트에 백업하되 **소유 계정을 특정할 수 없으면
덮어쓰지 않고** `unclaimed/`에 증거와 함께 보존하며, ③ 저장소를 빈 값으로 읽으면(타임아웃 등)
전환을 중단하고, ④ 중간에 실패하면 크레덴셜·config·레지스트리를 역순으로 롤백합니다.
실행 중인 세션이 있으면 경고하며, 전환 후 Keychain 백엔드는 약 30초(또는 재시작 즉시),
파일 백엔드는 다음 메시지부터 반영됩니다.

### TUI 조작

- `1..6` 또는 `Tab`/`Shift-Tab`/`←→`: 탭 전환 · `r`: 새로고침 ·
  `a`: 자동 새로고침 선택창(off/30s/1m/5m/10m, 시작 시 off — footer에 현재 주기 표시) ·
  `p`: 테마 선택창 · `?`: 도움말 오버레이 · `q`/`Ctrl-C`: 종료
- `p`/`a`에서 고른 값은 `~/.llmtally/config.json`의 `ui` 섹션에 기억되어 다음 실행에 적용됩니다
  (`--theme`/`--refresh` 플래그를 주면 그 실행에 한해 우선합니다)
- **Accounts 탭**: 계정별로 쿼터·볼트 상태를 한 줄씩 보여주고 `↑↓`로 선택 후
  `n` 현재 로그인 저장 · `s`(또는 Enter) 전환 · `x` 제거.
  전환·제거는 확인창을 거치고, 실행 중에는 다른 조작이 막힙니다
- **Models 드릴다운**: `↑↓`로 모델을 고르고 `Enter`로 열면 그 모델의 프롬프트가 **최신순**으로,
  프롬프트별 토큰(in/out/cacheR)과 비용(`$` 실지출 / `~$` API 환산)과 함께 나옵니다. `Esc`로 복귀
- **Search 탭**: `/`로 검색어를 입력하고 `Enter`. 같은 프롬프트 목록 형식으로 결과를 보여줍니다
- **Doctor 탭**: 진단 + `D`/`U`로 백그라운드 수집 데몬 설치/해제
- **마우스**: 탭 이름 클릭으로 탭 전환, 휠로 목록 스크롤, Models 표·프롬프트 목록에서 행 클릭으로 선택
  (클릭은 선택만 하며 실행은 `Enter` — 실수로 되돌리기 어려운 동작이 시작되지 않도록)
- Agents/Models 탭에서 `d`(rows)/`c`(actual cost)/`t`(input tokens) 정렬,
  같은 키 재입력 시 방향 토글 — 헤더에 `↑`/`↓` 표시
- 쿼터는 **스캔과 별개로** Accounts 탭이 열려 있는 동안 180초마다 갱신됩니다 (vendor의
  토큰당 요청 예산 안에 들도록 — 스캔은 수천 개 파일을 훑는 무거운 작업이라 주기가 다릅니다).
  다른 탭에 있으면 네트워크를 쓰지 않습니다
- 시작·주기·`r` 시점에 증분 스캔 후 활성 탭만 다시 조회합니다. daemon이 스캔 락을 잡고
  있으면 `scan busy`로 표시하고 기존 원장으로 계속 동작합니다 (실패해도 마지막 정상 화면 유지)
- Actual은 `$`, Nominal은 `~$` 접두사로 구조적으로 구분 — `NO_COLOR=1`(또는 `--theme mono`)
  에서도 굵기·기호만으로 판별됩니다. 쿼터 게이지는 80% 초과 `[!]`, 95% 초과 `[!!]` + 색 램프
- 내장 테마 3종(Catppuccin Mocha 기본 / Tokyo Night / Dracula)은 배경색을 칠하지 않고
  전경색만 사용해 터미널 배경(투명 포함)을 존중합니다
- Accounts 탭은 계정별 카드로 표시됩니다 — Claude 라이브(활성 계정 + 볼트에 저장된 계정),
  Codex 로컬 관측치, Antigravity 라이브/캐시 (`live` / `cached` / `stored` / `from local logs` 표기)
- TTY가 아닌 환경(파이프/CI)에서는 실행을 거부합니다 — 현재 표면은 TUI 하나뿐이라
  헤드리스 조회용 서브커맨드는 없습니다
- TUI는 `@opentui/core` 하나를 런타임 의존성으로 사용합니다 (그 외 의존성 0 정책 유지).
  `bun build --compile` 호환은 `verify:compile`로 검증하고 있으며, 단일 바이너리 **배포**는
  CI 구축 후 예정입니다
- 백그라운드 수집은 Doctor 탭의 `D`로 설치하는 launchd 에이전트가 담당하며, TUI가 아니라
  전용 headless 워커(`scan-worker.ts`)를 주기 실행합니다

### 비용 표기의 의미

- **Actual USD**: 소스가 직접 기록한 실지출 (OpenCode/Cline의 `cost_usd`)
- **Nominal API-eq USD**: 구독제(Claude Code, Codex) 사용분을 **리포트 실행 시점의 API 요율**로
  환산한 명목치 — 실지출이 아니며, 두 값은 절대 합산되지 않습니다
- 가격표는 LiteLLM(기본) + OpenRouter(보조)에서 1시간 TTL로 캐시하며, 오프라인에서도
  stale 캐시로 리포트가 동작합니다 (미해석 모델은 토큰만 표시)
- 모델 별칭·가격 오버라이드: `~/.llmtally/config.json`의 `pricing.modelAliases` / `pricing.priceOverrides`

- 스캔은 멱등합니다 — 언제든 재실행해도 중복이 생기지 않습니다
- 원본 로그는 읽기 전용으로만 접근하며 절대 수정하지 않습니다
- 원장에는 프롬프트 원문이 포함되므로 DB 파일은 0600 권한으로 생성됩니다
- **프롬프트 원문은 기본 1년 보존**: 스캔 때마다 365일이 지난 행의 **원문만** 지웁니다(전문검색
  인덱스 포함). 토큰·모델·비용 등 집계 수치는 영구 보존되므로 리포트는 달라지지 않습니다.
  전부 남기고 싶으면 `~/.llmtally/config.json`에 `{"privacy": {"promptRetentionDays": 0}}`
  (0 = 무기한, 그 외 값 = 보존 일수). 실측 기준 원문+검색 인덱스가 DB의 약 70%를 차지합니다

## 지원 대상

| 에이전트 | 데이터 소스 | 상태 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | ✅ 구현 완료 |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | ✅ 구현 완료 |
| OpenCode | `~/.local/share/opencode/opencode.db` | ✅ 구현 완료 |
| Cline (CLI) | `~/.cline/data/sessions/` | ✅ 구현 완료 |
| Antigravity CLI | `~/.gemini/antigravity-cli/conversations/` | ✅ 구현 완료 |
| Grok Build | `~/.grok/sessions/**/updates.jsonl` | ✅ 구현 완료 |

### 토큰 필드 의미 (중요)

토큰 수치는 **소스 원본 그대로** 저장됩니다. 에이전트마다 의미가 다릅니다:

- `claude-code`: `input_tokens`는 캐시 미포함 (cache read/write 별도 컬럼)
- `codex`: `input_tokens`에 cached input **포함** (`cache_read` 컬럼과 중첩), `output_tokens`에 reasoning 포함
- `opencode`: 소스가 기록한 실비 `cost_usd`를 그대로 보존
- `grok`: codex와 같은 의미 (`input_tokens`에 cache read 포함, `output_tokens`에 reasoning 포함).
  소스가 턴마다 `costUsdTicks`(1e10 ticks = 1 USD)를 남기므로 그 값을 `cost_usd`로 보존

비용 계산은 조회 시점에 에이전트별 semantics를 적용해 수행합니다.

## License

MIT
