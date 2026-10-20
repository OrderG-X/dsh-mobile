<div align="center">

<img src="assets/hero.svg" alt="dsh-mobile — scan a QR code and use DSH from your phone" width="760" />

<p>
  <a href="https://github.com/OrderG-X/dsh-mobile/releases"><img src="https://img.shields.io/github/v/release/OrderG-X/dsh-mobile?label=release&color=4D6BFE" alt="release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" />
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://img.shields.io/badge/DSH-plugin-4D6BFE" alt="DSH plugin" /></a>
</p>

<p>
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md"><b>English</b></a>
</p>

</div>

A phone front end for DSH (DeepSeek Harness). DSH's settings page on your computer shows a QR code; scan it with your phone camera and your phone browser opens the same DSH — same sessions, live. Leave while a task is running and keep watching it, reply, or approve from your phone.

No app to install, no account, and no third-party server holding your data:

- **One QR code, anywhere**: it works on Wi-Fi at home and on mobile data outside. Outside access uses a free Cloudflare tunnel (no sign-up), set up automatically when you turn phone access on.
- **Pairing by QR**: each code works once and expires in 10 minutes; every phone gets its own credential, which you can remove at any time — the phone is disconnected immediately.

## Install

```sh
dsh plugin add https://github.com/OrderG-X/dsh-mobile/releases/latest/download/dsh-mobile.tgz
```

**Restart DSH** afterwards. It shows up as "Mobile" on the DSH Plugins page.

## Use

1. On the computer: click the phone button in the session header (or DSH → Plugins → Mobile) and turn on "Allow phone access".
2. Scan the QR code with the phone camera. When it is tagged "Wi-Fi or mobile data", it works anywhere.

The first time, Cloudflare's official cloudflared (about 20 MB) is downloaded automatically, which takes about half a minute; meanwhile the card shows a same-Wi-Fi code and swaps it when outside access is ready. To keep it to your home network, turn off "Also work outside".

After the first scan, just open the same address on the phone (add it to the home screen). The address survives DSH restarts, so no rescan; it changes when the computer restarts or phone access is turned off, so scan once more then.

While a phone is connected, the phone button in the header shows a green dot. If you cannot scan, use "Copy link" and open it on the phone (valid for 10 minutes, works once).

## How it works

The plugin runs a small gateway inside DSH (port 18765 by default) and forwards the phone's requests to DSH's own web UI on the computer. The phone runs the official DSH web UI, so sessions, approvals and settings are exactly what you have on the computer.

- DSH desktop's web UI requires a login. Inside the DSH process the gateway trades the launch token for a session cookie and attaches it for the phone; that cookie never reaches the phone.
- The phone's own credential is issued by the gateway (HttpOnly, SameSite=Strict). Only its hash is stored on disk.
- The local network is plain HTTP, which lacks some "secure context" browser APIs; the gateway adds the one DSH needs.
- When a live connection is idle, the gateway sends keepalive pings toward the phone so tunnels and carriers don't drop it.
- Outside access uses `cloudflared tunnel --url` (a trycloudflare.com quick tunnel): Cloudflare forwards HTTPS traffic to the gateway on your computer, and the gateway's pairing still guards the door.

## Security

A paired phone can make DSH work on this computer, just like sitting at it. So:

- Only scan with your own phone; don't send the QR code to anyone or post a screenshot.
- If a phone gets lost, remove it under "Paired phones".
- Same-Wi-Fi mode is plain HTTP: on public Wi-Fi, use the outside code (HTTPS, tagged "Wi-Fi or mobile data") instead.
- Turn off "Allow phone access" when you don't need it; the gateway stops listening.

Data lives in `~/.dsh/dsh-mobile/`: `state.json` (switches), `devices.json` (paired phones, 0600), `mobile.log`, and `bin/cloudflared` if downloaded.

## Limitations

- Nothing works while the computer sleeps or DSH is closed.
- The phone shows DSH's web UI as is; there is no phone-specific layout.
- Outside access uses Cloudflare's free quick tunnels, which have no uptime guarantee. To keep the address, the tunnel keeps running in the background when DSH quits (it uses almost nothing) and is picked up again next time; turning off phone access stops it.
- Tested with DSH desktop on macOS only; the cloudflared download paths for Windows and Linux are written but untested.

## Development

```sh
npm test   # script tests for the gateway, pairing, live connections and keepalive
```

## License

MIT
