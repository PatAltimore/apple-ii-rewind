/**
 * App entry point. Boots an Enhanced Apple //e in apple2js, mounts the
 * Total Replay hard-drive image, and wires the surrounding UI: rewind
 * scrubber, save/load states, on-screen touch controls, keyboard.
 */
import { Apple2 } from 'js/apple2';
import { bootEmulator, breakToApplesoft, hardReset, loadBlockImageFromUrl } from './emulator/EmulatorController';
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

    const { apple2, smartport } = await bootEmulator(canvas, () => {
        if (recording) {
            recorder.onTick();
        }
        scrubberHandle?.syncRange();
    });
    apple2Ref = apple2;

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

    // Whether the machine has been broken into a raw Applesoft prompt
    // (see breakToApplesoft in EmulatorController.ts) rather than running
    // Total Replay's menu or a game — tracked as a body class so
    // style.css can hide the game-session UI (Save/Load/rewind/movement
    // legend), which has nothing useful to do while typing BASIC. Any
    // hard reset — via the Menu button or Delete/Ctrl-Reset — is by
    // definition an exit from this mode, since it's the only way in.
    function setApplesoftMode(on: boolean) {
        document.body.classList.toggle('applesoft-mode', on);
    }

    attachKeyboard(apple2, canvas, () => setApplesoftMode(false));
    canvas.addEventListener('click', () => canvas.focus());
    canvas.focus();

    // Ctrl-Reset. Total Replay installs its own reset handler that
    // relaunches the menu, so this doubles as "quit game".
    menuBtn.addEventListener('click', () => {
        hardReset(apple2);
        setApplesoftMode(false);
        canvas.focus();
    });

    applesoftBtn.addEventListener('click', () => {
        breakToApplesoft(apple2);
        setApplesoftMode(true);
        canvas.focus();
    });

    attachFullscreenToggle(fullscreenBtn, canvasWrap);

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
            // Overwrites the "Downloading…" text the progress callback just
            // set (it still fires once, at 100%, on a cache hit) so the
            // brief overlay flash reads correctly instead of implying a
            // download that didn't happen.
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
