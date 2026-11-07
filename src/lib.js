'use strict';

const crypto = require('crypto');

const DEFAULT_PORTS = { mqtts: 8883, mqtt: 1883, wss: 8084, ws: 8083 };

// MQTT 5.0 reason codes (CONNACK, PUBACK, PUBREC, SUBACK, DISCONNECT).
const MQTT5_REASON_CODES = {
  0x04: 'Disconnect with Will Message',
  0x10: 'No matching subscribers',
  0x80: 'Unspecified error',
  0x81: 'Malformed packet',
  0x82: 'Protocol error',
  0x83: 'Implementation specific error',
  0x84: 'Unsupported protocol version',
  0x85: 'Client identifier not valid',
  0x86: 'Bad user name or password',
  0x87: 'Not authorized',
  0x88: 'Server unavailable',
  0x89: 'Server busy',
  0x8a: 'Banned',
  0x8b: 'Server shutting down',
  0x8c: 'Bad authentication method',
  0x8d: 'Keep alive timeout',
  0x8e: 'Session taken over',
  0x8f: 'Topic filter invalid',
  0x90: 'Topic name invalid',
  0x91: 'Packet identifier in use',
  0x93: 'Receive maximum exceeded',
  0x94: 'Topic alias invalid',
  0x95: 'Packet too large',
  0x96: 'Message rate too high',
  0x97: 'Quota exceeded',
  0x98: 'Administrative action',
  0x99: 'Payload format invalid',
  0x9a: 'Retain not supported',
  0x9b: 'QoS not supported',
  0x9c: 'Use another server',
  0x9d: 'Server moved',
  0x9e: 'Shared subscriptions not supported',
  0x9f: 'Connection rate exceeded',
  0xa0: 'Maximum connect time',
  0xa1: 'Subscription identifiers not supported',
  0xa2: 'Wildcard subscriptions not supported',
};

// MQTT 3.1.1 CONNACK return codes.
const MQTT311_CONNACK_CODES = {
  1: 'Connection refused: unacceptable protocol version',
  2: 'Connection refused: identifier rejected',
  3: 'Connection refused: server unavailable',
  4: 'Connection refused: bad user name or password',
  5: 'Connection refused: not authorized',
};

const HINTS = {
  0x85:
    'The broker rejected the client ID. On ConnectMQ the client ID is bound to the credential: use the issued client ID (the action appends "_gha-..." automatically) or leave client-id empty only on brokers that allow any ID.',
  0x86: 'Check the username and password secrets.',
  0x87:
    'The credential is not allowed to do this. Check the ACL / topic permissions of the user and that the topic is spelled correctly.',
  0x8a: 'This client or IP is banned by the broker.',
  0x8e: 'Another client connected with the same client ID. Keep client-id-suffix enabled so parallel jobs use unique IDs.',
  0x90: 'The topic name is not valid (wildcards + and # are not allowed when publishing).',
  0x95: 'The message is larger than the broker allows.',
  0x96: 'Message rate limit reached. Slow down or upgrade the plan.',
  0x97: 'A quota (connections, messages or traffic) of this broker / plan is exhausted.',
  0x9b: 'The requested QoS is not supported by this broker / plan. Try qos: 1 (e.g. ConnectMQ Serverless Free supports QoS up to 1).',
  0x9f: 'Too many connection attempts in a short time. Retry later.',
};

function hex(code) {
  return '0x' + Number(code).toString(16).padStart(2, '0');
}

function describeReasonCode(code, mqttVersion) {
  if (code === undefined || code === null || Number.isNaN(Number(code))) return '';
  const n = Number(code);
  if (mqttVersion === 4 && MQTT311_CONNACK_CODES[n]) {
    return `${MQTT311_CONNACK_CODES[n]} (return code ${n})`;
  }
  const text = MQTT5_REASON_CODES[n];
  const base = text ? `${text} (reason code ${hex(n)})` : `reason code ${hex(n)}`;
  const hint = HINTS[n];
  return hint ? `${base}. ${hint}` : base;
}

function parseBool(value, name, def) {
  const v = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (v === '') return def;
  if (['true', 'yes', '1', 'on'].includes(v)) return true;
  if (['false', 'no', '0', 'off'].includes(v)) return false;
  throw new Error(`Input "${name}" must be true or false, got "${value}".`);
}

function parseIntInRange(value, name, def, min, max) {
  const v = String(value === undefined || value === null ? '' : value).trim();
  if (v === '') return def;
  if (!/^\d+$/.test(v)) throw new Error(`Input "${name}" must be a whole number, got "${value}".`);
  const n = parseInt(v, 10);
  if (n < min || n > max) throw new Error(`Input "${name}" must be between ${min} and ${max}, got ${n}.`);
  return n;
}

function parseProtocol(value) {
  const v = String(value || 'mqtts').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, v)) {
    throw new Error(`Input "protocol" must be one of mqtts, mqtt, wss, ws; got "${value}".`);
  }
  return v;
}

function parseMqttVersion(value) {
  const v = String(value || '5').trim().toLowerCase();
  if (['5', '5.0', 'v5'].includes(v)) return 5;
  if (['3.1.1', '311', '4', 'v3.1.1'].includes(v)) return 4;
  throw new Error(`Input "mqtt-version" must be 5 or 3.1.1, got "${value}".`);
}

function validateTopic(topic, name, allowWildcards) {
  if (!topic) throw new Error(`Input "${name}" is required.`);
  if (Buffer.byteLength(topic, 'utf8') > 65535) throw new Error(`Input "${name}" is too long.`);
  if (topic.includes('\u0000')) throw new Error(`Input "${name}" must not contain NUL characters.`);
  if (!allowWildcards && /[+#]/.test(topic)) {
    throw new Error(`Input "${name}" must not contain the wildcards + or # (publishing needs a concrete topic).`);
  }
  if (allowWildcards) {
    const levels = topic.split('/');
    levels.forEach((level, i) => {
      if (level.includes('#') && (level !== '#' || i !== levels.length - 1)) {
        throw new Error(`Input "${name}": "#" must be the last level on its own.`);
      }
      if (level.includes('+') && level !== '+') {
        throw new Error(`Input "${name}": "+" must occupy a whole topic level.`);
      }
    });
  }
}

function parseUserProperties(value) {
  const v = String(value || '').trim();
  if (v === '') return undefined;
  let obj;
  try {
    obj = JSON.parse(v);
  } catch (e) {
    throw new Error(`Input "user-properties" must be a JSON object, e.g. {"source":"github"}: ${e.message}`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Input "user-properties" must be a JSON object, e.g. {"source":"github"}.');
  }
  const out = {};
  for (const [k, val] of Object.entries(obj)) {
    if (Array.isArray(val)) out[k] = val.map((x) => String(x));
    else if (val !== null && typeof val === 'object') out[k] = JSON.stringify(val);
    else out[k] = String(val);
  }
  return out;
}

function randomSuffix(bytes = 3) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * ConnectMQ binds client IDs to credentials: a client must use the issued ID
 * or "<clientId>_<suffix>". The suffix keeps parallel jobs / re-runs from
 * kicking each other off (session takeover).
 */
function buildClientId(clientId, useSuffix, env = process.env) {
  const runId = env.GITHUB_RUN_ID || 'local';
  const id = String(clientId || '').trim();
  if (id === '') return `gha-${runId}-${randomSuffix()}`;
  if (!useSuffix) return id;
  return `${id}_gha-${runId}-${randomSuffix()}`;
}

function buildUrl(protocol, host, port, wsPath) {
  let h = host.trim();
  if (h.includes(':') && !h.startsWith('[')) h = `[${h}]`; // IPv6 literal
  if (protocol === 'ws' || protocol === 'wss') {
    let p = String(wsPath || '/mqtt').trim();
    if (!p.startsWith('/')) p = '/' + p;
    return `${protocol}://${h}:${port}${p}`;
  }
  return `${protocol}://${h}:${port}`;
}

module.exports = {
  DEFAULT_PORTS,
  describeReasonCode,
  parseBool,
  parseIntInRange,
  parseProtocol,
  parseMqttVersion,
  validateTopic,
  parseUserProperties,
  buildClientId,
  buildUrl,
};
