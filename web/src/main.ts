/**
 * App entry point. Boots an Enhanced Apple //e in apple2js, mounts the
 * Total Replay hard-drive image, and wires the surrounding UI: rewind
 * scrubber, save/load states, on-screen touch controls, keyboard.
 */
import { Apple2 } from 'js/apple2';
import { bootEmulator, hardReset, loadBlockImageFromUrl } from './emulator/EmulatorController';
import { attachKeyboard } from './emulator/keyboard';
import { RewindBuffer, RewindRecorder } from './emulator/snapshot/RewindBuffer';
import { captureSnapshot } from './emulator/snapshot/SnapshotSerializer';
import { captureThumbnail } from './emulator/snapshot/thumbnail';
import { attachRewindScrubber, attachRewindButton } from './ui/RewindScrubber';
import { attachSaveLoadMenu } from './ui/SaveMenu';
import { attachTouchControls } from './ui/TouchControls';
import { attachControlModeSwitch } from './ui/ControlModeSwitch';
import { attachFullscreenToggle, currentFullscreenElement } from './ui/Fullscreen';

const DISK_URL = '/disks/TotalReplay.hdv';

/**
 * `?boot=basic` skips mounting Total Replay's drive entirely and lets the
 * //e's own ROM autoboot logic do what it would on real hardware with no
 * bootable device anywhere: fall through to a genuine, correctly
 * initialized Applesoft cold boot. This replaced an earlier approach that
 * tried to jump a *running* Total Replay session straight into Applesoft
 * mid-session — confirmed working for the prompt itself (it rendered and
 * echoed keystrokes correctly) but pressing Return to submit a line
 * reliably dropped into the machine-language monitor instead of running
 * it, evidently missing some further state a genuine cold boot sets up
 * that a warm jump doesn't (see docs/DECISIONS.md's 2026-09-08 entry).
 * A real fresh boot sidesteps that entirely by using the exact same
 * boot path already proven to work for Total Replay itself, just never
 * loading a drive.
 *
 * The trade-off: since nothing is ever mounted in this mode, there's no
 * soft reset vector for Ctrl-Reset to return to, so the only way back to
 * Total Replay is reloading the page without this query parameter — see
 * the "Total Replay" link `applesoft-hint` shows in this mode.
 */
const BASIC_BOOT_MODE = new URLSearchParams(location.search).get('boot') === 'basic';

// A snapshot excludes the hard drive (see EmulatorController.ts) and so
// measures ~170KB: two 48K RAM banks, MMU/language-card banks, CPU and
// video softswitch state. 5 minutes at a 2s interval is 150 entries,
// roughly 25MB plus a few KB of thumbnail each — comfortable even on a
// phone, and fine-grained enough that "-5s" lands within a couple of
// seconds of where you meant.
const REWIND_SNAPSHOT_INTERVAL_MS = 2000;
const REWIND_TOTAL_MS = 5 * 60 * 1000;
const REWIND_CAPACITY = REWIND_TOTAL_MS / REWIND_SNAPSHOT_INTERVAL_MS;
const REWIND_BUTTON_SECONDS = 5;
const REWIND_HOTKEY = 'F2';

// Backspace additionally rewinds, but only while fullscreen — see
// keyboard.ts's isFullscreenBackspace and RewindScrubber.ts's
// attachRewindButton doc comments for why it's conditional rather than
// always-on (it's Total Replay's own text-editing key otherwise).
function isRewindHotkey(event: KeyboardEvent): boolean {
    return event.key === REWIND_HOTKEY || (event.key === 'Backspace' && currentFullscreenElement() !== null);
}

function formatMB(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(1);
}

async function main() {
    const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
    const canvasWrap = document.querySelector<HTMLElement>('#canvas-wrap')!;
    const statusEl = document.querySelector<HTMLElement>('#disk-status')!;
    const menuBtn = document.querySelector<HTMLButtonElement>('#menu-btn')!;
    const applesoftBtn = document.querySelector<HTMLButtonElement>('#applesoft-btn')!;
    const fullscreenBtn = document.querySelector<HTMLButtonElement>('#fullscreen-btn')!;
    const rewindSlider = document.querySelector<HTMLInputElement>('#rewind-slider')!;
    const rewind5sBtn = document.querySelector<HTMLButtonElement>('#rewind-5s-btn')!;
    const rewindThumbnail = document.querySelector<HTMLImageElement>('#rewind-thumbnail')!;
    const bootOverlay = document.querySelector<HTMLElement>('#boot-overlay')!;
    const bootProgress = document.querySelector<HTMLProgressElement>('#boot-progress')!;
    const bootStatus = document.querySelector<HTMLElement>('#boot-status')!;

    attachControlModeSwitch();

    const rewindBuffer = new RewindBuffer(REWIND_CAPACITY);
    let apple2Ref: Apple2 | undefined;
    let scrubberHandle: { syncRange: () => void } | undefined;
    let recording = false;
    const recorder = new RewindRecorder(
        rewindBuffer,
        REWIND_SNAPSHOT_INTERVAL_MS,
        () => captureSnapshot(apple2Ref!),
        () => captureThumbnail(canvas)
    );

    const { apple2, smartport } = await bootEmulator(
        canvas,
        () => {
            if (recording) {
                recorder.onTick();
            }
            scrubberHandle?.syncRange();
        },
        { emptySlotStubs: BASIC_BOOT_MODE }
    );
    apple2Ref = apple2;

    // Set once at boot, not toggled at runtime — see BASIC_BOOT_MODE's
    // comment above for why there's no in-session transition anymore.
    // Hides the game-session UI (Save/Load/rewind bar/movement legend),
    // none of which has anything to do while typing BASIC; #applesoft-hint
    // (shown instead) explains how to get back.
    document.body.classList.toggle('applesoft-mode', BASIC_BOOT_MODE);

    const touchControls = attachTouchControls(apple2.getIO(), {
        joystickBase: document.querySelector('#touch-joystick')!,
        joystickThumb: document.querySelector('#touch-joystick-thumb')!,
        modeAnalogBtn: document.querySelector('#joystick-mode-analog')!,
        modeKeysBtn: document.querySelector('#joystick-mode-keys')!,
        keyLayoutSelect: document.querySelector('#joystick-key-layout')!,
        centeringBtn: document.querySelector('#joystick-centering')!,
        fireLeft: document.querySelector('#touch-fire-left')!,
        fireLeftLabel: document.querySelector('#touch-fire-left-label')!,
        fireRight: document.querySelector('#touch-fire-right')!,
        fireRightLabel: document.querySelector('#touch-fire-right-label')!,
        swapButtonsBtn: document.querySelector('#swap-buttons')!,
        keyButtons: Array.from(document.querySelectorAll<HTMLElement>('.touch-key[data-key]')),
        typeBtn: document.querySelector('#touch-type-btn')!,
        typeInput: document.querySelector('#touch-type-input')!,
    });

    // Debug handles, mirroring apple2js's own window.apple2 convention.
    Object.assign(window, {
        __apple2: apple2,
        __smartport: smartport,
        __rewindBuffer: rewindBuffer,
        __touchControls: touchControls,
    });

    attachKeyboard(apple2, canvas);
    canvas.addEventListener('click', () => canvas.focus());
    canvas.focus();

    // Ctrl-Reset. Total Replay installs its own reset handler that
    // relaunches the menu, so this doubles as "quit game". In basic-boot
    // mode nothing installs a soft vector, so this just re-runs the same
    // cold boot — a harmless (arguably useful) "reset my BASIC session".
    menuBtn.addEventListener('click', () => {
        hardReset(apple2);
        canvas.focus();
    });

    // Leaves Total Replay entirely for a fresh Applesoft-only boot — see
    // BASIC_BOOT_MODE's comment for why this is a full reload rather than
    // an in-session jump.
    applesoftBtn.addEventListener('click', () => {
        const url = new URL(location.href);
        url.searchParams.set('boot', 'basic');
        location.href = url.toString();
    });

    // The only way back from basic-boot mode — see BASIC_BOOT_MODE's comment.
    const totalReplayLink = document.querySelector<HTMLAnchorElement>('#total-replay-link');
    if (totalReplayLink) {
        totalReplayLink.href = location.pathname;
    }

    attachFullscreenToggle(fullscreenBtn, canvasWrap, canvas);

    scrubberHandle = attachRewindScrubber(rewindSlider, apple2, rewindBuffer, canvas, rewindThumbnail);
    attachRewindButton(rewind5sBtn, apple2, rewindBuffer, canvas, REWIND_BUTTON_SECONDS, isRewindHotkey);

    attachSaveLoadMenu(apple2, canvas, statusEl, {
        saveBtn: document.querySelector('#save-btn')!,
        loadBtn: document.querySelector('#load-btn')!,
        saveDialog: document.querySelector('#save-dialog')!,
        saveForm: document.querySelector('#save-form')!,
        saveNameInput: document.querySelector('#save-name-input')!,
        saveError: document.querySelector('#save-error')!,
        saveCancelBtn: document.querySelector('#save-cancel-btn')!,
        loadDialog: document.querySelector('#load-dialog')!,
        loadList: document.querySelector('#load-list')!,
        loadEmpty: document.querySelector('#load-empty')!,
        loadCancelBtn: document.querySelector('#load-cancel-btn')!,
    });

    if (BASIC_BOOT_MODE) {
        // No drive to mount — the //e's own ROM autoboot finds nothing
        // bootable anywhere and falls through to Applesoft on its own.
        bootOverlay.hidden = true;
        statusEl.textContent = 'Applesoft BASIC';
    } else {
        try {
            const { fromCache } = await loadBlockImageFromUrl(smartport, 1, DISK_URL, (loaded, total) => {
                if (total) {
                    bootProgress.value = (loaded / total) * 100;
                    bootStatus.textContent = `Downloading disk image… ${formatMB(loaded)} / ${formatMB(total)} MB`;
                } else {
                    bootProgress.removeAttribute('value');
                    bootStatus.textContent = `Downloading disk image… ${formatMB(loaded)} MB`;
                }
            });
            if (fromCache) {
                // Overwrites the "Downloading…" text the progress callback
                // just set (it still fires once, at 100%, on a cache hit)
                // so the brief overlay flash reads correctly instead of
                // implying a download that didn't happen.
                bootProgress.value = 100;
                bootStatus.textContent = 'Loaded from local cache';
            }
        } catch (err) {
            statusEl.textContent = 'Failed to load disk image';
            bootStatus.textContent = 'Failed to load the disk image — check the console and reload.';
            console.error(err);
            return;
        }

        bootOverlay.hidden = true;
        statusEl.textContent = 'Total Replay';
    }

    recording = true;
    apple2.reset();
    apple2.run();
}

main().catch((err) => {
    console.error(err);
    const statusEl = document.querySelector<HTMLElement>('#disk-status');
    if (statusEl) {
        statusEl.textContent = 'Emulator failed to start — see console';
    }
    const bootStatus = document.querySelector<HTMLElement>('#boot-status');
    if (bootStatus) {
        bootStatus.textContent = 'Emulator failed to start — see console.';
    }
});
