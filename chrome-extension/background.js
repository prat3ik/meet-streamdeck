// Tracks this Chrome profile's Google Meet tabs and streams them to the
// Stream Deck plugin over a local WebSocket. Runs commands the plugin sends back.

const PLUGIN_URL = "ws://127.0.0.1:39251";
const MEET_NEW = "https://meet.google.com/new";

/** tabId -> { kind: "home"|"lobby"|"call"|"other", mic, cam, code, title, since } */
const tabs = new Map();
/** Tabs opened by the "New Meeting" key that should auto-click "Join now". */
const pendingJoin = new Set();
let focus = { focused: false, activeTabId: null };
let ws = null;

// The service worker can be stopped at any time; keep tab state in session storage.
const ready = chrome.storage.session.get(["tabs", "pendingJoin"]).then((s) => {
	for (const [id, t] of Object.entries(s.tabs ?? {})) tabs.set(Number(id), t);
	for (const id of s.pendingJoin ?? []) pendingJoin.add(id);
});

function persist() {
	chrome.storage.session.set({ tabs: Object.fromEntries(tabs), pendingJoin: [...pendingJoin] });
}

// --- connection to the Stream Deck plugin ----------------------------------

function connect() {
	if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
	ws = new WebSocket(PLUGIN_URL);
	ws.onopen = () => sendSnapshot();
	ws.onmessage = (e) => {
		let msg;
		try {
			msg = JSON.parse(e.data);
		} catch {
			return;
		}
		if (msg.type === "cmd") handleCmd(msg);
	};
	ws.onclose = () => {
		ws = null;
		setTimeout(connect, 3000);
	};
	ws.onerror = () => {};
}

// Regular traffic keeps the service worker alive while connected; the alarm
// wakes it up to reconnect if Stream Deck wasn't running.
setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 20000);
chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());

let snapTimer;
function sendSnapshot() {
	clearTimeout(snapTimer);
	snapTimer = setTimeout(async () => {
		await ready;
		if (ws?.readyState !== WebSocket.OPEN) return;
		ws.send(
			JSON.stringify({
				type: "snapshot",
				version: chrome.runtime.getManifest().version,
				focused: focus.focused,
				activeTabId: focus.activeTabId,
				tabs: [...tabs].map(([tabId, t]) => ({ tabId, ...t })),
			}),
		);
	}, 50);
}

async function refreshFocus() {
	try {
		const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
		const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
		focus = { focused: !!win.focused, activeTabId: tab?.id ?? null };
	} catch {
		focus = { focused: false, activeTabId: null };
	}
	sendSnapshot();
}

// --- commands from the plugin ----------------------------------------------

async function handleCmd({ cmd, tabId }) {
	await ready;
	try {
		switch (cmd) {
			case "focus": {
				const tab = await chrome.tabs.get(tabId);
				await chrome.tabs.update(tabId, { active: true });
				await chrome.windows.update(tab.windowId, { focused: true });
				break;
			}
			case "newMeeting": {
				const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
				const tab = win
					? await chrome.tabs.create({ url: MEET_NEW, windowId: win.id, active: true })
					: (await chrome.windows.create({ url: MEET_NEW, focused: true })).tabs[0];
				pendingJoin.add(tab.id);
				persist();
				await chrome.windows.update(tab.windowId, { focused: true });
				break;
			}
			case "reloadExtension": // lets the plugin pick up a new build without a manual reload
				chrome.runtime.reload();
				break;
			case "close":
				await chrome.tabs.remove(tabId);
				break;
			default: // toggleMic, toggleCam, leave
				await chrome.tabs.sendMessage(tabId, { cmd });
		}
	} catch (e) {
		console.warn(`command ${cmd} failed`, e);
	}
}

// --- state reports from content scripts ------------------------------------

chrome.runtime.onMessage.addListener((msg, sender) => {
	if (msg?.type !== "meet-state" || !sender.tab) return;
	(async () => {
		await ready;
		const id = sender.tab.id;
		const prev = tabs.get(id);
		const inMeeting = msg.kind === "lobby" || msg.kind === "call";
		const wasInMeeting = prev && (prev.kind === "lobby" || prev.kind === "call");
		tabs.set(id, {
			kind: msg.kind,
			mic: msg.mic,
			cam: msg.cam,
			code: msg.code,
			title: msg.title,
			// When this meeting was opened; used to order meetings for "Go to Meeting".
			since: inMeeting ? (wasInMeeting ? prev.since : Date.now()) : null,
		});
		if (msg.kind === "lobby" && pendingJoin.delete(id)) {
			chrome.tabs.sendMessage(id, { cmd: "autojoin" }).catch(() => {});
		}
		persist();
		connect();
		sendSnapshot();
	})();
});

// --- tab / window lifecycle --------------------------------------------------

chrome.tabs.onRemoved.addListener(async (id) => {
	await ready;
	tabs.delete(id);
	pendingJoin.delete(id);
	persist();
	sendSnapshot();
});

chrome.tabs.onUpdated.addListener(async (id, info) => {
	if (info.url && !info.url.startsWith("https://meet.google.com/")) {
		await ready;
		if (tabs.delete(id)) persist();
	}
	if (info.url || info.status === "complete") refreshFocus();
});

chrome.tabs.onActivated.addListener(refreshFocus);
chrome.windows.onFocusChanged.addListener(refreshFocus);

// Content scripts don't run in tabs that were already open when the extension
// was installed or reloaded, so inject them.
chrome.runtime.onInstalled.addListener(async () => {
	for (const tab of await chrome.tabs.query({ url: "https://meet.google.com/*" })) {
		chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
	}
});

connect();
refreshFocus();
