# daily-econ-brief

매일 아침(KST) 자동으로 갱신되는 경제 뉴스 & 이벤트 브리핑 페이지.

## 동작 방식

1. GitHub Actions(`.github/workflows/update-data.yml`)가 매일 UTC 22:00(KST 07:00)에 `scripts/fetch-data.mjs`를 실행합니다.
2. 이 스크립트가 [Finnhub](https://finnhub.io) 뉴스 API와 [FRED](https://fred.stlouisfed.org)(세인트루이스 연은) 발표 일정 API를 호출해 `data/latest.json`을 갱신하고 커밋/푸시합니다.
3. `index.html`은 정적 페이지로, 로드 시 `data/latest.json`을 fetch해 렌더링합니다. 빌드 과정이 없어 GitHub Pages에 그대로 배포됩니다.

## 최초 설정

### 1. API 키 발급
- Finnhub: https://finnhub.io/register → 가입 후 대시보드에서 API 키 확인
- FRED: https://fred.stlouisfed.org/docs/api/api_key.html → 가입 후 API 키 신청 (보통 즉시 발급)

### 2. GitHub Secrets 등록
저장소 루트에서:
```
gh secret set FINNHUB_API_KEY
gh secret set FRED_API_KEY
```
(붙여넣기 프롬프트가 뜨면 발급받은 키 값을 입력하세요. 키는 절대 코드/커밋에 넣지 마세요.)

### 3. GitHub Pages 활성화
저장소 Settings → Pages → **Deploy from a branch** → `main` / `(root)` 선택.

### 4. 수동 실행으로 최초 데이터 확인
```
gh workflow run update-data.yml
gh run watch
```

## 유지보수
- `scripts/fetch-data.mjs`의 `FOMC_MEETINGS_2026` 배열은 연준이 다음 해 일정을 공식 발표하면 연 1회 수동으로 갱신해야 합니다.
- `data/latest.json`은 초기 샘플 데이터(2026-08-25 기준)로 커밋되어 있으며, 워크플로가 처음 실행되면 실제 데이터로 덮어써집니다.
