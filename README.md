# Google Meet for Stream Deck

Your Elgato Stream Deck follows your Google Meet tabs in Chrome:

- **Meet home page open** → the deck shows **New Meeting** (creates a meeting and joins it automatically) and **Go to Meeting**.
- **In a call** (in any tab, any window, any Chrome profile, even when Chrome isn't in front) → the deck shows **Mic**, **Camera** (green = on, red = off, always in sync with Meet), **Go to Meeting** and **Leave**.
- **No Meet tab** → the deck goes back to your own profile.

**Go to Meeting** jumps to your open meetings. The first press goes to the first meeting you opened, the next press goes to the second, and so on, across Chrome windows and Chrome profiles.

![Keys](docs/keys.png)

## How it works

```
Chrome profile A ─┐                         ┌─ "Meet Home" profile
Chrome profile B ─┼─ ws://127.0.0.1:39251 ──┤
Chrome profile C ─┘   (extension → plugin)  └─ "Meet Live" profile
```

- `chrome-extension/` is a Manifest V3 extension. A content script reads each Meet tab's state (home, lobby or in call, plus mic and camera) and clicks Meet's own buttons on command. The service worker streams a snapshot of the profile's Meet tabs to the plugin.
- `plugin/` is a Stream Deck SDK v2 plugin. It runs a local WebSocket server, merges the snapshots from every Chrome profile, switches between the two bundled profiles and sends key presses to the right tab.

Everything stays on your machine: the server only listens on `127.0.0.1` and only accepts connections from Chrome extensions.

## Install

Requirements: macOS, Stream Deck app 6.6+, Node.js 20+, Google Chrome. The bundled profiles target the 15-key Stream Deck (MK.2 / original). On other models you can drag the actions onto any profile.

```bash
cd plugin
npm install
npm run build
npx streamdeck dev                          # enable developer mode
npx streamdeck link com.alphabin.gmeet.sdPlugin
npx streamdeck restart com.alphabin.gmeet
```

Then, in **each Chrome profile** you use for Meet:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the `chrome-extension` folder

## Notes

- Meet's mic and camera buttons are found by their English labels ("Turn off microphone", and so on), so set Google Meet's language to English.
- Want **Go to Meeting** on your normal profile too? Drag it in from the "Google Meet" category in the Stream Deck app.
- Plugin logs: `plugin/com.alphabin.gmeet.sdPlugin/logs/`. Extension logs: the "service worker" link on `chrome://extensions`.

## License

MIT
