// Builds com.alphabin.gmeet.sdPlugin: bundles the Node code, renders key/icon
// PNGs from SVG, writes the manifest and packs the two bundled profiles.
// Also renders the Chrome extension's icons.

import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

const UUID = "com.alphabin.gmeet";
const OUT = `${UUID}.sdPlugin`;
const EXT = "../chrome-extension";
const DEVICE_MODEL = "20GAA9902"; // Stream Deck MK.2 (15 keys)

// Material Symbols paths (24x24 viewBox).
const GLYPH = {
	mic: "M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z",
	micOff: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
	cam: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
	camOff: "M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z",
	newCall: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4zM14 13h-3v3H9v-3H6v-2h3V8h2v3h3v2z",
	leave: "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z",
	goto: "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z",
	slack: "M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z",
	back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
	apps: "M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z",
	profile: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm0 14c-2.03 0-4.43-.82-6.14-2.88C7.55 15.8 9.68 15 12 15s4.45.8 6.14 2.12C16.43 19.18 14.03 20 12 20z",
};

const COLOR = { blue: "#1a73e8", green: "#188038", red: "#d93025", slate: "#3c4043", teal: "#00796b" };
const FONT = "Helvetica Neue, Helvetica, Arial, sans-serif";

/** 144x144 key face: glyph plus a label (bottom, or top when the title shows at the bottom). */
function keySvg({ bg, glyph, label, labelTop = false }) {
	const gy = labelTop ? 44 : 26;
	const ty = labelTop ? 34 : 124;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${bg}"/>
<g transform="translate(42 ${gy}) scale(2.5)" fill="#fff"><path d="${glyph}"/></g>
<text x="72" y="${ty}" font-family="${FONT}" font-size="21" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>
</svg>`;
}

/** Monochrome glyph on transparent, for the action list / category icons. */
const iconSvg = (glyph, fill = "#fff") =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="${fill}" d="${glyph}"/></svg>`;

const roundedSvg = (glyph) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="${COLOR.blue}"/><g transform="translate(3 3) scale(0.75)" fill="#fff"><path d="${glyph}"/></g></svg>`;

function png(svg, size, file) {
	mkdirSync(dirname(file), { recursive: true });
	const out = new Resvg(svg, { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: true } }).render().asPng();
	writeFileSync(file, out);
}

/** Writes name.png and name@2x.png. */
function png2x(svg, size, base) {
	png(svg, size, `${base}.png`);
	png(svg, size * 2, `${base}@2x.png`);
}

rmSync(OUT, { recursive: true, force: true });

// --- code --------------------------------------------------------------------

await esbuild.build({
	entryPoints: ["src/plugin.js"],
	bundle: true,
	platform: "node",
	target: "node20",
	format: "esm",
	outfile: `${OUT}/bin/plugin.js`,
	external: ["bufferutil", "utf-8-validate"],
	// ws uses require() for Node built-ins; give the ESM bundle a real one.
	banner: { js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);` },
	logLevel: "warning",
});
writeFileSync(`${OUT}/bin/package.json`, `{ "type": "module" }\n`);
cpSync("ui", `${OUT}/ui`, { recursive: true });

// --- images ------------------------------------------------------------------

const keys = {
	"new": { bg: COLOR.blue, glyph: GLYPH.newCall, label: "New Meet" },
	"mic-on": { bg: COLOR.green, glyph: GLYPH.mic, label: "Mic On" },
	"mic-off": { bg: COLOR.red, glyph: GLYPH.micOff, label: "Muted" },
	"cam-on": { bg: COLOR.green, glyph: GLYPH.cam, label: "Cam On" },
	"cam-off": { bg: COLOR.red, glyph: GLYPH.camOff, label: "Cam Off" },
	"leave": { bg: COLOR.slate, glyph: GLYPH.leave, label: "Leave" },
	"goto": { bg: COLOR.teal, glyph: GLYPH.goto, label: "Go to Meet", labelTop: true },
	"profile": { bg: COLOR.slate, glyph: GLYPH.profile, label: "", labelTop: true },
	"slack": { bg: "#4a154b", glyph: GLYPH.slack, label: "", labelTop: true },
	"apps-folder": { bg: "#1f1f1f", glyph: GLYPH.apps, label: "Open Apps" },
	"back": { bg: "#1f1f1f", glyph: GLYPH.back, label: "Back" },
};
for (const [name, spec] of Object.entries(keys)) png2x(keySvg(spec), 72, `${OUT}/imgs/keys/${name}`);
png2x(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#000"/></svg>`, 72, `${OUT}/imgs/keys/blank`);

const actionIcons = { new: GLYPH.newCall, mic: GLYPH.mic, camera: GLYPH.cam, leave: GLYPH.leave, goto: GLYPH.goto, profile: GLYPH.profile, slack: GLYPH.slack, app: GLYPH.apps, back: GLYPH.back };
for (const [name, glyph] of Object.entries(actionIcons)) png2x(iconSvg(glyph), 20, `${OUT}/imgs/actions/${name}`);
png2x(iconSvg(GLYPH.cam), 28, `${OUT}/imgs/category`);
png2x(roundedSvg(GLYPH.newCall), 256, `${OUT}/imgs/plugin`);

for (const size of [16, 48, 128]) png(roundedSvg(GLYPH.newCall), size, `${EXT}/icons/${size}.png`);

// --- manifest ----------------------------------------------------------------

const action = (id, name, tooltip, states, extra = {}) => ({
	UUID: `${UUID}.${id}`,
	Name: name,
	Icon: `imgs/actions/${id}`,
	Tooltip: tooltip,
	Controllers: ["Keypad"],
	States: states,
	...extra,
});
const face = (img, showTitle = false) => ({ Image: `imgs/keys/${img}`, ShowTitle: showTitle, TitleAlignment: "bottom" });

const manifest = {
	$schema: "https://schemas.elgato.com/streamdeck/plugins/manifest.json",
	UUID,
	Name: "Google Meet",
	Version: "1.0.0.0",
	Author: "Alphabin",
	Description: "Google Meet controls that follow your Chrome tabs: New Meeting on the Meet home page, mic and camera during a call, and a key that cycles through open meetings.",
	Icon: "imgs/plugin",
	Category: "Google Meet",
	CategoryIcon: "imgs/category",
	CodePath: "bin/plugin.js",
	SDKVersion: 2,
	Nodejs: { Version: "20" },
	Software: { MinimumVersion: "6.6" },
	OS: [{ Platform: "mac", MinimumVersion: "12" }],
	Actions: [
		action("back", "Back", "Leave the Meet/Zoom keys and return to your own profile", [face("back")]),
		action("new", "New Meeting", "Create a new Google Meet and join it", [face("new")]),
		action("mic", "Microphone", "Mute or unmute your Google Meet microphone", [face("mic-on"), face("mic-off")], { DisableAutomaticStates: true }),
		action("camera", "Camera", "Turn your Google Meet camera on or off", [face("cam-on"), face("cam-off")], { DisableAutomaticStates: true }),
		action("leave", "Leave Call", "Leave the current Google Meet call", [face("leave")]),
		action("goto", "Go to Meeting", "Jump to your open Google Meet tabs, one after another, across Chrome profiles", [face("goto", true)]),
		action("profile", "Chrome Profile", "Bring a Chrome profile to the front (its existing window, or a new one)", [face("profile", true)], {
			PropertyInspectorPath: "ui/profile.html",
		}),
		action("slack", "Slack Workspace", "Switch the Slack app to a workspace", [face("slack", true)], {
			PropertyInspectorPath: "ui/slack.html",
		}),
		// One key per slot (settings.slot = 0..13) in an "Open Apps" folder; filled with running apps.
		action("app", "Open App", "Shows one of the apps that are running; press to switch to it", [face("blank", true)], {
			VisibleInActionsList: false,
		}),
	],
	Profiles: ["Meet Home", "Meet Live", "Zoom"].map((name) => ({
		Name: `profiles/${name}`,
		DeviceType: 0,
		Readonly: false,
		DontAutoSwitchWhenInstalled: true,
		AutoInstall: true,
	})),
};
writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, "\t") + "\n");

// --- bundled profiles ----------------------------------------------------------

const slot = (id, name, nStates = 1, settings = {}) => ({
	Name: name,
	Settings: settings,
	State: 0,
	States: Array.from({ length: nStates }, () => ({
		FFamily: "", FSize: "", FStyle: "", FUnderline: "", Image: "", Title: "", TitleAlignment: "", TitleColor: "", TitleShow: "",
	})),
	// Ids with a dot are other plugins' actions (e.g. Elgato's Zoom plugin).
	UUID: id.includes(".") ? id : `${UUID}.${id}`,
});

// Keys are addressed "column,row" on the 5x3 MK.2.
const profiles = {
	"Meet Home": {
		uuid: "6B1F6C2E-3F7A-4C1D-9A51-2B7E0C1A0001",
		actions: { "0,0": slot("new", "New Meeting"), "1,0": slot("goto", "Go to Meeting"), "0,2": slot("back", "Back") },
	},
	"Meet Live": {
		uuid: "6B1F6C2E-3F7A-4C1D-9A51-2B7E0C1A0002",
		actions: {
			"0,0": slot("mic", "Microphone", 2),
			"1,0": slot("camera", "Camera", 2),
			"2,0": slot("goto", "Go to Meeting"),
			"4,2": slot("leave", "Leave Call"),
			"0,2": slot("back", "Back"),
		},
	},
	// Shown while Zoom is the frontmost app; uses Elgato's Zoom plugin.
	"Zoom": {
		uuid: "6B1F6C2E-3F7A-4C1D-9A51-2B7E0C1A0003",
		actions: {
			"0,0": slot("com.elgato.zoom.video", "Video", 2),
			"1,0": slot("com.elgato.zoom.mute", "Audio", 2),
			"2,0": slot("com.elgato.zoom.react", "React", 2, { emoji: "clap", tone: "default_tone" }),
			"3,0": slot("com.elgato.zoom.raisehand", "Raise Hand", 2),
			"4,0": slot("com.elgato.zoom.sendchat", "Send to Chat", 1, { message: "" }),
			"0,2": slot("back", "Back"),
		},
	},
};

const tmp = "build-tmp";
for (const [name, { uuid, actions }] of Object.entries(profiles)) {
	rmSync(tmp, { recursive: true, force: true });
	const dir = join(tmp, `${uuid}.sdProfile`);
	mkdirSync(dir, { recursive: true });
	for (const pos of Object.keys(actions)) mkdirSync(join(dir, pos));
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({ Actions: actions, DeviceModel: DEVICE_MODEL, InstalledByPluginUUID: UUID, Name: name, PreconfiguredName: name, Version: "1.0" }),
	);
	const file = join(process.cwd(), OUT, "profiles", `${name}.streamDeckProfile`);
	mkdirSync(dirname(file), { recursive: true });
	execFileSync("zip", ["-qr", "-X", file, "."], { cwd: tmp });
}
rmSync(tmp, { recursive: true, force: true });

console.log(`built ${OUT}`);
