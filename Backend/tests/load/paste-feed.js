import http from 'k6/http';
import { check, sleep } from 'k6';

/**
 * Smoke load profile (docs/ARCHITECTURE.md §15, §19 phase 9).
 * Run: BASE_URL=http://127.0.0.1:3000 k6 run tests/load/paste-feed.js
 * SLO target: p95 < 150 ms on the warm read path (§18 trigger #1 stays far away).
 */
export const options = {
  vus: 20,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<150'],
    checks: ['rate>0.99'],
  },
};

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

export default function () {
  const feed = http.get(`${BASE}/api/v1/pastes?limit=10`);
  check(feed, { 'feed 200': (r) => r.status === 200 });

  const search = http.get(`${BASE}/api/v1/search?q=paste`);
  check(search, { 'search 200': (r) => r.status === 200 });

  const create = http.post(
    `${BASE}/api/v1/pastes`,
    JSON.stringify({
      content: `load test paste ${Math.random()} — anonymous creation budget applies`,
      visibility: 'unlisted',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(create, { 'create 201 or budget-limited': (r) => r.status === 201 || r.status === 429 });

  sleep(0.2);
}
