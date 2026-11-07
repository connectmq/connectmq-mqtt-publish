'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../src/lib');
const { topicMatches } = require('../src/main');

test('client id suffix', () => {
  const env = { GITHUB_RUN_ID: '42' };
  assert.match(lib.buildClientId('dev1', true, env), /^dev1_gha-42-[0-9a-f]{6}$/);
  assert.strictEqual(lib.buildClientId('dev1', false, env), 'dev1');
  assert.match(lib.buildClientId('', true, env), /^gha-42-[0-9a-f]{6}$/);
});

test('urls and ports', () => {
  assert.strictEqual(lib.buildUrl('wss', 'broker.connectmq.com', 8084, '/mqtt'), 'wss://broker.connectmq.com:8084/mqtt');
  assert.strictEqual(lib.buildUrl('mqtts', 'broker.connectmq.com', 8883), 'mqtts://broker.connectmq.com:8883');
  assert.strictEqual(lib.DEFAULT_PORTS.mqtts, 8883);
});

test('input parsing', () => {
  assert.strictEqual(lib.parseMqttVersion('3.1.1'), 4);
  assert.strictEqual(lib.parseMqttVersion(''), 5);
  assert.throws(() => lib.parseIntInRange('3', 'qos', 1, 0, 2));
  assert.throws(() => lib.validateTopic('a/+/b', 'topic', false));
  assert.doesNotThrow(() => lib.validateTopic('a/+/b/#', 'wait-topic', true));
  assert.throws(() => lib.validateTopic('a/b#', 'wait-topic', true));
  assert.deepStrictEqual(lib.parseUserProperties('{"a":1,"b":["x",2]}'), { a: '1', b: ['x', '2'] });
  assert.throws(() => lib.parseUserProperties('[1]'));
});

test('reason codes', () => {
  assert.match(lib.describeReasonCode(0x87, 5), /Not authorized \(reason code 0x87\)/);
  assert.match(lib.describeReasonCode(0x85, 5), /Client identifier not valid/);
  assert.match(lib.describeReasonCode(0x97, 5), /Quota exceeded/);
  assert.match(lib.describeReasonCode(5, 4), /not authorized/);
});

test('topic matching', () => {
  assert.ok(topicMatches('a/+/c', 'a/b/c'));
  assert.ok(topicMatches('a/#', 'a/b/c'));
  assert.ok(!topicMatches('a/b', 'a/b/c'));
});
