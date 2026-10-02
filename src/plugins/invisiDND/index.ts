/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { definePluginSettings } from "@api/Settings";
import { getUserSettingLazy } from "@api/UserSettings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, React, showToast } from "@webpack/common";

const logger = new Logger("InvisiDND");

// Official status API, same one the AutoDNDWhilePlaying plugin uses.
const StatusSetting = getUserSettingLazy<string>("status", "status")!;

const settings = definePluginSettings({
    // NOTE: intentionally NOT called "enabled" — that key belongs to
    // Vencord's plugin manager in the same settings object, and sharing it
    // caused an infinite toggle loop (and Discord API rate limiting).
    // The single writer of this setting is the onChange below; every entry
    // point flips the setting and lets onChange apply it.
    active: {
        type: OptionType.BOOLEAN,
        description: "Whether InvisiDND is active (invisible to others, silent locally)",
        default: false,
        onChange: v => (v ? enableInvisiDND() : disableInvisiDND()),
    },
    suppressNotifications: {
        type: OptionType.BOOLEAN,
        description: "Suppress desktop notification popups while InvisiDND is on",
        default: true,
    },
    suppressSounds: {
        type: OptionType.BOOLEAN,
        description: "Suppress notification sounds while InvisiDND is on",
        default: true,
    },
    suppressCalls: {
        type: OptionType.BOOLEAN,
        description: "Suppress incoming call popups and ringing while InvisiDND is on",
        default: true,
    },
    excludedUserIds: {
        type: OptionType.STRING,
        description: "Users that always notify normally, even with InvisiDND on. Paste user IDs (right-click a user > Copy User ID), one per line or comma-separated.",
        default: "",
        multiline: true,
    },
    restorePreviousStatus: {
        type: OptionType.BOOLEAN,
        description: "Restore your previous status when turning InvisiDND off",
        default: true,
    },
});

let previousStatus: string | null = null;

function isActive() {
    try {
        return !!settings.store.active;
    } catch {
        return false;
    }
}

function setActive(v: boolean) {
    settings.store.active = v;
}

function readStatus(): string | null {
    try {
        return StatusSetting.getSetting() ?? null;
    } catch (e) {
        logger.warn("Could not read current status", e);
        return null;
    }
}

async function applyStatus(status: string): Promise<boolean> {
    try {
        // Skip the API call when already in the desired state. Status writes
        // are rate limited by Discord, so never spam them.
        if (readStatus() === status) return true;
        await StatusSetting.updateSetting(status);
        return true;
    } catch (e) {
        logger.warn("Could not set status to " + status, e);
        return false;
    }
}

function parseExcludedIds(): Set<string> {
    try {
        const raw = settings.store.excludedUserIds ?? "";
        return new Set(
            raw.split(/[\s,;]+/)
                .map(s => s.trim())
                .filter(s => /^\d{5,}$/.test(s))
        );
    } catch {
        return new Set();
    }
}

async function enableInvisiDND(silent = false) {
    previousStatus ??= readStatus();
    const ok = await applyStatus("invisible");
    if (!silent) {
        showToast(ok
            ? "InvisiDND on: you appear offline, notifications silenced"
            : "InvisiDND on: could not set Invisible automatically — pick it in the status menu");
    }
}

async function disableInvisiDND(silent = false) {
    clearDisableTimer();
    if (settings.store.restorePreviousStatus && previousStatus && previousStatus !== "invisible") {
        await applyStatus(previousStatus);
    }
    previousStatus = null;
    if (!silent) showToast("InvisiDND off");
}

function InvisiDNDDot() {
    // display:block avoids inline-svg baseline offset so the dot lines up
    // with Discord's own status dots (which also render at 10px).
    return React.createElement(
        "svg",
        { width: 10, height: 10, viewBox: "0 0 20 20", "aria-hidden": true, style: { display: "block" } },
        React.createElement("circle", { cx: 10, cy: 10, r: 10, fill: "#80848e" }),
        React.createElement("rect", { x: 4, y: 8, width: 12, height: 4, rx: 2, fill: "#313338" })
    );
}

let disableTimer: ReturnType<typeof setTimeout> | null = null;

function clearDisableTimer() {
    if (disableTimer) {
        clearTimeout(disableTimer);
        disableTimer = null;
    }
}

function armDisableTimer(ms: number | null) {
    clearDisableTimer();
    if (ms == null) return;
    disableTimer = setTimeout(() => {
        disableTimer = null;
        if (isActive()) setActive(false);
    }, ms);
}

function msUntilMidnight(): number {
    const now = new Date();
    const end = new Date(now);
    end.setHours(24, 0, 0, 0);
    return Math.max(0, end.getTime() - now.getTime());
}

const PICKER_DURATIONS: Array<{ label: string; ms: number | null }> = [
    { label: "30 minutes", ms: 30 * 60 * 1000 },
    { label: "1 hour", ms: 60 * 60 * 1000 },
    { label: "4 hours", ms: 4 * 60 * 60 * 1000 },
    { label: "Today", ms: -1 }, // computed at click time (until midnight)
    { label: "Until I turn it off", ms: null },
];

function buildPickerSubmenu() {
    try {
        const toggleItems = [
            React.createElement(Menu.MenuCheckboxItem, {
                id: "invisidnd-sub-popups",
                label: "Notification popups",
                checked: !!settings.store.suppressNotifications,
                action: () => {
                    settings.store.suppressNotifications = !settings.store.suppressNotifications;
                },
                dontCloseOnAction: true,
            }),
            React.createElement(Menu.MenuCheckboxItem, {
                id: "invisidnd-sub-sounds",
                label: "Notification sounds",
                checked: !!settings.store.suppressSounds,
                action: () => {
                    settings.store.suppressSounds = !settings.store.suppressSounds;
                },
                dontCloseOnAction: true,
            }),
            React.createElement(Menu.MenuCheckboxItem, {
                id: "invisidnd-sub-calls",
                label: "Incoming calls",
                checked: !!settings.store.suppressCalls,
                action: () => {
                    settings.store.suppressCalls = !settings.store.suppressCalls;
                },
                dontCloseOnAction: true,
            }),
        ];
        const durationItems = PICKER_DURATIONS.map(d =>
            React.createElement(Menu.MenuItem, {
                id: "invisidnd-dur-" + d.label.replace(/\s+/g, "-").toLowerCase(),
                label: d.label,
                action: () => {
                    const ms = d.ms === -1 ? msUntilMidnight() : d.ms;
                    if (!isActive()) setActive(true);
                    armDisableTimer(ms);
                    showToast(ms ? `InvisiDND on for ${d.label.toLowerCase()}` : "InvisiDND on until turned off");
                },
                dontCloseOnAction: true,
            })
        );
        return [...toggleItems, ...durationItems];
    } catch (e) {
        logger.warn("Could not render picker submenu", e);
        return null;
    }
}

export default definePlugin({
    name: "InvisiDND",
    description: "Extra status: appear Invisible to others while silencing notifications and sounds locally (like DND). Adds an InvisiDND entry to the status picker, with a per-user exclusion list.",
    authors: [Devs.Ovima],
    tags: ["Notifications", "Privacy", "Utility"],
    settings,

    patches: [
        {
            // Discord's NotificationStore MESSAGE_CREATE handler decides here
            // whether to pop a desktop notification and play a sound.
            // Shapes verified 2026-10-01 against the current Discord client
            // (e.g. `...,F.A.getDesktopType()===ee.nRU.NEVER)return
            // eh(m),m&&J.A.playNotificationSound(ea,es),!1;` and
            // `sound:m?ea:void 0,volume:es,onClick`).
            // Excluded authors bypass suppression entirely.
            find: '"NotificationStore"',
            replacement: [
                {
                    match: /(\i\.\i\.getDesktopType\(\)===\i\.\i\.NEVER)\)return (\i)\((\i)\),\3&&(\i\.\i)\.playNotificationSound\((\i),(\i)\),!1;/,
                    replace: "$1||($self.shouldSuppressNotifications()&&!$self.isExcluded(a?.author?.id)))return $2($3),$self.shouldSuppressSounds()&&!$self.isExcluded(a?.author?.id)?!1:$3&&$4.playNotificationSound($5,$6),!1;",
                },
                {
                    match: /sound:(\i\?\i:void 0,volume:\i,onClick)/,
                    replace: "sound:($self.shouldSuppressSounds()&&!$self.isExcluded(a?.author?.id))?undefined:$1",
                },
            ],
        },
        {
            // Discord's notification-sound gate. Verified 2026-10-01:
            // `isSoundDisabled(e){return o.disableAllSounds||...}` in
            // NotificationSettingsStore. Early-true silences every sound:
            // message pings, call ringing, voice join/leave blips.
            find: '"NotificationSettingsStore"',
            replacement: {
                match: /isSoundDisabled\((\i)\)\{return/,
                replace: "isSoundDisabled($1){if($self.shouldSuppressSounds())return!0;return",
            },
        },
        {
            // Incoming calls. Verified 2026-10-01: IncomingCallStore hides
            // everything behind its n0 flag (DND-or-streamer-mode), and its
            // getters are consulted live on every call event — so gating
            // the getters (plus the n0 computation itself) suppresses both
            // the ringing sound driver and the incoming-call UI.
            find: '"IncomingCallStore"',
            replacement: [
                {
                    match: /getIncomingCalls\(\)\{return/,
                    replace: "getIncomingCalls(){if($self.callsSuppressed())return[];return",
                },
                {
                    match: /hasIncomingCalls\(\)\{return/,
                    replace: "hasIncomingCalls(){if($self.callsSuppressed())return!1;return",
                },
                {
                    match: /(\i=\i\.\i\.getStatus\(\)===\i\.\i\.DND\|\|\i\.\i\.getSetting\(\))(?=\})/,
                    replace: "$1||$self.callsSuppressed()",
                },
            ],
        },
        {
            // Account status submenu (Online / Idle / DND / Invisible).
            // Verified 2026-10-01: items are assembled as
            // `children:[l,SEP,o,d,c,...]` where c is the Invisible item,
            // so inserting right after c adds a 5th entry after Invisible.
            // NOTE: no closing bracket — the array continues with more
            // elements (e.g. the quiet-mode entry) after this point.
            find: '"menu-separator-statuses"',
            replacement: {
                match: /children:\[(\i),\(0,(\i)\.jsx\)\((\i\.\i),\{\},"menu-separator-statuses"\),(\i),(\i),(\i)/,
                replace: 'children:[$1,(0,$2.jsx)($3,{},"menu-separator-statuses"),$4,$5,$6,$self.renderPickerItem()',
            },
        },
    ],

    commands: [
        {
            name: "invisidnd",
            description: "Toggle InvisiDND (invisible to others, silent locally)",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "value",
                    description: "On/off (default: toggle)",
                    required: false,
                    type: ApplicationCommandOptionType.BOOLEAN,
                },
            ],
            execute: async (args, ctx) => {
                const value = findOption<boolean>(args, "value", !isActive());
                setActive(value);
                sendBotMessage(ctx.channel.id, {
                    content: value ? "InvisiDND enabled." : "InvisiDND disabled.",
                });
            },
        },
    ],

    toolboxActions: {
        "Toggle InvisiDND": () => setActive(!isActive()),
    },

    start() {
        // Status resets on restart, so re-apply if the toggle was left on.
        if (isActive()) enableInvisiDND(true);
    },

    shouldSuppressNotifications() {
        try {
            return isActive() && !!settings.store.suppressNotifications;
        } catch (e) {
            logger.warn(e);
            return false;
        }
    },

    shouldSuppressSounds() {
        try {
            return isActive() && !!settings.store.suppressSounds;
        } catch (e) {
            logger.warn(e);
            return false;
        }
    },

    callsSuppressed() {
        try {
            return isActive() && !!settings.store.suppressCalls;
        } catch (e) {
            logger.warn(e);
            return false;
        }
    },

    isExcluded(userId?: string | null) {
        try {
            if (!userId || !isActive()) return false;
            return parseExcludedIds().has(userId);
        } catch (e) {
            logger.warn(e);
            return false;
        }
    },

    renderPickerItem() {
        try {
            // Same row shape Discord itself uses for Online/Idle/DND/Invisible:
            // dot icon + label + subtext. State is shown via the subtext since
            // the menu re-renders fresh every time it opens.
            // The submenu (arrow) holds receive-toggles plus durations,
            // mirroring how DND offers timed options.
            const active = isActive();
            return React.createElement(Menu.MenuItem, {
                id: "invisidnd-status",
                keepItemStyles: true,
                hasSubmenu: true,
                label: "InvisiDND",
                subtext: active ? "Active: invisible + silent" : "Invisible + silent locally",
                iconLeft: InvisiDNDDot,
                leadingAccessory: { type: "icon", icon: InvisiDNDDot },
                action: () => setActive(!active),
                dontCloseOnAction: true,
            }, buildPickerSubmenu());
        } catch (e) {
            logger.warn("Could not render picker item", e);
            return null;
        }
    },
});
