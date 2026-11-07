'use strict';

const core = require('@actions/core');
const mqtt = require('mqtt');
const lib = require('./lib');

function topicMatches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length) return false;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function readInputs() {
  const password = core.getInput('password');
  if (password) core.setSecret(password);

  const protocol = lib.parseProtocol(core.getInput('protocol'));
  const mqttVersion = lib.parseMqttVersion(core.getInput('mqtt-version'));
  const host = core.getInput('host').trim() || 'broker.connectmq.com';
  const port = lib.parseIntInRange(core.getInput('port'), 'port', lib.DEFAULT_PORTS[protocol], 1, 65535);
  const topic = core.getInput('topic', { required: true }).trim();
  lib.validateTopic(topic, 'topic', false);
  const waitTopic = core.getInput('wait-topic').trim();
  if (waitTopic) lib.validateTopic(waitTopic, 'wait-topic', true);

  const userProperties = lib.parseUserProperties(core.getInput('user-properties'));
  if (userProperties && mqttVersion !== 5) {
    core.warning('"user-properties" requires MQTT 5; they are ignored with mqtt-version 3.1.1.');
  }

  return {
    protocol,
    mqttVersion,
    host,
    port,
    wsPath: core.getInput('ws-path') || '/mqtt',
    username: core.getInput('username'),
    password,
    clientId: lib.buildClientId(
      core.getInput('client-id'),
      lib.parseBool(core.getInput('client-id-suffix'), 'client-id-suffix', true)
    ),
    topic,
    message: core.getInput('message'),
    qos: lib.parseIntInRange(core.getInput('qos'), 'qos', 1, 0, 2),
    retain: lib.parseBool(core.getInput('retain'), 'retain', false),
    waitTopic,
    waitTimeout: lib.parseIntInRange(core.getInput('wait-timeout-seconds'), 'wait-timeout-seconds', 30, 1, 3600),
    connectTimeout: lib.parseIntInRange(core.getInput('connect-timeout-seconds'), 'connect-timeout-seconds', 30, 1, 300),
    userProperties: mqttVersion === 5 ? userProperties : undefined,
  };
}

function errorText(err, mqttVersion) {
  const code = err && err.code;
  if (typeof code === 'number') {
    return `${lib.describeReasonCode(code, mqttVersion)}${err.message ? ` [${err.message}]` : ''}`;
  }
  if (code === 'ENOTFOUND') return `Host not found (${err.message}). Check the "host" input.`;
  if (code === 'ECONNREFUSED') return `Connection refused (${err.message}). Check "host", "port" and "protocol".`;
  if (code === 'ECONNRESET') return `Connection reset by the broker (${err.message}). Wrong port/protocol combination or the broker closed the connection.`;
  if ((code && String(code).startsWith('ERR_TLS')) || /certificate|self.signed|SSL|TLS/i.test((err && err.message) || '')) {
    return `TLS error: ${err.message}. Make sure the port speaks TLS for mqtts/wss (ConnectMQ: 8883 for mqtts, 8084 for wss).`;
  }
  return (err && err.message) || String(err);
}

function connect(opts) {
  const url = lib.buildUrl(opts.protocol, opts.host, opts.port, opts.wsPath);
  core.info(`Connecting to ${url} as client "${opts.clientId}" (MQTT ${opts.mqttVersion === 5 ? '5.0' : '3.1.1'})`);

  return new Promise((resolve, reject) => {
    // Pass host/port/protocol explicitly (no URL string) to avoid Node's url.parse() deprecation warning.
    const client = mqtt.connect({
      protocol: opts.protocol,
      host: opts.host,
      port: opts.port,
      path: opts.protocol === 'ws' || opts.protocol === 'wss' ? new URL(url).pathname : undefined,
      servername: opts.host,
      clientId: opts.clientId,
      username: opts.username || undefined,
      password: opts.password || undefined,
      protocolVersion: opts.mqttVersion,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0,
      connectTimeout: opts.connectTimeout * 1000,
      rejectUnauthorized: true,
    });

    let settled = false;
    const timer = setTimeout(() => fail(new Error(`Timed out after ${opts.connectTimeout}s waiting for CONNACK.`)), opts.connectTimeout * 1000 + 1000);

    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end(true);
      reject(new Error(`Could not connect to ${url}: ${errorText(err, opts.mqttVersion)}`));
    }

    client.once('connect', (connack) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ client, connack });
    });
    client.once('error', fail);
    client.once('close', () => fail(new Error('Connection closed by the broker before CONNACK.')));
  });
}

async function run() {
  let client;
  const result = { published: false, reply: '', replyTopic: '' };
  try {
    const opts = readInputs();
    const conn = await connect(opts);
    client = conn.client;
    core.info('Connected.');

    let serverDisconnect = null;
    client.on('disconnect', (packet) => {
      serverDisconnect = packet;
      core.warning(`Broker sent DISCONNECT: ${lib.describeReasonCode(packet.reasonCode, opts.mqttVersion)}`);
    });

    // Subscribe to the reply topic BEFORE publishing so no reply is missed.
    let replyPromise = null;
    if (opts.waitTopic) {
      replyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No reply on "${opts.waitTopic}" within ${opts.waitTimeout}s.`)),
          opts.waitTimeout * 1000
        );
        client.on('message', (topic, payload) => {
          if (!topicMatches(opts.waitTopic, topic)) return;
          clearTimeout(timer);
          resolve({ topic, payload: payload.toString('utf8') });
        });
        client.on('close', () => {
          clearTimeout(timer);
          const reason = serverDisconnect ? `: ${lib.describeReasonCode(serverDisconnect.reasonCode, opts.mqttVersion)}` : '';
          reject(new Error(`Connection closed while waiting for a reply${reason}.`));
        });
      });
      replyPromise.catch(() => {}); // handled below

      const subOpts = { qos: Math.min(opts.qos, 1) };
      if (opts.mqttVersion === 5) subOpts.nl = true; // MQTT 5 "No Local": don't receive our own publish
      let granted;
      try {
        granted = await client.subscribeAsync(opts.waitTopic, subOpts);
      } catch (err) {
        throw new Error(`Subscribing to wait-topic "${opts.waitTopic}" failed: ${errorText(err, opts.mqttVersion)}`);
      }
      const g = granted && granted[0];
      if (g && g.qos >= 0x80) {
        throw new Error(`Subscribing to wait-topic "${opts.waitTopic}" was rejected: ${lib.describeReasonCode(g.qos, opts.mqttVersion)}`);
      }
      core.info(`Subscribed to "${opts.waitTopic}" (waiting up to ${opts.waitTimeout}s after publish).`);
    }

    const pubOpts = { qos: opts.qos, retain: opts.retain };
    if (opts.mqttVersion === 5) {
      const properties = {};
      if (opts.userProperties) properties.userProperties = opts.userProperties;
      if (opts.waitTopic && !/[+#]/.test(opts.waitTopic)) properties.responseTopic = opts.waitTopic;
      if (Object.keys(properties).length) pubOpts.properties = properties;
    }

    const size = Buffer.byteLength(opts.message, 'utf8');
    try {
      const ack = await client.publishAsync(opts.topic, opts.message, pubOpts);
      if (ack && typeof ack.reasonCode === 'number' && ack.reasonCode >= 0x80) {
        throw Object.assign(new Error('Publish rejected'), { code: ack.reasonCode });
      }
      if (ack && ack.reasonCode === 0x10) {
        core.info('Broker reports: no matching subscribers (message accepted).');
      }
    } catch (err) {
      throw new Error(`Publishing to "${opts.topic}" failed: ${errorText(err, opts.mqttVersion)}`);
    }
    result.published = true;
    core.info(`Published ${size} bytes to "${opts.topic}" (QoS ${opts.qos}${opts.retain ? ', retained' : ''}).`);

    if (replyPromise) {
      const reply = await replyPromise;
      result.reply = reply.payload;
      result.replyTopic = reply.topic;
      core.info(`Reply received on "${reply.topic}" (${Buffer.byteLength(reply.payload, 'utf8')} bytes).`);
    }
  } catch (err) {
    core.setFailed(err.message);
  } finally {
    core.setOutput('published', String(result.published));
    core.setOutput('reply', result.reply);
    core.setOutput('reply-topic', result.replyTopic);
    if (client) {
      try {
        await Promise.race([client.endAsync(), new Promise((r) => setTimeout(r, 3000))]);
      } catch (_) {
        client.end(true);
      }
    }
  }
}

module.exports = { run, topicMatches };
