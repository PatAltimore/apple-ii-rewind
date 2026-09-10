/**
 * "Load another disk" panel (Total Replay mode only): a dropdown of
 * curated Internet Archive titles, a free-text URL box, and a "⏏ Total
 * Replay" button that goes back to the built-in image.
 *
 * Switching disks **reloads the page** with a `?disk=<url>` parameter
 * (Total Replay = no parameter) rather than swapping the image in a
 * running machine. main.ts mounts `?disk=` before the first boot, so it
 * goes through the exact same, known-good cold-boot path as a normal
 * load — a mid-session reset leaves MMU/soft-switch state from the
 * previous disk that hangs the ROM's slot scan (same lesson as
 * `?boot=basic` being a real reload).
 */
interface LibraryImage {
    title: string;
    url: string;
    note?: string;
}

interface LibraryFile {
    images: LibraryImage[];
}

export interface DiskLibraryElements {
    select: HTMLSelectElement;
    urlInput: HTMLInputElement;
    loadBtn: HTMLButtonElement;
    resetBtn: HTMLButtonElement;
    status: HTMLElement;
}

export interface DiskLibraryOptions {
    /** The `?disk=` parameter for this page load, or null for Total Replay. */
    currentDiskUrl: string | null;
    elements: DiskLibraryElements;
}

const LIBRARY_URL = '/disks/library.json';
const CUSTOM_OPTION_VALUE = '__custom__';

function fileNameOf(url: string): string {
    try {
        return decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || url);
    } catch {
        return url;
    }
}

/** Reload onto `url`, or back to Total Replay when `url` is null. */
function goToDisk(url: string | null): void {
    const target = new URL(location.pathname, location.href);
    if (url) {
        target.searchParams.set('disk', url);
    }
    // A full navigation: the cleanest possible cold boot.
    location.assign(target.toString());
}

export async function attachDiskLibrary(options: DiskLibraryOptions): Promise<void> {
    const { currentDiskUrl, elements } = options;
    const { select, urlInput, loadBtn, resetBtn, status } = elements;

    const known = new Set<string>();

    try {
        const response = await fetch(LIBRARY_URL);
        if (response.ok) {
            const library = (await response.json()) as LibraryFile;
            for (const image of library.images ?? []) {
                const option = document.createElement('option');
                option.value = image.url;
                option.textContent = image.note ? `${image.title} — ${image.note}` : image.title;
                select.appendChild(option);
                known.add(image.url);
            }
        }
    } catch {
        /* the curated list is optional; the URL box still works */
    }

    // Reflect what this page actually booted: a known title selects its
    // row, a pasted URL gets a one-off "Custom disk" row, Total Replay
    // leaves the disabled "Load another disk…" placeholder showing.
    if (currentDiskUrl && known.has(currentDiskUrl)) {
        select.value = currentDiskUrl;
    } else if (currentDiskUrl) {
        const custom = document.createElement('option');
        custom.value = CUSTOM_OPTION_VALUE;
        custom.textContent = `Custom disk — ${fileNameOf(currentDiskUrl)}`;
        select.insertBefore(custom, select.options[1] ?? null);
        select.value = CUSTOM_OPTION_VALUE;
    }

    const submit = (url: string): void => {
        if (!url) {
            return;
        }
        status.textContent = 'Loading…';
        loadBtn.disabled = true;
        resetBtn.disabled = true;
        select.disabled = true;
        goToDisk(url);
    };

    loadBtn.addEventListener('click', () => {
        const picked = select.value && select.value !== CUSTOM_OPTION_VALUE ? select.value : '';
        submit(urlInput.value.trim() || picked);
    });
    resetBtn.addEventListener('click', () => {
        status.textContent = 'Loading…';
        goToDisk(null);
    });
    urlInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submit(urlInput.value.trim());
        }
    });
    select.addEventListener('change', () => {
        if (select.value && select.value !== CUSTOM_OPTION_VALUE) {
            submit(select.value);
        }
    });
}
