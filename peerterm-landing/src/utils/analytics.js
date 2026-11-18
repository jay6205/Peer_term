import { useEffect, useRef } from 'react';

/**
 * Send a GA4 event explicitly tagged as a PeerTerm Landing Page event.
 * Every event is prefixed with `landing_` and carries `event_category: 'landing_page'`
 * and `page_type: 'landing_page'` so it stays cleanly separated from `/connect/` app events.
 */
export function trackLandingEvent(action, params = {}) {
  const eventName = action.startsWith('landing_') ? action : `landing_${action}`;
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('event', eventName, {
        event_category: 'landing_page',
        page_type: 'landing_page',
        ...params,
      });
    }
  } catch {
    // Analytics must never break UX
  }
}

/**
 * Fires `landing_section_view` once when a section enters the viewport (30% visible).
 */
export function useSectionTracking(ref, sectionName) {
  const trackedRef = useRef(false);

  useEffect(() => {
    const el = ref?.current;
    if (!el || trackedRef.current || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !trackedRef.current) {
          trackedRef.current = true;
          trackLandingEvent('section_view', { section: sectionName });
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, sectionName]);
}
