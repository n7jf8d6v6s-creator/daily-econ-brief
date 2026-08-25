// 매일 GitHub Actions에서 실행되어 data/latest.json을 갱신하는 스크립트.
// Finnhub(뉴스+주식 시세) + CoinGecko(코인 시세) + FRED(발표 일정) API를 호출하고,
// Claude API로 시황 인사이트 생성 및 뉴스 한글 번역까지 수행한다.
// FOMC 일정은 연준이 연초에 미리 공개하는 공식 캘린더를 사용해 하드코딩한다 (연 1회 갱신 필요).

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!FINNHUB_API_KEY || !FRED_API_KEY || !ANTHROPIC_API_KEY) {
  console.error(
    "FINNHUB_API_KEY / FRED_API_KEY / ANTHROPIC_API_KEY 환경변수가 모두 필요합니다."
  );
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

// 주식 워치리스트 (미 빅테크 + 주요 지수 ETF).
const STOCK_WATCHLIST = [
  { symbol: "AAPL", name: "애플" },
  { symbol: "MSFT", name: "마이크로소프트" },
  { symbol: "NVDA", name: "엔비디아" },
  { symbol: "TSLA", name: "테슬라" },
  { symbol: "AMZN", name: "아마존" },
  { symbol: "GOOGL", name: "알파벳(구글)" },
  { symbol: "META", name: "메타" },
  { symbol: "SPY", name: "S&P 500 ETF" },
  { symbol: "QQQ", name: "나스닥100 ETF" },
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
  if (!res.ok) throw new Error(`Finnhub 뉴스 호출 실패: ${res.status}`);
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

async function fetchStockQuotes() {
  const quotes = [];
  for (const stock of STOCK_WATCHLIST) {
    const url = `https://finnhub.io/api/v1/quote?symbol=${stock.symbol}&token=${FINNHUB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub 시세 호출 실패 (${stock.symbol}): ${res.status}`);
    const q = await res.json();
    quotes.push({
      symbol: stock.symbol,
      name: stock.name,
      price: q.c,
      change_pct: q.dp,
    });
  }
  return quotes;
}

async function fetchCryptoMovers() {
  const params = new URLSearchParams({
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: "20",
    page: "1",
    price_change_percentage: "24h",
    sparkline: "false",
  });
  const url = `https://api.coingecko.com/api/v3/coins/markets?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko 호출 실패: ${res.status}`);
  const coins = await res.json();

  const mapped = coins.map((c) => ({
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    price: c.current_price,
    change_pct: c.price_change_percentage_24h,
  }));

  const pinned = mapped.filter((c) => c.symbol === "BTC" || c.symbol === "ETH");
  const rest = mapped.filter((c) => c.symbol !== "BTC" && c.symbol !== "ETH");
  const gainers = [...rest].sort((a, b) => b.change_pct - a.change_pct).slice(0, 4);
  const losers = [...rest].sort((a, b) => a.change_pct - b.change_pct).slice(0, 4);

  const seen = new Set();
  const combined = [];
  for (const coin of [...pinned, ...gainers, ...losers]) {
    if (seen.has(coin.symbol)) continue;
    seen.add(coin.symbol);
    combined.push(coin);
  }
  return combined;
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

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Claude 응답에서 JSON을 찾지 못했습니다.");
  return JSON.parse(text.slice(start, end + 1));
}

async function generateInsightAndTranslation(market, news) {
  const prompt = `당신은 한국어로 글을 쓰는 경제/시장 애널리스트입니다. 아래 오늘의 주식·코인 시세 데이터와 영어 뉴스 목록을 참고해서 세 가지를 작성하세요.

1. insight_ko: 오늘 시장에서 눈에 띄게 급등하거나 급락한 종목/코인을 2~4개 짚어 그 배경을 뉴스 내용과 연결지어 설명하되, 가독성을 위해 **문자열 배열**로 2~4개 문단을 나눠 작성하세요 (각 문단 2~3문장). 예: 1문단은 오늘 시장 전반 요약, 2문단은 상승세를 보인 종목/코인과 이유, 3문단은 하락세를 보인 종목/코인과 이유. 확정적 인과관계 단정은 피하고 "~로 해석된다", "~영향으로 보인다"처럼 서술하세요. 마지막 문단의 마지막 문장은 반드시 이 내용이 투자 조언이 아니라는 안내로 끝내세요.
2. insight_movers: insight_ko 문단에서 실제로 언급한 종목/코인만, 언급한 개수만큼 뽑아서 symbol(입력 시세 데이터의 symbol과 정확히 동일한 문자열)과 reason_ko(그 종목이 왜 언급됐는지 8~16자 내외의 짧은 한 줄 태그, 예: "AI 반도체 수요 기대")를 작성하세요.
3. news_ko: 아래 news 배열과 정확히 같은 순서, 같은 개수로 각 기사마다 네 가지를 작성하세요. 원문의 사실관계를 왜곡하지 마세요.
   - headline_ko: 자연스러운 한국어 헤드라인
   - summary_ko: 한국어 요약 (1~2문장)
   - detail_ko: 이 기사의 배경과 맥락을 설명하는 애널리스트 해설(3~5문장). 원문을 그대로 옮기지 말고, headline/summary에서 알 수 있는 사실을 바탕으로 당신이 직접 풀어서 설명하세요.
   - impact_ko: 이 뉴스가 시장이나 경제에 미칠 수 있는 예상 파급효과(2~4문장). "~할 가능성이 있다", "~로 이어질 수 있다"처럼 완곡하게 서술하고 확정적 예측은 피하세요.

다른 설명 없이 아래 JSON 스키마로만 응답하세요:
{"insight_ko": ["string", "string"], "insight_movers": [{"symbol": "string", "reason_ko": "string"}], "news_ko": [{"headline_ko": "string", "summary_ko": "string", "detail_ko": "string", "impact_ko": "string"}]}

시세 데이터(JSON):
${JSON.stringify(market)}

뉴스 목록(JSON):
${JSON.stringify(news.map((n) => ({ headline: n.headline, summary: n.summary })))}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 8192,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API 호출 실패: ${res.status} ${body}`);
  }

  const data = await res.json();
  const text = data.content.map((block) => block.text || "").join("");
  return extractJson(text);
}

async function main() {
  const [news, calendar, stocks, crypto] = await Promise.all([
    fetchNews(),
    buildCalendar(),
    fetchStockQuotes(),
    fetchCryptoMovers(),
  ]);

  const market = { stocks, crypto };
  const { insight_ko, insight_movers, news_ko } = await generateInsightAndTranslation(
    market,
    news
  );

  const allInstruments = [
    ...stocks.map((s) => ({ ...s, type: "stock" })),
    ...crypto.map((c) => ({ ...c, type: "crypto" })),
  ];
  const resolvedMovers = (insight_movers || [])
    .map((m) => {
      const found = allInstruments.find(
        (item) => item.symbol.toUpperCase() === String(m.symbol).toUpperCase()
      );
      if (!found) return null;
      return { ...found, reason_ko: m.reason_ko };
    })
    .filter(Boolean);

  const translatedNews = news.map((item, i) => ({
    ...item,
    headline_ko: news_ko[i]?.headline_ko ?? item.headline,
    summary_ko: news_ko[i]?.summary_ko ?? item.summary,
    detail_ko: news_ko[i]?.detail_ko ?? "",
    impact_ko: news_ko[i]?.impact_ko ?? "",
  }));

  const output = {
    generated_at: new Date().toISOString(),
    market,
    insight: {
      paragraphs_ko: Array.isArray(insight_ko) ? insight_ko : [insight_ko],
      movers: resolvedMovers,
    },
    news: translatedNews,
    calendar,
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile(
    new URL("../data/latest.json", import.meta.url),
    JSON.stringify(output, null, 2) + "\n"
  );

  console.log(
    `data/latest.json 갱신 완료: 주식 ${stocks.length}종목, 코인 ${crypto.length}종목, 뉴스 ${translatedNews.length}건, 이벤트 ${calendar.length}건`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
