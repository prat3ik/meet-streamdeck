// Google Meet <-> Stream Deck bridge.
//
// One Chrome extension instance per Chrome profile connects to the WebSocket
// server below and streams a snapshot of its Meet tabs. This plugin merges all
// snapshots, switches between the bundled "Meet Home" / "Meet Live" profiles,
// and routes key presses back to the right Chrome profile + tab.

import streamDeck, { DeviceType, SingletonAction } from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = 39251;
const PROFILES = { home: "profiles/Meet Home", live: "profiles/Meet Live", zoom: "profiles/Zoom" };
const UUID = "com.alphabin.gmeet";
const log = streamDeck.logger.createScope("gmeet");

// ---------------------------------------------------------------------------
// Chrome connections
// ---------------------------------------------------------------------------

/** @type {Map<import("ws").WebSocket, {id:number, ws:any, tabs:any[], focused:boolean, activeTabId:number|null, focusedAt:number}>} */
const conns = new Map();
let connSeq = 0;

const wss = new WebSocketServer({
	host: "127.0.0.1",
	port: PORT,
	// Only the Chrome extension should talk to us.
	verifyClient: ({ origin }) => typeof origin === "string" && origin.startsWith("chrome-extension://"),
});

wss.on("listening", () => log.info(`listening on ws://127.0.0.1:${PORT}`));
wss.on("error", (err) => log.error(`websocket server error: ${err.message}`));
wss.on("connection", (ws) => {
	const conn = { id: ++connSeq, ws, tabs: [], focused: false, activeTabId: null, focusedAt: 0 };
	conns.set(ws, conn);
	log.info(`chrome profile #${conn.id} connected`);

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		if (msg.type !== "snapshot") return;
		if (msg.focused && !conn.focused) conn.focusedAt = Date.now();
		conn.focused = !!msg.focused;
		conn.activeTabId = msg.activeTabId ?? null;
		conn.tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
		conn.email = msg.email ?? "";
		const summary = `email=${conn.email} focused=${conn.focused} active=${conn.activeTabId} tabs=${JSON.stringify(conn.tabs.map(({ tabId, kind, mic, cam, code }) => ({ tabId, kind, mic, cam, code })))}`;
		if (summary !== conn.lastSummary) log.info(`profile #${conn.id}: ${summary}`);
		conn.lastSummary = summary;
		refresh();
	});
	ws.on("close", () => {
		conns.delete(ws);
		log.info(`chrome profile #${conn.id} disconnected`);
		refresh();
	});
	ws.on("error", () => {});
});

function send(conn, cmd, tabId) {
	if (conn?.ws.readyState === 1) conn.ws.send(JSON.stringify({ type: "cmd", cmd, tabId }));
}

function activateChrome() {
	execFile("open", ["-a", "Google Chrome"], () => {});
}

// ---------------------------------------------------------------------------
// Chrome profiles (from Chrome's "Local State")
// ---------------------------------------------------------------------------

const CHROME_DIR = join(homedir(), "Library/Application Support/Google/Chrome");
let profileCache = { mtime: 0, list: [] };

/** @returns {{dir:string, name:string, email:string}[]} */
function chromeProfiles() {
	const file = join(CHROME_DIR, "Local State");
	try {
		const mtime = statSync(file).mtimeMs;
		if (mtime !== profileCache.mtime) {
			const info = JSON.parse(readFileSync(file, "utf8")).profile?.info_cache ?? {};
			const list = Object.entries(info)
				.map(([dir, p]) => ({ dir, name: p.name || dir, email: p.user_name || "" }))
				.sort((a, b) => a.name.localeCompare(b.name));
			profileCache = { mtime, list };
		}
	} catch (e) {
		log.warn(`can't read Chrome profiles: ${e.message}`);
	}
	return profileCache.list;
}

/** Key face for a Chrome profile: its Google avatar (or initials), ringed in green while it's the active profile. */
function profileImage(profile, active) {
	let picture = "";
	try {
		const png = readFileSync(join(CHROME_DIR, profile.dir, "Google Profile Picture.png")).toString("base64");
		picture = `<image width="144" height="144" preserveAspectRatio="xMidYMid slice" href="data:image/png;base64,${png}"/>`;
	} catch {
		const initials = profile.name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
		picture = `<rect width="144" height="144" fill="#5f6368"/><text x="72" y="88" font-family="Helvetica" font-size="52" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text>`;
	}
	const ring = active ? `<rect x="5" y="5" width="134" height="134" fill="none" stroke="#34a853" stroke-width="10"/>` : "";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${picture}${ring}</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Brings a Chrome profile to the front, reusing its window when the extension runs there. */
function switchChromeProfile(dir) {
	const profile = chromeProfiles().find((p) => p.dir === dir);
	if (!profile) return false;
	const conn = profile.email && [...conns.values()].find((c) => c.email === profile.email);
	if (conn) {
		send(conn, "focusProfile");
		setTimeout(activateChrome, 150);
	} else {
		// No extension there to focus an existing window; let Chrome open one.
		execFile("open", ["-na", "Google Chrome", "--args", `--profile-directory=${dir}`], () => {});
	}
	log.info(`switch to Chrome profile ${dir} (${profile.name}) via ${conn ? "extension" : "launch"}`);
	return true;
}

// ---------------------------------------------------------------------------
// Merged view across all Chrome profiles
// ---------------------------------------------------------------------------

const isMeeting = (t) => t.kind === "lobby" || t.kind === "call";

/** All lobby/in-call tabs across profiles, oldest first. */
function meetingTabs() {
	return [...conns.values()]
		.flatMap((conn) => conn.tabs.filter(isMeeting).map((t) => ({ ...t, conn })))
		.sort((a, b) => (a.since ?? 0) - (b.since ?? 0) || a.conn.id - b.conn.id || a.tabId - b.tabId);
}

function focusedConn() {
	return [...conns.values()].filter((c) => c.focused).sort((a, b) => b.focusedAt - a.focusedAt)[0];
}

function computeView() {
	const meetings = meetingTabs();
	const fc = focusedConn();
	const active = fc?.tabs.find((t) => t.tabId === fc.activeTabId);

	// The tab mic/camera/leave act on: the focused Meet tab if there is one,
	// otherwise the most recently opened tab that is in a live call.
	let target = null;
	if (active && isMeeting(active)) target = meetings.find((m) => m.conn === fc && m.tabId === active.tabId);
	else target = meetings.filter((m) => m.kind === "call").at(-1) ?? null;

	const mode = frontApp.startsWith("us.zoom.") ? "zoom" : target ? "live" : active?.kind === "home" ? "home" : "none";
	return { meetings, fc, active, target, mode };
}

// ---------------------------------------------------------------------------
// Profile switching
// ---------------------------------------------------------------------------

let shownMode = "none";
/** Mode the user left with the Back key; ignored until the situation changes. */
let dismissed = null;
let modeTimer;
let switching = Promise.resolve();

function scheduleMode(mode) {
	clearTimeout(modeTimer);
	if (mode === shownMode) return;
	// Leaving Meet waits a little longer so hopping between Chrome windows doesn't flicker.
	modeTimer = setTimeout(() => {
		switching = switching.then(() => applyMode(mode)).catch((e) => log.error(`switch failed: ${e}`));
	}, mode === "none" ? 900 : 300);
}

async function applyMode(mode) {
	if (mode === shownMode) return;
	const devices = [];
	streamDeck.devices.forEach((d) => {
		if (d.isConnected && d.type === DeviceType.StreamDeck) devices.push(d);
	});
	for (const d of devices) {
		// Always step back to the user's own profile first, so that "previous
		// profile" is never one of ours when we finally leave Meet.
		if (shownMode !== "none") await streamDeck.profiles.switchToProfile(d.id);
		if (mode !== "none") await streamDeck.profiles.switchToProfile(d.id, PROFILES[mode]);
	}
	log.info(`mode ${shownMode} -> ${mode}`);
	shownMode = mode;
}

// ---------------------------------------------------------------------------
// Slack workspaces (from the Slack desktop app's state)
// ---------------------------------------------------------------------------

const SLACK_STATE = join(homedir(), "Library/Application Support/Slack/storage/root-state.json");

/** @returns {{id:string, name:string, icon?:string, order:number}[]} */
function slackWorkspaces() {
	try {
		const ws = JSON.parse(readFileSync(SLACK_STATE, "utf8")).workspaces ?? {};
		return Object.values(ws)
			.map((w) => ({ id: w.id, name: w.name, icon: w.icon?.image_88 ?? w.icon?.image_68, order: w.order ?? 0 }))
			.sort((a, b) => a.order - b.order);
	} catch (e) {
		log.warn(`can't read Slack workspaces: ${e.message}`);
		return [];
	}
}

/** Workspace logo as a data URL, fetched once per workspace. */
const slackIcons = new Map();
function slackIcon(w) {
	if (!w.icon) return Promise.resolve(null);
	if (!slackIcons.has(w.id)) {
		const p = fetch(w.icon)
			.then(async (r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				const type = r.headers.get("content-type") || "image/png";
				return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
			})
			.catch((e) => {
				log.warn(`Slack icon for ${w.name}: ${e.message}`);
				slackIcons.delete(w.id);
				return null;
			});
		slackIcons.set(w.id, p);
	}
	return slackIcons.get(w.id);
}

function openSlack(team) {
	if (!/^[A-Z0-9]+$/.test(team ?? "")) return false;
	execFile("open", [`slack://open?team=${team}`], () => {});
	return true;
}

// ---------------------------------------------------------------------------
// Running apps (for the Open Apps folder) and Zoom focus
// ---------------------------------------------------------------------------

const ICON_CACHE = join(dirname(fileURLToPath(import.meta.url)), "..", "cache", "icons");


const sh = (cmd, args) => new Promise((resolve) => execFile(cmd, args, (err, out) => resolve(err ? "" : out)));

/** Regular apps that are running, most recently used first (like ⌘Tab). */
async function runningApps() {
	const asns = (await sh("lsappinfo", ["visibleProcessList"])).match(/ASN:0x[0-9a-f]+-0x[0-9a-f]+/g) ?? [];
	const apps = await Promise.all(
		asns.map(async (asn) => {
			const out = await sh("lsappinfo", ["info", "-only", "name", "-only", "bundleid", "-only", "bundlepath", asn]);
			const get = (key) => out.match(new RegExp(`"${key}"="([^"]*)"`))?.[1];
			return { name: get("LSDisplayName")?.replace(/^‎/, ""), id: get("CFBundleIdentifier"), path: get("LSBundlePath") };
		}),
	);
	return apps.filter((a) => a.id && a.path && a.id !== "com.elgato.StreamDeck");
}

const letterTile = (name) =>
	`data:image/svg+xml;base64,${Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect x="12" y="12" width="120" height="120" rx="28" fill="#5f6368"/><text x="72" y="92" font-family="Helvetica" font-size="60" font-weight="700" fill="#fff" text-anchor="middle">${(name || "?")[0].toUpperCase()}</text></svg>`,
	).toString("base64")}`;

/** App icon as a PNG data URL, converted once from the app's .icns and cached on disk. */
const appIcons = new Map();
function appIcon(app) {
	if (!appIcons.has(app.id)) {
		appIcons.set(
			app.id,
			(async () => {
				const file = join(ICON_CACHE, `${app.id}.png`);
				const load = () => `data:image/png;base64,${readFileSync(file).toString("base64")}`;
				try {
					return load();
				} catch {}
				let icon = (await sh("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIconFile", join(app.path, "Contents/Info.plist")])).trim();
				if (icon) {
					if (!icon.endsWith(".icns")) icon += ".icns";
					mkdirSync(ICON_CACHE, { recursive: true });
					await sh("sips", ["-s", "format", "png", "-Z", "144", join(app.path, "Contents/Resources", icon), "--out", file]);
					try {
						return load();
					} catch {}
				}
				// Apps that only ship their icon inside Assets.car (e.g. Calendar).
				return letterTile(app.name);
			})(),
		);
	}
	return appIcons.get(app.id);
}

const STREAM_DECK_ID = "com.elgato.StreamDeck";
let frontApp = "";

// Tracks the frontmost app. Zoom (us.zoom.xos, or its meeting window process
// us.zoom.ZoomHybridConf) in front shows the Zoom profile. Stream Deck itself
// comes to the front when we switch profiles while its window is open; that must not
// count as leaving Zoom/Chrome, or we'd switch straight back.
setInterval(async () => {
	const asn = (await sh("lsappinfo", ["front"])).trim();
	const id = asn && (await sh("lsappinfo", ["info", "-only", "bundleid", asn])).match(/"CFBundleIdentifier"="([^"]*)"/)?.[1];
	if (id && id !== frontApp) {
		frontApp = id;
		refresh();
	}
}, 700);

// ---------------------------------------------------------------------------
// Key behaviour (shared by keys and deep links)
// ---------------------------------------------------------------------------

const commands = {
	newMeeting() {
		const conn = focusedConn() ?? [...conns.values()].sort((a, b) => b.focusedAt - a.focusedAt)[0];
		if (!conn) return false;
		send(conn, "newMeeting");
		activateChrome();
		return true;
	},
	toggle(field) {
		const { target } = computeView();
		if (!target || target[field] == null) return false;
		send(target.conn, field === "mic" ? "toggleMic" : "toggleCam", target.tabId);
		return true;
	},
	leave() {
		const { target } = computeView();
		if (!target) return false;
		// In the lobby there is no "Leave call" button, so just close the tab.
		send(target.conn, target.kind === "call" ? "leave" : "close", target.tabId);
		return true;
	},
	goToMeeting() {
		const { meetings, fc, active } = computeView();
		if (!meetings.length) return false;
		// Start at the first meeting; if we're already on one, move to the next.
		const i = meetings.findIndex((m) => m.conn === fc && m.tabId === active?.tabId);
		const next = meetings[(i + 1) % meetings.length];
		send(next.conn, "focus", next.tabId);
		setTimeout(activateChrome, 150);
		return true;
	},
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

class Back extends SingletonAction {
	manifestId = `${UUID}.back`;

	onKeyDown() {
		// Back to the user's own profile, and stay there until they leave Zoom/Meet and return.
		dismissed = computeView().mode;
		clearTimeout(modeTimer);
		switching = switching.then(() => applyMode("none")).catch((e) => log.error(`switch failed: ${e}`));
	}
}

class NewMeeting extends SingletonAction {
	manifestId = `${UUID}.new`;

	onKeyDown(ev) {
		if (!commands.newMeeting()) ev.action.showAlert();
	}
}

class ToggleAction extends SingletonAction {
	/** @param {"mic"|"cam"} field */
	constructor(id, field) {
		super();
		this.manifestId = `${UUID}.${id}`;
		this.field = field;
	}

	onWillAppear() {
		render();
	}

	onKeyDown(ev) {
		if (!commands.toggle(this.field)) ev.action.showAlert();
	}

	render(target) {
		// State 0 = on (green), 1 = off (red).
		const state = target?.[this.field] === false ? 1 : 0;
		this.actions.forEach((a) => a.isKey() && a.setState(state));
	}
}

class Leave extends SingletonAction {
	manifestId = `${UUID}.leave`;

	onKeyDown(ev) {
		if (!commands.leave()) ev.action.showAlert();
	}
}

class GoToMeeting extends SingletonAction {
	manifestId = `${UUID}.goto`;

	onWillAppear() {
		render();
	}

	onKeyDown(ev) {
		if (!commands.goToMeeting()) ev.action.showAlert();
	}

	render({ meetings, fc, active }) {
		const i = meetings.findIndex((m) => m.conn === fc && m.tabId === active?.tabId);
		const title = !meetings.length ? "none" : i >= 0 ? `${i + 1} of ${meetings.length}` : `${meetings.length} open`;
		this.actions.forEach((a) => a.setTitle(title));
	}
}

class ChromeProfile extends SingletonAction {
	manifestId = `${UUID}.profile`;
	activeEmail = null;

	onWillAppear(ev) {
		this.paint(ev.action, ev.payload.settings);
	}

	onDidReceiveSettings(ev) {
		this.paint(ev.action, ev.payload.settings);
	}

	onKeyDown(ev) {
		if (!switchChromeProfile(ev.payload.settings.profile)) ev.action.showAlert();
	}

	// Feeds the profile dropdown in the property inspector (sdpi-components datasource).
	onSendToPlugin(ev) {
		if (ev.payload?.event !== "getProfiles") return;
		streamDeck.ui.sendToPropertyInspector({
			event: "getProfiles",
			items: chromeProfiles().map((p) => ({ label: p.email ? `${p.name} (${p.email})` : p.name, value: p.dir })),
		});
	}

	paint(action, settings) {
		const profile = chromeProfiles().find((p) => p.dir === settings.profile);
		if (!profile) {
			action.setTitle("Pick\nprofile");
			return;
		}
		action.setImage(profileImage(profile, !!profile.email && profile.email === this.activeEmail));
		action.setTitle(profile.name);
	}

	/** Re-rings the keys when the focused Chrome profile changes. */
	render(email) {
		if (email === this.activeEmail) return;
		this.activeEmail = email;
		this.actions.forEach(async (a) => this.paint(a, await a.getSettings()));
	}
}

class SlackWorkspace extends SingletonAction {
	manifestId = `${UUID}.slack`;

	onWillAppear(ev) {
		return this.paint(ev.action, ev.payload.settings);
	}

	onDidReceiveSettings(ev) {
		return this.paint(ev.action, ev.payload.settings);
	}

	onKeyDown(ev) {
		if (!openSlack(ev.payload.settings.team)) ev.action.showAlert();
	}

	// Feeds the workspace dropdown in the property inspector.
	onSendToPlugin(ev) {
		if (ev.payload?.event !== "getWorkspaces") return;
		streamDeck.ui.sendToPropertyInspector({
			event: "getWorkspaces",
			items: slackWorkspaces().map((w) => ({ label: w.name, value: w.id })),
		});
	}

	async paint(action, settings) {
		const w = slackWorkspaces().find((w) => w.id === settings.team);
		if (!w) return action.setTitle("Pick\nworkspace");
		action.setTitle(w.name);
		const icon = await slackIcon(w);
		if (icon) await action.setImage(icon);
		log.info(`slack key ${w.name}: ${icon ? "logo set" : "no logo"}`);
	}
}

class OpenApp extends SingletonAction {
	manifestId = `${UUID}.app`;
	/** Bundle ids in the order shown; kept stable while the folder is open. */
	order = [];
	apps = new Map();
	shown = new Map(); // action id -> bundle id currently painted
	timer = null;

	onWillAppear() {
		if (!this.timer) {
			this.order = [];
			this.tick();
			this.timer = setInterval(() => this.tick(), 2000);
		}
	}

	onWillDisappear() {
		// Stop polling once the folder is closed.
		setTimeout(() => {
			if (this.timer && this.actions.length === 0) {
				clearInterval(this.timer);
				this.timer = null;
				this.shown.clear();
			}
		}, 100);
	}

	onKeyDown(ev) {
		const id = this.order[ev.payload.settings.slot];
		if (!id) return ev.action.showAlert();
		execFile("open", ["-b", id], () => {});
	}

	async tick() {
		const apps = await runningApps();
		this.apps = new Map(apps.map((a) => [a.id, a]));
		// Opened just now: most recent first. Afterwards drop quit apps and append new ones,
		// so keys don't shuffle under your finger.
		this.order = this.order.length ? this.order.filter((id) => this.apps.has(id)) : [];
		for (const a of apps) if (!this.order.includes(a.id)) this.order.push(a.id);

		this.actions.forEach(async (action) => {
			const { slot } = await action.getSettings();
			const app = this.apps.get(this.order[slot]);
			if (this.shown.get(action.id) === (app?.id ?? null)) return;
			this.shown.set(action.id, app?.id ?? null);
			if (!app) {
				await action.setImage(); // back to the blank key from the manifest
				return action.setTitle("");
			}
			await action.setImage(await appIcon(app));
			await action.setTitle(app.name.length > 10 ? `${app.name.slice(0, 9)}…` : app.name);
		});
	}
}

const mic = new ToggleAction("mic", "mic");
const cam = new ToggleAction("camera", "cam");
const goto = new GoToMeeting();
const chromeProfile = new ChromeProfile();

function render() {
	const view = computeView();
	mic.render(view.target);
	cam.render(view.target);
	goto.render(view);
	// While Chrome is in the background, keep ringing the last profile used.
	if (view.fc) chromeProfile.render(view.fc.email || null);
	return view;
}

function refresh() {
	const { mode } = render();
	if (frontApp === STREAM_DECK_ID) return;
	if (dismissed && mode !== dismissed) dismissed = null;
	scheduleMode(dismissed ? "none" : mode);
}

// streamdeck://plugins/message/com.alphabin.gmeet/<command>, e.g. from Raycast or Shortcuts:
//   chrome-profile?dir=Profile%2023, new-meeting, mic, camera, leave, go-to-meeting
streamDeck.system.onDidReceiveDeepLink((ev) => {
	const path = ev.url.path.replace(/^\/+|\/+$/g, "");
	const ok = {
		"chrome-profile": () => switchChromeProfile(ev.url.queryParameters.get("dir")),
		"slack": () => openSlack(ev.url.queryParameters.get("team")),
		"new-meeting": () => commands.newMeeting(),
		"mic": () => commands.toggle("mic"),
		"camera": () => commands.toggle("cam"),
		"leave": () => commands.leave(),
		"go-to-meeting": () => commands.goToMeeting(),
		// After editing the unpacked extension, reload it in every connected Chrome profile.
		"reload-extension": () => conns.forEach((c) => send(c, "reloadExtension")) ?? true,
	}[path]?.();
	log.info(`deep link ${ev.url.href} -> ${ok ? "ok" : "ignored"}`);
});

streamDeck.actions.registerAction(new Back());
streamDeck.actions.registerAction(new NewMeeting());
streamDeck.actions.registerAction(mic);
streamDeck.actions.registerAction(cam);
streamDeck.actions.registerAction(new Leave());
streamDeck.actions.registerAction(goto);
streamDeck.actions.registerAction(chromeProfile);
streamDeck.actions.registerAction(new SlackWorkspace());
streamDeck.actions.registerAction(new OpenApp());

streamDeck.connect();
