export function canFullscreen() {
    const doc = document;
    return Boolean(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
}
export function fullscreenElement() {
    const doc = document;
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}
export async function enterFullscreen() {
    const root = document.documentElement;
    if (root.requestFullscreen)
        await root.requestFullscreen({ navigationUI: 'hide' });
    else if (root.webkitRequestFullscreen)
        await root.webkitRequestFullscreen();
    else
        throw new Error('Full screen is not available in this browser.');
}
export async function leaveFullscreen() {
    const doc = document;
    try {
        if (doc.exitFullscreen)
            await doc.exitFullscreen();
        else
            await doc.webkitExitFullscreen?.();
    }
    catch {
        // Already out of it.
    }
}
