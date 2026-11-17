import { test } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../lib/rateLimit.js";

const WINDOW_MS = 15 * 60_000;

function fakeReq(ip) {
  return { ip, socket: { remoteAddress: ip } };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; },
    status(code) { res.statusCode = code; return res; },
    send(body) { res.body = body; return res; },
  };
  return res;
}

function run(limiter, ip) {
  const res = fakeRes();
  let called = false;
  limiter(fakeReq(ip), res, () => { called = true; });
  return { res, called };
}

test("allows up to max requests, then blocks with 429 and Retry-After", () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ windowMs: WINDOW_MS, max: 10, now: () => clock });

  for (let i = 0; i < 10; i++) {
    const { res, called } = run(limiter, "1.2.3.4");
    assert.equal(res.statusCode, 200, `request ${i + 1} should pass`);
    assert.ok(called);
  }

  const { res, called } = run(limiter, "1.2.3.4");
  assert.equal(res.statusCode, 429);
  assert.ok(!called, "next() must not be called when blocked");
  assert.equal(res.headers["retry-after"], "900"); // full 15-minute window remains
  assert.match(res.body, /too many/i);
});

test("requests again after the window has passed", () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ windowMs: WINDOW_MS, max: 3, now: () => clock });

  for (let i = 0; i < 3; i++) run(limiter, "1.2.3.4");
  assert.equal(run(limiter, "1.2.3.4").res.statusCode, 429);

  clock += WINDOW_MS + 1;
  const { res, called } = run(limiter, "1.2.3.4");
  assert.equal(res.statusCode, 200);
  assert.ok(called);
});

test("each IP is limited independently", () => {
  const limiter = createRateLimiter({ windowMs: WINDOW_MS, max: 2 });

  assert.equal(run(limiter, "1.1.1.1").res.statusCode, 200);
  assert.equal(run(limiter, "1.1.1.1").res.statusCode, 200);
  assert.equal(run(limiter, "1.1.1.1").res.statusCode, 429);

  assert.equal(run(limiter, "2.2.2.2").res.statusCode, 200, "other IP unaffected");
});
