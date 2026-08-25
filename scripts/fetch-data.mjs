// 매일 GitHub Actions에서 실행되어 data/latest.json을 갱신하는 스크립트.
// Finnhub(뉴스) + FRED(발표 일정) API를 호출하고, FOMC 일정은 연준이 연초에 미리
// 공개하는 공식 캘린더를 사용해 하드코딩한다 (연 1회 갱신 필요).

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;

if (!FINNHUB_API_KEY || !FRED_API_KEY) {
  console.error("FINNHUB_API_KEY / FRED_API_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

const ECONOMIC_KEYWORDS =
  /\b(fed|fomc|rate|inflation|cpi|pce|jobs?|payroll|unemployment|gdp|treasury|yield|dollar|oil|opec|ecb|boj|econom|tariff|recession|interest rate)\b/i;

// 연준이 매년 초 공식 발표하는 FOMC 정례회의 일정 (연 1회 수동 갱신).
// SEP(경제전망요약/점도표)가 포함되는 회의: 3월, 6월, 9월, 12월.
const FOMC_MEETINGS_2026 = [
  { start: "2026-01-27", end: "2026-01-28", sep: false },
  { start: "2026-03-17", end: "2026-03-18", sep: true },
  { start: "2026-04-28", end: "2026-04-29", sep: false },
  { start: "2026-06-16", end: "2026-06-17", sep: true },
  { start: "2026-07-28", end: "2026-07-29", sep: false },
  { start: "2026-09-15", end: "2026-09-16", sep: true },
  { start: "2026-10-27", end: "2026-10-28", sep: false },
  { start: "2026-12-08", end: "2026-12-09", sep: true },
];

// FRED release_id: 주요 경제지표 발표 일정 조회용.
const FRED_RELEASES = [
  { id: 10, title: "소비자물가지수(CPI) 발표" },
  { id: 50, title: "고용상황 보고서(비농업고용) 발표" },
  { id: 54, title: "개인소득 및 지출(PCE 물가지수) 발표" },
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function fetchNews() {
  const url = `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub 호출 실패: ${res.status}`);
  const items = await res.json();

  return items
    .filter((item) => ECONOMIC_KEYWORDS.test(`${item.headline} ${item.summary}`))
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, 8)
    .map((item) => ({
      headline: item.headline,
      summary: item.summary,
      source: item.source,
      url: item.url,
      published_at: new Date(item.datetime * 1000).toISOString(),
    }));
}

async function fetchFredNextDate(releaseId) {
  const params = new URLSearchParams({
    release_id: String(releaseId),
    realtime_start: todayISO(),
    realtime_end: addDaysISO(120),
    include_release_dates_with_no_data: "true",
    sort_order: "asc",
    file_type: "json",
    api_key: FRED_API_KEY,
  });
  const url = `https://api.stlouisfed.org/fred/release/dates?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED 호출 실패 (release ${releaseId}): ${res.status}`);
  const data = await res.json();
  const dates = data.release_dates || [];
  return dates.length > 0 ? dates[0].date : null;
}

async function buildCalendar() {
  const calendar = [];

  for (const release of FRED_RELEASES) {
    const date = await fetchFredNextDate(release.id);
    if (date) {
      calendar.push({
        date,
        title: release.title,
        description: "미국 정부기관 공식 발표 일정 (FRED 기준)",
        importance: "high",
      });
    }
  }

  const today = todayISO();
  for (const meeting of FOMC_MEETINGS_2026) {
    if (meeting.end >= today) {
      calendar.push({
        date: meeting.start,
        title: `FOMC 정례회의 (~${meeting.end.slice(5)})`,
        description: meeting.sep
          ? "금리 결정 발표 및 경제전망요약(SEP)·점도표 공개"
          : "금리 결정 발표",
        importance: "high",
      });
      break; // 다음 회의 하나만 캘린더에 노출
    }
  }

  calendar.sort((a, b) => a.date.localeCompare(b.date));
  return calendar;
}

async function main() {
  const [news, calendar] = await Promise.all([fetchNews(), buildCalendar()]);

  const output = {
    generated_at: new Date().toISOString(),
    news,
    calendar,
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile(
    new URL("../data/latest.json", import.meta.url),
    JSON.stringify(output, null, 2) + "\n"
  );

  console.log(`data/latest.json 갱신 완료: 뉴스 ${news.length}건, 이벤트 ${calendar.length}건`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
