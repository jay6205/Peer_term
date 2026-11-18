import { useEffect, useRef } from 'react';
import anime from 'animejs/lib/anime.es';

export default function useStaggerReveal(selector, options = {}) {
  const ref = useRef(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const children = container.querySelectorAll(selector);
    children.forEach((c) => {
      c.style.opacity = '0';
      c.style.transform = 'translateY(30px)';
    });

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          anime({
            targets: children,
            opacity: [0, 1],
            translateY: [30, 0],
            delay: anime.stagger(options.stagger || 120, { start: options.delay || 0 }),
            duration: options.duration || 700,
            easing: 'easeOutExpo',
          });
          observer.unobserve(container);
        }
      },
      { threshold: options.threshold || 0.1 }
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return ref;
}
