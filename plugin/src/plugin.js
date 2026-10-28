// Google Meet <-> Stream Deck bridge.
//
// One Chrome extension instance per Chrome profile connects to the WebSocket
// server below and streams a snapshot of its Meet tabs. This plugin merges all
// snapshots, switches between the bundled "Meet Home" / "Meet Live" profiles,
// and routes key presses back to the right Chrome profile + tab.

import streamDeck, { DeviceType, SingletonAction } from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { WebSocketServer } from "ws";

const PORT = 39251;
const PROFILES = { home: "profiles/Meet Home", live: "profiles/Meet Live" };
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

	const mode = target ? "live" : active?.kind === "home" ? "home" : "none";
	return { meetings, fc, active, target, mode };
}

// ---------------------------------------------------------------------------
// Profile switching
// ---------------------------------------------------------------------------

let shownMode = "none";
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
// Actions
// ---------------------------------------------------------------------------

class NewMeeting extends SingletonAction {
	manifestId = `${UUID}.new`;

	onKeyDown(ev) {
		const conn = focusedConn() ?? [...conns.values()].sort((a, b) => b.focusedAt - a.focusedAt)[0];
		if (!conn) return ev.action.showAlert();
		send(conn, "newMeeting");
		activateChrome();
	}
}

class ToggleAction extends SingletonAction {
	/** @param {"mic"|"cam"} field */
	constructor(id, field, cmd) {
		super();
		this.manifestId = `${UUID}.${id}`;
		this.field = field;
		this.cmd = cmd;
	}

	onWillAppear() {
		render();
	}

	onKeyDown(ev) {
		const { target } = computeView();
		if (!target || target[this.field] == null) return ev.action.showAlert();
		send(target.conn, this.cmd, target.tabId);
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
		const { target } = computeView();
		if (!target) return ev.action.showAlert();
		// In the lobby there is no "Leave call" button, so just close the tab.
		send(target.conn, target.kind === "call" ? "leave" : "close", target.tabId);
	}
}

class GoToMeeting extends SingletonAction {
	manifestId = `${UUID}.goto`;

	onWillAppear() {
		render();
	}

	onKeyDown(ev) {
		const { meetings, fc, active } = computeView();
		if (!meetings.length) return ev.action.showAlert();
		// Start at the first meeting; if we're already on one, move to the next.
		const i = meetings.findIndex((m) => m.conn === fc && m.tabId === active?.tabId);
		const next = meetings[(i + 1) % meetings.length];
		send(next.conn, "focus", next.tabId);
		setTimeout(activateChrome, 150);
	}

	render({ meetings, fc, active }) {
		const i = meetings.findIndex((m) => m.conn === fc && m.tabId === active?.tabId);
		const title = !meetings.length ? "none" : i >= 0 ? `${i + 1} of ${meetings.length}` : `${meetings.length} open`;
		this.actions.forEach((a) => a.setTitle(title));
	}
}

const mic = new ToggleAction("mic", "mic", "toggleMic");
const cam = new ToggleAction("camera", "cam", "toggleCam");
const goto = new GoToMeeting();

function render() {
	const view = computeView();
	mic.render(view.target);
	cam.render(view.target);
	goto.render(view);
	return view;
}

function refresh() {
	scheduleMode(render().mode);
}

streamDeck.actions.registerAction(new NewMeeting());
streamDeck.actions.registerAction(mic);
streamDeck.actions.registerAction(cam);
streamDeck.actions.registerAction(new Leave());
streamDeck.actions.registerAction(goto);
streamDeck.connect();
