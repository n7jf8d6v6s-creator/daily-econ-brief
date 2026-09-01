// settleWithFallback 만 확인한다: 섹션 하나가 실패했을 때 직전 값으로 메우는지,
// 메울 값이 없으면 제대로 터지는지. (2026-09-01 CoinGecko 429 로 하루치가 날아간 건)
import assert from "node:assert/strict";
import { settleWithFallback } from "./fetch-data.mjs";

const ok = (v) => Promise.resolve(v);
const bad = () => Promise.reject(new Error("429"));

const warn = console.warn;
console.warn = () => {};

assert.deepEqual(
  await settleWithFallback([ok("a"), ok("b")], [null, null], ["A", "B"]),
  ["a", "b"],
  "모두 성공하면 새 값을 쓴다"
);

assert.deepEqual(
  await settleWithFallback([ok("a"), bad()], ["old-a", "old-b"], ["A", "B"]),
  ["a", "old-b"],
  "실패한 섹션만 직전 값으로 메운다"
);

assert.deepEqual(
  await settleWithFallback([bad()], [[]], ["A"]),
  [[]],
  "빈 배열도 유효한 직전 값이다"
);

await assert.rejects(
  settleWithFallback([bad()], [null], ["A"]),
  /429/,
  "직전 값이 없으면 실패시킨다"
);

console.warn = warn;
console.log("ok");
