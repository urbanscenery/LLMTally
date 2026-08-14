# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LLMTally는 로컬 AI 코딩 에이전트(Claude Code, Codex CLI, OpenCode, Cline, Antigravity, Grok Build)의
세션 로그를 스캔해 per-prompt 사용 원장(프롬프트 원문·토큰·모델·effort·비용·provider·KST 시각)을 만들고,
잔여 사용량·멀티 계정을 모니터링하는 도구입니다.

**표면은 TUI 하나뿐입니다** — `llmtally`를 실행하면 곧바로 대시보드로 들어가며 서브커맨드는 없습니다.
(CLI는 2026-08-11 제거됨. 최초 실행 시 풀스캔, 이후 증분 수집.)

### 패키지 구조

- `packages/core` (`@llmtally/core`) — 도메인: 파서·원장·가격·쿼터·계정 볼트·데몬·진단. 터미널을 모름
- `packages/tui` (`@llmtally/tui`) — 터미널 앱. `llmtally` 진입점(`src/main.ts`)을 소유. opentui는 `renderer.ts`에서만
- `packages/app` (`@llmtally/app`) — **macOS 메뉴바 앱 (미구현)**. core를 직접 소비할 것

cross-package import는 `@llmtally/*` 지정자를 쓰고 tsconfig `paths`로 해석합니다 (Bun이 런타임·컴파일 모두 지원 → 빌드 단계 없음). 테스트는 픽스처 공유를 위해 레포 루트 `tests/`에 둡니다.

- **상태**: 초기 설계 단계 (기술 스택 미정: TypeScript/Bun vs Rust, 메뉴바는 Swift/Tauri 검토)
- **플랫폼**: macOS 우선

## 필독 문서

작업 시작 전 `local_docs/init/`를 반드시 읽을 것 (git 미추적 로컬 문서):

- `local_docs/init/README.md` — 확정 사항 요약과 문서 목차
- `local_docs/init/01_agent_log_sources.md` — **6개 에이전트의 로컬 로그 위치·필드 실측 결과 (핵심 자산)**
- `local_docs/init/02_existing_tools.md` — 경쟁·유사 제품 분석(ccusage, LLMMeter, VibeMeter)
- `local_docs/init/03_architecture.md` — 확정 아키텍처, SQLite 스키마 초안, 설계 포인트 5가지
- `local_docs/init/04_naming.md` — LLMTally 네이밍 근거, 채널 선점 체크리스트
- `local_docs/init/05_next_steps.md` — Phase 0~3 로드맵, 미해결 질문
- `local_docs/init/14_multiaccount_decisions.md` — 멀티계정·쿼터를 자체 구현하기로 한 결정과 근거
- `.claude/plan/quota-live-multiaccount.md` — 계정 볼트·전환·라이브 폴링 실행 계획과 진행 상태

## 확정된 아키텍처 원칙

1. **하이브리드 수집**: 최초 1회 풀스캔 → SQLite 적재 → launchd 주기(기본 1시간) 증분 수집 + 조회 직전 증분 수집
2. **멱등성**: 소스별 자연키 `UNIQUE(agent, natural_id)` + INSERT OR IGNORE — 풀스캔 재실행 항상 안전
3. **비용은 저장하지 않고 조회 시 계산** (가격표 TTL 캐시). 원본에 cost가 있는 OpenCode/Cline만 예외적으로 저장
4. **원본 로그가 정본**: 에이전트 쪽 로그·설정은 **읽기 전용**이 기본. OpenCode DB는
   read-only + busy_timeout으로 열 것 (immutable=1 금지)
   - **유일한 예외 (2026-08-11 사용자 명시 승인)**: `llmtally switch`의 계정 전환.
     Keychain `Claude Code-credentials`(또는 `~/.claude/.credentials.json`)를 교체하고
     `~/.claude.json`의 **`oauthAccount` 키만** 스플라이스한다. 이때
     ① Claude Code의 락 프로토콜(`.oauth_refresh.lock` → `~/.claude.lock` → `~/.claude.json.lock`)을
     동일 순서로 잡고 락 보유 중 네트워크 호출 금지, ② 나가는 크레덴셜은 먼저 볼트에 백업하되
     소유자를 특정할 수 없으면 `unclaimed/`에 보존(덮어쓰기 금지), ③ 빈 읽기는 실패로 간주해 중단,
     ④ 실패 시 역순 롤백이 **필수**다. 그 외 어떤 코드도 에이전트 저장소에 쓰지 않는다
   - **두 번째 예외 (2026-08-13 사용자 승인)**: codex의 `detach`(TUI `d`).
     `~/.codex/auth.json`을 **삭제**한다. `codex login`이 새 로그인을 쓰기 전에
     기존 auth.json의 refresh token을 revoke하고(`login/src/auth/revoke.rs`),
     refresh token revoke는 토큰 패밀리 전체를 죽이므로 — 파일을 그대로 두면
     두 번째 계정 로그인 순간 첫 계정이 `token_revoked`가 된다. 실측(2026-08-13):
     파일을 둔 채 로그인하면 이전 계정 401, 먼저 치우고 로그인하면 200 유지.
     반드시 ① 볼트에 캡처하고 ② 저장된 바이트가 라이브와 **완전히 일치함을 확인한 뒤**
     삭제한다. 불일치면 파일을 건드리지 않고 중단한다
   - Antigravity 토큰 갱신은 메모리 내에서만 수행하며 antigravity-usage 저장소에 되쓰지 않는다
   - codex 크레덴셜 갱신(`quota/codex-vault.ts`)은 **볼트에만** 쓴다. `~/.codex/auth.json`은
     갱신 대상이 아니다 (활성 로그인은 codex CLI가 스스로 갱신한다)
5. **시각은 로컬 머신 타임존으로 표기, 저장은 UTC epoch** — 날짜 경계·일별 버킷 변환은
   SQLite `localtime`으로 통일 (JS 런타임의 TZ 오버라이드와 무관하게 일관)

## 주의사항

- Claude Code 원본 로그는 기본 30일 후 삭제됨(`cleanupPeriodDays` 미설정 시) — 수집 로직·doctor 커맨드에서 항상 고려
- 비용 표시의 1축은 **정산 성격(billing nature)**: 구독·쿼터 소모의 정가 환산은
  **quota cost**(`~$`), 카드/선결제 실지출은 **spend cost**(`$`), 분류 불가는
  unclassified(`?$`, 어느 합계에도 제외). **cost**는 두 축의 상위어(정렬 키·행의 primary
  숫자) — 이름만 합치고 숫자 합산은 금지. 돈 맥락의 quota는 반드시 cost와 결합
  (bare "Quota"는 잔량 게이지 전용). 분류는 `(agent, provider)` 기본표 + `billing.overrides`
  (2026-08-14~15 개정, `local_docs/costs/2026-08-15-quota-cost-rename-plan.md`)
- 수집은 각 에이전트가 스스로 남기는 로그·저장소만 읽는다. 서드파티 도구가 만든 캐시나
  레지스트리는 포맷이 비문서화이고 그 도구가 돌지 않으면 멈추므로 의존하지 않는다
  (Antigravity IDE 세션은 그래서 아직 미지원)
