import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameDecoder,
  encodeResponse,
  decodeResponse,
  frame,
} from '../src/codec';

test('frame round-trips a response through the node framing', () => {
  const payload = encodeResponse('Announced');
  const framed = frame(payload);
  assert.equal(framed.readUInt32BE(0), payload.length);
  const decoder = new FrameDecoder();
  const frames = decoder.push(frame(encodeResponse('Announced')));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.compare(payload), 0);
});

test('FrameDecoder reassembles split frames', () => {
  const framed = frame(encodeResponse('Dialed'));
  const d = new FrameDecoder();
  assert.equal(d.push(framed.subarray(0, 3)).length, 0);
  const frames = d.push(framed.subarray(3));
  assert.equal(frames.length, 1);
  assert.deepEqual(decodeResponse(frames[0]!), 'Dialed');
});

test('FrameDecoder carries fractional frames between chunks', () => {
  const d = new FrameDecoder();
  const pa = encodeResponse('Announced');
  const pb = encodeResponse('Dialed');
  const p1 = frame(pa);
  const p2 = frame(pb);
  const combined = Buffer.concat([p1, p2]);
  const cut = 6;
  const out: Buffer[] = [];
  out.push(...d.push(combined.subarray(0, cut)));
  out.push(...d.push(combined.subarray(cut)));
  assert.equal(out.length, 2);
  assert.equal(out[0]!.compare(pa), 0);
  assert.equal(out[1]!.compare(pb), 0);
});