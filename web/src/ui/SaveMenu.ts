import { Apple2 } from 'js/apple2';
import { captureSnapshot, restoreSnapshot } from '../emulator/snapshot/SnapshotSerializer';
import { saveGame, loadSave, deleteSave, listSaves, SaveMeta } from '../emulator/snapshot/SaveGameStore';
import { captureThumbnail } from '../emulator/snapshot/thumbnail';

export interface SaveMenuElements {
    saveBtn: HTMLButtonElement;
    loadBtn: HTMLButtonElement;
    saveDialog: HTMLDialogElement;
    saveForm: HTMLFormElement;
    saveNameInput: HTMLInputElement;
    saveError: HTMLElement;
    saveCancelBtn: HTMLButtonElement;
    loadDialog: HTMLDialogElement;
    loadList: HTMLUListElement;
    loadEmpty: HTMLElement;
    loadCancelBtn: HTMLButtonElement;
}

function formatSavedAt(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

/**
 * Wires the Save/Load dialogs to the IndexedDB save store. Saving pauses
 * the emulator while the snapshot is taken (so the state and thumbnail
 * match) and resumes afterwards; both dialogs refocus the game canvas on
 * close — including ESC dismissal via the native `close` event — because
 * keyboard input only reaches the emulator while the canvas has focus.
 */
export function attachSaveLoadMenu(
    apple2: Apple2,
    canvas: HTMLCanvasElement,
    statusEl: HTMLElement,
    els: SaveMenuElements
): void {
    const {
        saveBtn,
        loadBtn,
        saveDialog,
        saveForm,
        saveNameInput,
        saveError,
        saveCancelBtn,
        loadDialog,
        loadList,
        loadEmpty,
        loadCancelBtn,
    } = els;

    let pendingSnapshot: { state: ReturnType<typeof captureSnapshot>; thumbnail: string } | undefined;

    saveDialog.addEventListener('close', () => {
        pendingSnapshot = undefined;
        apple2.run();
        canvas.focus();
    });
    loadDialog.addEventListener('close', () => {
        apple2.run();
        canvas.focus();
    });

    saveBtn.addEventListener('click', () => {
        // Snapshot the moment the player hits Save, not after they finish
        // typing a name — otherwise the game keeps running underneath.
        apple2.stop();
        pendingSnapshot = { state: captureSnapshot(apple2), thumbnail: captureThumbnail(canvas) };
        saveError.hidden = true;
        saveNameInput.value = `Save ${formatSavedAt(Date.now())}`;
        saveDialog.showModal();
        saveNameInput.focus();
        saveNameInput.select();
    });

    saveCancelBtn.addEventListener('click', () => saveDialog.close());

    // Implicit submission normally covers this, but some on-screen
    // keyboards deliver Enter without triggering it.
    saveNameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveForm.requestSubmit();
        }
    });

    saveForm.addEventListener('submit', (event) => {
        event.preventDefault();
        const name = saveNameInput.value.trim();
        if (!name || !pendingSnapshot) {
            return;
        }
        const snapshot = pendingSnapshot;
        void (async () => {
            try {
                await saveGame(name, snapshot.state, snapshot.thumbnail);
            } catch (err) {
                saveError.textContent = err instanceof Error ? err.message : String(err);
                saveError.hidden = false;
                return;
            }
            statusEl.textContent = `Saved "${name}"`;
            saveDialog.close();
        })();
    });

    const renderLoadList = async () => {
        const saves = await listSaves();
        loadList.innerHTML = '';
        loadEmpty.hidden = saves.length > 0;
        for (const meta of saves) {
            loadList.appendChild(renderSaveListItem(meta));
        }
    };

    const renderSaveListItem = (meta: SaveMeta): HTMLLIElement => {
        const item = document.createElement('li');

        if (meta.thumbnail) {
            const img = document.createElement('img');
            img.className = 'save-list-thumb';
            img.src = meta.thumbnail;
            img.alt = '';
            item.appendChild(img);
        }

        const info = document.createElement('div');
        info.className = 'save-list-info';
        const nameEl = document.createElement('span');
        nameEl.className = 'save-list-name';
        nameEl.textContent = meta.name;
        const dateEl = document.createElement('span');
        dateEl.className = 'save-list-date';
        dateEl.textContent = formatSavedAt(meta.savedAt);
        info.appendChild(nameEl);
        info.appendChild(dateEl);

        const actions = document.createElement('div');
        actions.className = 'save-list-actions';

        const loadItemBtn = document.createElement('button');
        loadItemBtn.type = 'button';
        loadItemBtn.textContent = 'Load';
        loadItemBtn.addEventListener('click', () => {
            void (async () => {
                const state = await loadSave(meta.id);
                if (!state) {
                    return;
                }
                restoreSnapshot(apple2, state);
                statusEl.textContent = `Loaded "${meta.name}"`;
                loadDialog.close(); // 'close' handler resumes the emulator
            })();
        });

        const deleteItemBtn = document.createElement('button');
        deleteItemBtn.type = 'button';
        deleteItemBtn.textContent = 'Delete';
        deleteItemBtn.className = 'save-list-delete';
        deleteItemBtn.addEventListener('click', () => {
            void deleteSave(meta.id).then(renderLoadList);
        });

        actions.appendChild(loadItemBtn);
        actions.appendChild(deleteItemBtn);

        item.appendChild(info);
        item.appendChild(actions);
        return item;
    };

    loadBtn.addEventListener('click', () => {
        apple2.stop();
        void renderLoadList().then(() => loadDialog.showModal());
    });

    loadCancelBtn.addEventListener('click', () => loadDialog.close());
}
