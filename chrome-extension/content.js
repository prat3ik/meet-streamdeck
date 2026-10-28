// Reads the state of a Google Meet tab (home / lobby / in call, mic and camera)
// and clicks Meet's own buttons when the Stream Deck asks it to.
// Wrapped in an IIFE so it can be injected again after the extension reloads.
(() => {
	const CODE_RE = /^\/[a-z]+-[a-z]+-[a-z]+(\/|$)/i;
	const TOGGLE_RE = /^turn (on|off) (microphone|camera)/i;

	/** Meet's mic/camera toggle; its label says what pressing it will do. */
	function toggleButton(device) {
		for (const el of document.querySelectorAll('button[aria-label], [role="button"][aria-label]')) {
			const m = el.getAttribute("aria-label").match(TOGGLE_RE);
			if (m && m[2].toLowerCase() === device) return { el, on: m[1].toLowerCase() === "off" };
		}
		return null;
	}

	const leaveButton = () => document.querySelector('button[aria-label="Leave call"], [jsname="CQylAd"]');

	function read() {
		const path = location.pathname;
		const isCode = CODE_RE.test(path);
		const mic = toggleButton("microphone");
		const cam = toggleButton("camera");
		let kind = "other";
		if (!isCode) kind = path === "/" || path.startsWith("/landing") ? "home" : "other";
		else if (leaveButton()) kind = "call";
		else if (mic || cam) kind = "lobby"; // the "Ready to join?" screen
		return {
			type: "meet-state",
			kind,
			mic: mic ? mic.on : null,
			cam: cam ? cam.on : null,
			code: isCode ? path.slice(1).split("/")[0] : null,
			title: document.title,
		};
	}

	let last = "";
	let timers = [];
	let observer;

	function report(force) {
		const state = read();
		const json = JSON.stringify(state);
		if (!force && json === last) return;
		last = json;
		try {
			chrome.runtime.sendMessage(state).catch(() => {});
		} catch {
			stop(); // extension was reloaded; this copy is orphaned
		}
	}

	function stop() {
		observer?.disconnect();
		timers.forEach(clearInterval);
	}

	function autojoin() {
		const started = Date.now();
		const t = setInterval(() => {
			const btn = [...document.querySelectorAll("button")].find((b) => /^\s*join now\s*$/i.test(b.innerText));
			if (btn) btn.click();
			if (btn || Date.now() - started > 30000) clearInterval(t);
		}, 500);
	}

	chrome.runtime.onMessage.addListener((msg) => {
		switch (msg?.cmd) {
			case "toggleMic":
				toggleButton("microphone")?.el.click();
				break;
			case "toggleCam":
				toggleButton("camera")?.el.click();
				break;
			case "leave":
				leaveButton()?.click();
				break;
			case "autojoin":
				autojoin();
				break;
		}
		setTimeout(() => report(false), 300);
	});

	let pending;
	observer = new MutationObserver(() => {
		clearTimeout(pending);
		pending = setTimeout(() => report(false), 250);
	});
	observer.observe(document.documentElement, {
		subtree: true,
		childList: true,
		attributes: true,
		attributeFilter: ["aria-label", "data-is-muted"],
	});
	timers.push(setInterval(() => report(false), 2000)); // catches SPA URL changes
	timers.push(setInterval(() => report(true), 15000)); // heartbeat for a restarted service worker
	report(true);
})();
