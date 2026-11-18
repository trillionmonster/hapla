/**
 * Simple utility for switching between normal and active favicons
 */

const FAVICON_NORMAL = '/brand/hapla-favicon-v1.svg';
const FAVICON_ACTIVE = '/brand/hapla-favicon-active-v1.svg';

/**
 * Updates the favicon in the document
 */
function setFavicon(url: string) {
    if (typeof document === 'undefined') return;
    
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }

    link.type = 'image/svg+xml';
    link.setAttribute('sizes', 'any');
    // Versioned resources invalidate the old brand without refetching or
    // blinking whenever presence or permission state is reconciled.
    if (link.getAttribute('href') !== url) link.href = url;
}

/**
 * Updates the favicon to show a notification indicator
 */
export function updateFaviconWithNotification() {
    setFavicon(FAVICON_ACTIVE);
}

/**
 * Resets the favicon to its original state
 */
export function resetFavicon() {
    setFavicon(FAVICON_NORMAL);
}
