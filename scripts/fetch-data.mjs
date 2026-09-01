// 매일 GitHub Actions에서 실행되어 data/latest.json을 갱신하는 스크립트.
// Finnhub(뉴스+주식 시세) + CoinGecko(코인 시세) + FRED(발표 일정) API를 호출하고,
// Claude API로 시황 인사이트 생성 및 뉴스 한글 번역까지 수행한다.
// 캔들차트용 일봉 1년치는 Yahoo Finance 차트 엔드포인트(키 불필요)에서 받아
// data/history.json에 따로 저장한다 (latest.json의 diff 가독성을 지키기 위해 분리).
// FOMC 일정은 연준이 연초에 미리 공개하는 공식 캘린더를 사용해 하드코딩한다 (연 1회 갱신 필요).

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 공용 fetch. CoinGecko 무료 API 는 GitHub Actions 의 공용 IP 를 429 로 자주 막고
// 그 한 번이 하루치 갱신 전체를 날려버렸다. 일시적인 429/5xx 는 쉬었다가 다시 친다.
async function fetchJson(url, { headers, label, method, body } = {}) {
  let status = 0;
  let detail = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 5000));
    const res = await fetch(url, { headers, method, body });
    if (res.ok) return res.json();
    status = res.status;
    detail = (await res.text().catch(() => "")).slice(0, 200);
    if (status !== 429 && status < 500) break;
  }
  throw new Error(`${label} 호출 실패: ${status} ${detail}`);
}

// 섹션 하나가 끝내 실패해도 그날 갱신을 통째로 버리지 않고 직전 값을 그대로 쓴다.
// 직전 값조차 없으면(첫 실행) 그때는 그냥 실패시킨다.
// 어떤 섹션이 직전 값으로 때워졌는지는 stale 에 남긴다. 조용히 어제 데이터를
// 새 타임스탬프로 커밋해버리면 고장난 걸 아무도 눈치채지 못한다.
export async function settleWithFallback(tasks, fallbacks, labels, stale = []) {
  const results = await Promise.allSettled(tasks);
  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    if (fallbacks[i] === undefined || fallbacks[i] === null) throw r.reason;
    console.warn(`${labels[i]} 갱신 실패, 직전 값 유지: ${r.reason.message}`);
    stale.push(labels[i]);
    return fallbacks[i];
  });
}

async function readPrevious(name) {
  try {
    const fs = await import("node:fs/promises");
    return JSON.parse(
      await fs.readFile(new URL(`../data/${name}`, import.meta.url), "utf8")
    );
  } catch {
    return null;
  }
}

const ECONOMIC_KEYWORDS =
  /\b(fed|fomc|rate|inflation|cpi|pce|jobs?|payroll|unemployment|gdp|treasury|yield|dollar|oil|opec|ecb|boj|econom|tariff|recession|interest rate)\b/i;

// 연준 공식 캘린더(federalreserve.gov/monetarypolicy/fomccalendars.htm)의 정례회의 일정.
// API 가 없어서 손으로 옮겨 적는다. SEP(경제전망요약/점도표)가 붙는 회의는 3·6·9·12월.
// 목록이 다 지나가면 캘린더에서 FOMC 가 조용히 빠지므로, main() 이 그때 실행을
// 실패로 떨어뜨려 알려준다. 그러면 다음 해 일정을 여기에 이어 붙이면 된다.
const FOMC_MEETINGS = [
  { start: "2026-01-27", end: "2026-01-28", sep: false },
  { start: "2026-03-17", end: "2026-03-18", sep: true },
  { start: "2026-04-28", end: "2026-04-29", sep: false },
  { start: "2026-06-16", end: "2026-06-17", sep: true },
  { start: "2026-07-28", end: "2026-07-29", sep: false },
  { start: "2026-09-15", end: "2026-09-16", sep: true },
  { start: "2026-10-27", end: "2026-10-28", sep: false },
  { start: "2026-12-08", end: "2026-12-09", sep: true },
  { start: "2027-01-26", end: "2027-01-27", sep: false },
  { start: "2027-03-16", end: "2027-03-17", sep: true },
  { start: "2027-04-27", end: "2027-04-28", sep: false },
  { start: "2027-06-08", end: "2027-06-09", sep: true },
  { start: "2027-07-27", end: "2027-07-28", sep: false },
  { start: "2027-09-14", end: "2027-09-15", sep: true },
  { start: "2027-10-26", end: "2027-10-27", sep: false },
  { start: "2027-12-07", end: "2027-12-08", sep: true },
];

// FRED release_id: 주요 경제지표 발표 일정 조회용.
const FRED_RELEASES = [
  {
    id: 10,
    title: "소비자물가지수(CPI) 발표",
    agency: "미 노동통계국(BLS)",
    what: "미국 도시 소비자가 실제로 지불하는 상품·서비스 가격을 묶어 만든 물가지수입니다. 식품과 에너지를 뺀 근원(core) CPI가 추세 판단에 더 많이 쓰입니다.",
    why: "연준이 금리를 올릴지 내릴지 판단할 때 보는 대표적인 물가 지표입니다. 시장 예상보다 높게 나오면 금리 인하 기대가 밀리면서 주식과 채권이 함께 약해지는 경우가 많습니다.",
    watch: "전월 대비 근원 CPI가 0.3%를 넘는지, 그리고 주거비 항목이 둔화되는지를 봅니다.",
  },
  {
    id: 50,
    title: "고용상황 보고서(비농업고용) 발표",
    agency: "미 노동통계국(BLS)",
    what: "농업을 제외한 산업에서 한 달 동안 늘어난 일자리 수와 실업률, 시간당 임금을 함께 발표합니다. 매달 첫째 주 금요일에 나와 '고용지표의 본편'으로 불립니다.",
    why: "고용이 너무 뜨거우면 임금이 오르고 물가 압력이 남아 금리 인하가 늦어집니다. 반대로 급격히 식으면 경기 침체 우려가 커집니다. 시장은 어느 한쪽으로 크게 벗어나지 않는 수치를 선호합니다.",
    watch: "신규 고용자 수뿐 아니라 지난 두 달치 수정폭과 시간당 임금 상승률을 함께 봐야 방향이 보입니다.",
  },
  {
    id: 54,
    title: "개인소득 및 지출(PCE 물가지수) 발표",
    agency: "미 경제분석국(BEA)",
    what: "가계가 벌어들인 소득과 실제로 쓴 돈, 그리고 그 과정의 물가를 함께 보여줍니다. 여기 포함된 근원 PCE 물가지수가 연준의 공식 물가 목표(2%) 기준입니다.",
    why: "CPI보다 덜 알려져 있지만 연준이 정책 목표로 삼는 지표는 이쪽입니다. 소비자가 비싼 품목에서 싼 품목으로 옮겨가는 행동까지 반영해 CPI보다 대체로 낮게 나옵니다.",
    watch: "근원 PCE의 전년 대비 상승률이 2%에 얼마나 가까워졌는지, 서비스 물가가 계속 버티는지를 봅니다.",
  },
];

// FOMC 회의 해설 (SEP 포함 여부에 따라 관전 포인트가 달라진다).
const FOMC_EXPLAIN = {
  agency: "미 연방준비제도(Fed)",
  what: "연준의 통화정책 결정 기구가 이틀간 모여 기준금리를 정하는 회의입니다. 둘째 날 오후에 결정문이 나오고 이어서 의장 기자회견이 열립니다.",
  why: "미국 기준금리는 전 세계 자금의 기준값이라, 결정 자체보다 '앞으로의 방향'을 어떻게 말하는지가 주식·채권·환율·코인 전반을 움직입니다.",
  watchSep:
    "이번 회의는 경제전망요약(SEP)과 점도표가 함께 공개됩니다. 위원들이 연말 금리를 어디로 보는지가 점으로 찍혀 나와, 금리 결정 자체보다 파급력이 큰 경우가 많습니다.",
  watchPlain:
    "전망 자료 없이 결정문과 기자회견만 나옵니다. 결정문에서 바뀐 단어와 의장의 답변 톤이 관전 포인트입니다.",
};

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
  const items = await fetchJson(url, { label: "Finnhub 뉴스" });

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
    const q = await fetchJson(url, { label: `Finnhub 시세 (${stock.symbol})` });
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
  const coins = await fetchJson(url, { label: "CoinGecko" });

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

// 캔들차트용 일봉. 차트에서 좌우로 넘기고 확대하려면 화면에 보이는 것보다 넉넉한
// 기간이 필요해 1년치를 받는다. 종목 하나가 실패해도 그 종목만 차트가 빠진다.
async function fetchDailyBars(instrument) {
  const ySymbol = instrument.type === "crypto" ? `${instrument.symbol}-USD` : instrument.symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ySymbol
  )}?range=1y&interval=1d`;
  const json = await fetchJson(url, {
    headers: { "user-agent": "Mozilla/5.0" },
    label: ySymbol,
  });
  const result = json?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const stamps = result?.timestamp;
  if (!stamps || !quote) throw new Error("빈 응답");

  const bars = [];
  for (let i = 0; i < stamps.length; i++) {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    // 저가 코인은 소수점이 더 필요하고, 고가 종목은 2자리면 충분하다 (파일 크기 절약).
    const digits = c < 1 ? 6 : c < 100 ? 4 : 2;
    const round = (v) => Number(v.toFixed(digits));
    bars.push([stamps[i], round(o), round(h), round(l), round(c)]);
  }
  if (bars.length === 0) throw new Error("유효한 봉 없음");
  return bars;
}

async function fetchHistory(instruments, previous) {
  const history = {};
  const missing = [];
  for (const instrument of instruments) {
    try {
      history[instrument.symbol] = await fetchDailyBars(instrument);
    } catch (err) {
      // 오늘 못 받았다고 차트를 지우지 않는다. 어제 봉이라도 그리는 편이 낫다.
      if (previous?.[instrument.symbol]) history[instrument.symbol] = previous[instrument.symbol];
      missing.push(`${instrument.symbol}(${err.message})`);
    }
  }
  if (missing.length > 0) {
    console.warn(`일봉 없음: ${missing.join(", ")}`);
  }
  return history;
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
  const data = await fetchJson(url, { label: `FRED (release ${releaseId})` });
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
        agency: release.agency,
        what: release.what,
        why: release.why,
        watch: release.watch,
      });
    }
  }

  const today = todayISO();
  for (const meeting of FOMC_MEETINGS) {
    if (meeting.end >= today) {
      calendar.push({
        date: meeting.start,
        title: `FOMC 정례회의 (~${meeting.end.slice(5)})`,
        agency: FOMC_EXPLAIN.agency,
        what: FOMC_EXPLAIN.what,
        why: FOMC_EXPLAIN.why,
        watch: meeting.sep ? FOMC_EXPLAIN.watchSep : FOMC_EXPLAIN.watchPlain,
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

1. insight_ko: 오늘 시장에서 눈에 띄게 급등하거나 급락한 종목/코인을 2~4개 짚어 그 배경을 뉴스 내용과 연결지어 설명하되, 가독성을 위해 **문자열 배열**로 2~4개 문단을 나눠 작성하세요 (각 문단 2~3문장). 예: 1문단은 오늘 시장 전반 요약, 2문단은 상승세를 보인 종목/코인과 이유, 3문단은 하락세를 보인 종목/코인과 이유.
   - 절대 "A는 +2%, B는 -3%, C는 +1%..." 식으로 등락률만 나열하는 시세 브리핑을 쓰지 마세요. 왜(why) 그런 움직임이 나타났는지가 핵심입니다.
   - 코인 문단도 예외 없이 같은 기준을 적용하세요: 단순 시세 나열이 아니라, 제공된 뉴스의 매크로 맥락(지정학적 리스크, 달러 강세/약세, 금리 전망, 위험자산 선호/회피 심리 등)이나 코인 자체의 특성(예: 프라이버시 코인, 레이어1 경쟁, 스테이블코인 이슈 등)과 연결해 "왜 이 코인이 유독 강세/약세였는지"를 설명하세요. 연결 지을 근거가 부족하면 해당 코인은 굳이 언급하지 말고, 설명 가능한 종목/코인 위주로 문단을 구성하세요.
   - 확정적 인과관계 단정은 피하고 "~로 해석된다", "~영향으로 보인다"처럼 서술하세요. 마지막 문단의 마지막 문장은 반드시 이 내용이 투자 조언이 아니라는 안내로 끝내세요.
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

  const data = await fetchJson("https://api.anthropic.com/v1/messages", {
    label: "Claude API",
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

  const text = data.content.map((block) => block.text || "").join("");
  return extractJson(text);
}

async function main() {
  if (!FINNHUB_API_KEY || !FRED_API_KEY || !ANTHROPIC_API_KEY) {
    console.error(
      "FINNHUB_API_KEY / FRED_API_KEY / ANTHROPIC_API_KEY 환경변수가 모두 필요합니다."
    );
    process.exit(1);
  }

  const prev = await readPrevious("latest.json");
  const stale = [];

  // 남은 회의가 없으면 캘린더에서 FOMC 가 에러 없이 사라진다. 그건 알림 없이 썩는 것과
  // 같으므로 stale 로 올려 실행을 빨간불로 만든다 (데이터 자체는 그대로 나간다).
  if (!FOMC_MEETINGS.some((m) => m.end >= todayISO())) {
    stale.push("FOMC 일정(목록 소진, 연준 캘린더에서 다음 해 일정 추가 필요)");
  }
  const [news, calendar, stocks, crypto] = await settleWithFallback(
    [fetchNews(), buildCalendar(), fetchStockQuotes(), fetchCryptoMovers()],
    [prev?.news, prev?.calendar, prev?.market?.stocks, prev?.market?.crypto],
    ["뉴스", "발표 일정", "주식 시세", "코인 시세"],
    stale
  );

  const market = { stocks, crypto };
  const allInstruments = [
    ...stocks.map((s) => ({ ...s, type: "stock" })),
    ...crypto.map((c) => ({ ...c, type: "crypto" })),
  ];

  // 인사이트와 뉴스 해설은 같은 호출에서 나오므로 실패하면 같이 직전 값으로 돌아간다.
  // 번역만 직전 값을 쓰면 오늘 기사에 어제 한글 본문이 붙어버린다.
  let insight = prev?.insight;
  let translatedNews = prev?.news;
  try {
    const { insight_ko, insight_movers, news_ko } = await generateInsightAndTranslation(
      market,
      news
    );
    insight = {
      paragraphs_ko: Array.isArray(insight_ko) ? insight_ko : [insight_ko],
      movers: (insight_movers || [])
        .map((m) => {
          const found = allInstruments.find(
            (item) => item.symbol.toUpperCase() === String(m.symbol).toUpperCase()
          );
          if (!found) return null;
          return { ...found, reason_ko: m.reason_ko };
        })
        .filter(Boolean),
    };
    translatedNews = news.map((item, i) => ({
      ...item,
      headline_ko: news_ko[i]?.headline_ko ?? item.headline,
      summary_ko: news_ko[i]?.summary_ko ?? item.summary,
      detail_ko: news_ko[i]?.detail_ko ?? "",
      impact_ko: news_ko[i]?.impact_ko ?? "",
    }));
  } catch (err) {
    if (!insight || !translatedNews) throw err;
    console.warn(`인사이트·뉴스 해설 갱신 실패, 직전 값 유지: ${err.message}`);
    stale.push("인사이트·뉴스 해설");
  }

  const history = await fetchHistory(allInstruments, await readPrevious("history.json"));

  const output = {
    generated_at: new Date().toISOString(),
    stale_sections: stale,
    market,
    insight,
    news: translatedNews,
    calendar,
  };

  const fs = await import("node:fs/promises");
  await fs.writeFile(
    new URL("../data/latest.json", import.meta.url),
    JSON.stringify(output, null, 2) + "\n"
  );
  // 봉 데이터는 줄바꿈 없이 저장한다: 매일 커밋되므로 크기가 곧 저장소 증가분이다.
  await fs.writeFile(
    new URL("../data/history.json", import.meta.url),
    JSON.stringify(history) + "\n"
  );

  console.log(
    `갱신 완료: 주식 ${stocks.length}종목, 코인 ${crypto.length}종목, 뉴스 ${translatedNews.length}건, 이벤트 ${calendar.length}건, 일봉 ${
      Object.keys(history).length
    }종목`
  );
}

if (process.argv[1] === (await import("node:url")).fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
