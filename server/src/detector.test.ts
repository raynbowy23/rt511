/** Tests for the detector client.
 *
 * The failure that matters here is a missing count being read as a count of zero, or a detector fault holding the arbiter back. A zero is the answer "the road is empty", which is exactly the answer the gate must never invent. Nothing here touches the network. */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Detector, createDetect, type Detect, type VehicleCount } from './detector.js';
import type { Frame } from './poller.js';

const temporaryDirectories: string[] = [];
const detectors: Detector[] = [];
after(async () => {
  await Promise.all(detectors.map((detector) => detector.drain()));
  for (const path of temporaryDirectories) rmSync(path, { recursive: true, force: true });
});

function dir(): string {
  const path = mkdtempSync(join(tmpdir(), 'rt511-detector-'));
  temporaryDirectories.push(path);
  return path;
}

const count = (vehicles: number): VehicleCount => ({ vehicles, by_class: vehicles ? { car: vehicles } : {}, confidences: [], model: 'yolo26n', latency_ms: 20 });

function frame(ts: number): Frame {
  return { ts, last_modified: null, data: Buffer.from('jpeg'), content_type: 'image/jpeg', brightness: 0.3, diff: 0.001 };
}

/** A detector that has already been found, so the tests start from the state a running server is in. */
async function ready(detect: Detect, logDir = dir()): Promise<Detector> {
  const detector = new Detector(detect, logDir, async () => 'yolo26n');
  detectors.push(detector);
  detector.look();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(detector.enabled);
  return detector;
}

test('a still frame is counted once, pending until the count lands, and the count belongs to that frame alone', async () => {
  let calls = 0;
  const detector = await ready(async () => {
    calls++;
    return count(4);
  });
  assert.equal(detector.evidence(1, frame(100)), 'pending');
  assert.equal(detector.evidence(1, frame(100)), 'pending', 'asked again while in flight, still one call');
  await detector.drain();
  const held = detector.evidence(1, frame(100));
  assert.notEqual(held, null);
  assert.notEqual(held, 'pending');
  assert.equal(typeof held === 'object' && held ? held.count.vehicles : -1, 4);
  assert.equal(calls, 1);
  // A newer frame is a new question, and the old count is not evidence about it.
  assert.equal(detector.evidence(1, frame(160)), 'pending');
  await detector.drain();
  assert.equal(calls, 2);
});

test('no detector, or one that was never found, means no count rather than zero, and never holds the arbiter back', () => {
  const none = new Detector(null, dir());
  assert.equal(none.evidence(1, frame(100)), null);
  const missing = new Detector(async () => count(3), dir(), async () => {
    throw new Error('ECONNREFUSED');
  });
  detectors.push(missing);
  assert.equal(missing.evidence(1, frame(100)), null);
  assert.equal(missing.enabled, false);
});

test('a detector fault is not retried on the same frame and does not stop the arbiter being asked', async () => {
  let calls = 0;
  const detector = await ready(async () => {
    calls++;
    throw new Error('ECONNRESET');
  });
  assert.equal(detector.evidence(2, frame(100)), 'pending');
  await detector.drain();
  assert.equal(detector.evidence(2, frame(100)), null);
  // The detector is left alone for the retry window, so another camera is asked about without a count rather than waiting.
  assert.equal(detector.evidence(3, frame(100)), null);
  assert.equal(calls, 1);
});

test('every count is logged with the frame it came from', async () => {
  const logDir = dir();
  const detector = await ready(async () => count(2), logDir);
  detector.evidence(5, frame(100));
  await detector.drain();
  const [line] = readFileSync(join(logDir, logFile(logDir)), 'utf8').trim().split('\n');
  const record = JSON.parse(line as string) as { camera: number; frame_ts: number; vehicles: number };
  assert.equal(record.camera, 5);
  assert.equal(record.frame_ts, 100);
  assert.equal(record.vehicles, 2);
});

test('a detector answer without a count is a failure, not an empty road', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'yolo26n' }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(() => createDetect('http://127.0.0.1:1').detect(Buffer.from('jpeg'), 'image/jpeg'), /missing a count/);
  } finally {
    globalThis.fetch = original;
  }
});

function logFile(path: string): string {
  const file = readdirSync(path).find((name) => name.startsWith('detector-'));
  assert.ok(file);
  return file;
}
