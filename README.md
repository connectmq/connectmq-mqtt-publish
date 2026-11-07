# ConnectMQ MQTT Publish

Publish an MQTT message from a GitHub Actions workflow to a [ConnectMQ](https://connectmq.com) broker or any standards-based MQTT 3.1.1 / 5.0 broker. You can also wait for a reply (ack) on another topic.

Typical uses:

- Notify devices, gateways or dashboards when a release is published or a deployment finishes.
- Trigger an OTA firmware update and wait until a device confirms it.
- Feed build and test results into an MQTT-based monitoring setup.

The action is a self-contained JavaScript action. It runs on Linux, Windows and macOS runners, and it needs no Docker and no setup step.

## Quick start

1. Create a free broker at **[app.connectmq.com](https://app.connectmq.com)**. The **Serverless Free** plan gives you up to 25 connections, QoS 0 and 1, and messages up to 256 KB, with no credit card. QoS 2 needs **Serverless Paid**.
2. In the ConnectMQ portal, create a credential and note its **username**, **password** and **client ID**.
3. In your GitHub repository, go to **Settings → Secrets and variables → Actions** and add these secrets:
   - `MQTT_USERNAME`
   - `MQTT_PASSWORD`
   - `MQTT_CLIENT_ID`
4. Add a step to a workflow:

```yaml
- uses: connectmq/connectmq-mqtt-publish@v1
  with:
    username: ${{ secrets.MQTT_USERNAME }}
    password: ${{ secrets.MQTT_PASSWORD }}
    client-id: ${{ secrets.MQTT_CLIENT_ID }}
    topic: myproject/ci/deploy
    message: '{"status":"deployed","sha":"${{ github.sha }}"}'
```

Use the web client or the topic explorer in the ConnectMQ portal to watch the messages arrive.

> **Client IDs on ConnectMQ:** each credential is bound to its issued client ID. A client must connect with that ID or with `<clientId>_<suffix>`. When you set `client-id`, the action appends `_gha-<run_id>-<random>` by default. Parallel jobs and re-runs therefore never share an ID and never disconnect each other. Set `client-id-suffix: false` to use the ID exactly as given.

## Examples

### Notify devices on release

```yaml
name: Notify devices on release
on:
  release:
    types: [published]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: connectmq/connectmq-mqtt-publish@v1
        with:
          username: ${{ secrets.MQTT_USERNAME }}
          password: ${{ secrets.MQTT_PASSWORD }}
          client-id: ${{ secrets.MQTT_CLIENT_ID }}
          topic: myproduct/releases/latest
          retain: true   # devices that connect later still get the latest version
          message: '{"version":"${{ github.event.release.tag_name }}","url":"${{ github.event.release.html_url }}"}'
          user-properties: '{"source":"github","sha":"${{ github.sha }}"}'
```

### Trigger an OTA update and wait for the ack

The action subscribes to `wait-topic` **before** it publishes, so it cannot miss a fast reply. With MQTT 5, it also sets `wait-topic` as the message's *Response Topic*, so a device can simply reply to the response topic it receives.

```yaml
- name: Trigger OTA
  id: ota
  uses: connectmq/connectmq-mqtt-publish@v1
  with:
    username: ${{ secrets.MQTT_USERNAME }}
    password: ${{ secrets.MQTT_PASSWORD }}
    client-id: ${{ secrets.MQTT_CLIENT_ID }}
    topic: fleet/staging/ota/request
    message: '{"firmware":"https://example.com/fw/${{ github.sha }}.bin"}'
    wait-topic: fleet/staging/ota/ack
    wait-timeout-seconds: 120

- run: echo "Device replied: $REPLY"
  env:
    REPLY: ${{ steps.ota.outputs.reply }}
```

If no reply arrives in time, the step fails. Add `continue-on-error: true` to the step if a missing ack should not fail the job.

### Deployment events over WebSocket (port 8084)

Use this when your network only allows HTTPS-like traffic:

```yaml
- uses: connectmq/connectmq-mqtt-publish@v1
  with:
    protocol: wss          # wss://broker.connectmq.com:8084/mqtt
    username: ${{ secrets.MQTT_USERNAME }}
    password: ${{ secrets.MQTT_PASSWORD }}
    client-id: ${{ secrets.MQTT_CLIENT_ID }}
    topic: myproject/ci/${{ github.ref_name }}/status
    message: ${{ job.status }}
```

### Use with any MQTT broker

```yaml
- uses: connectmq/connectmq-mqtt-publish@v1
  with:
    host: mqtt.example.org
    port: 8883
    protocol: mqtts
    mqtt-version: '3.1.1'
    username: ${{ secrets.MQTT_USERNAME }}
    password: ${{ secrets.MQTT_PASSWORD }}
    topic: builds/${{ github.repository }}
    message: 'Build ${{ github.run_number }} finished'
```

More complete workflows are in [`docs/examples`](docs/examples).

### Try it without an account

ConnectMQ has a public test area on `broker.connectmq.com:1883`. It accepts anonymous clients with a unique, non-empty client ID on topics under `connectmq/demo/`. Limits: 64 KB per message, 10 messages per second and 8 topic levels. Anyone can read these topics, so never send real data there.

```yaml
- uses: connectmq/connectmq-mqtt-publish@v1
  with:
    protocol: mqtt
    port: 1883
    topic: connectmq/demo/${{ github.run_id }}/hello
    message: hello from GitHub Actions
```

## Inputs

| Input | Default | Description |
|---|---|---|
| `host` | `broker.connectmq.com` | Broker host name. |
| `port` | *(protocol default)* | Empty means 8883 for `mqtts`, 1883 for `mqtt`, 8084 for `wss` and 8083 for `ws`. |
| `protocol` | `mqtts` | `mqtts` (TLS), `mqtt` (plain TCP), `wss` (WebSocket over TLS) or `ws`. |
| `ws-path` | `/mqtt` | WebSocket path for `ws` / `wss`. |
| `username` | | MQTT username. |
| `password` | | MQTT password. Always pass it from a secret. It is masked in logs. |
| `client-id` | *(random)* | MQTT client ID. On ConnectMQ, use the client ID issued with your credential. If empty, the action uses `gha-<run_id>-<random>`. |
| `client-id-suffix` | `true` | Appends `_gha-<run_id>-<random>` to `client-id`. |
| `topic` | **required** | Topic to publish to. Wildcards are not allowed. |
| `message` | `''` | Payload as text or JSON. |
| `qos` | `1` | `0`, `1` or `2`. |
| `retain` | `false` | Publishes a retained message. |
| `mqtt-version` | `5` | `5` or `3.1.1`. |
| `user-properties` | | MQTT 5 user properties as a JSON object, e.g. `{"source":"github"}`. Ignored with 3.1.1. |
| `wait-topic` | | Topic or topic filter (`+` / `#` allowed) to wait on for a reply. |
| `wait-timeout-seconds` | `30` | Maximum time to wait for the reply. |
| `connect-timeout-seconds` | `30` | Maximum time to wait for the broker to accept the connection. |

## Outputs

| Output | Description |
|---|---|
| `published` | `true` if the broker accepted the message, otherwise `false`. |
| `reply` | Payload of the first message received on `wait-topic`. |
| `reply-topic` | Topic on which the reply arrived. |

## Security notes

- Keep `password` (and preferably `username` and `client-id`) in **secrets**. The action calls `core.setSecret` on the password, so it never shows in logs.
- Give the CI credential its own ACL in your broker and limit it to the topics the workflow needs.
- `mqtts` and `wss` verify the broker's TLS certificate. ConnectMQ uses Let's Encrypt certificates, which every runner trusts.
- Workflow inputs reach the action as environment variables, not through a shell. Values such as release names therefore cannot inject commands.

## Troubleshooting

The action reports MQTT 5 reason codes in plain text. Common ones:

| Message | Meaning / fix |
|---|---|
| `Bad user name or password (0x86)` | Check the `MQTT_USERNAME` and `MQTT_PASSWORD` secrets. |
| `Not authorized (0x87)` | The credential may not connect, or may not publish or subscribe to this topic. Check the topic spelling and the ACL. |
| `Client identifier not valid (0x85)` | On ConnectMQ, `client-id` must be the issued client ID. Keep `client-id-suffix: true`, or set the exact ID with `client-id-suffix: false`. |
| `Session taken over (0x8E)` | Another client used the same client ID. Keep `client-id-suffix` enabled. |
| `QoS not supported (0x9B)` | The plan or broker does not support this QoS. Use `qos: 1` (Serverless Free supports QoS up to 1). |
| `Quota exceeded (0x97)` / `Message rate too high (0x96)` | A connection, message or rate limit was reached. Reduce the frequency or upgrade the plan. |
| `Packet too large (0x95)` | The message is bigger than the broker allows (Serverless Free: 256 KB). |
| `Host not found` / `Connection refused` | Check `host`, `port` and `protocol`. For ConnectMQ, the pairs are 8883 = mqtts, 1883 = mqtt, 8084 = wss, 8083 = ws. |
| `TLS error` | You used `mqtts` / `wss` on a non-TLS port, or the broker certificate is not trusted. |
| `No reply on "..." within Ns` | Nothing was published on `wait-topic` in time. Check that the device is online and replies to the right topic, then increase `wait-timeout-seconds`. |

Brokers may silently drop a QoS 0 publish that the ACL forbids. With MQTT 3.1.1, this can also happen at QoS 1. `published: true` means the broker acknowledged the message. Use `wait-topic` when you need end-to-end confirmation.

## Development

```bash
npm install
npm test          # unit tests (node:test)
npm run build     # bundles src/ into dist/index.js with @vercel/ncc
```

Commit `dist/` after every change. The runner executes `dist/index.js` directly, and `node_modules` is not committed.

## About ConnectMQ

[ConnectMQ](https://connectmq.com) is a managed MQTT broker with MQTT 3.1.1 and 5.0 support. It offers TLS (Let's Encrypt) on ports 8883 and 8084 (WebSocket, `/mqtt`) and plain ports 1883 and 8083. Its portal includes a web client, a topic explorer, a dashboard and alerts. [Start free](https://app.connectmq.com).

## License

[MIT](LICENSE) © ConnectMQ
