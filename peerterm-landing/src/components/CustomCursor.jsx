import { useEffect, useRef, useState } from 'react';
import { animate, createSpring } from 'animejs';
import '../styles/CustomCursor.css';

/**
 * Minimalist Custom Cursor
 * Subtle phosphor emerald dot + spring-animated trailing ring powered by Anime.js
 * Uses dedicated wrapper elements for translation to prevent transform collisions
 */
export default function CustomCursor() {
  const rootRef = useRef(null);
  const dotWrapRef = useRef(null);
  const ringWrapRef = useRef(null);
  const dotRef = useRef(null);
  const ringRef = useRef(null);

  const mousePosRef = useRef({ x: -100, y: -100 });
  const ringPosRef = useRef({ x: -100, y: -100 });
  const stateRef = useRef({ hovered: false, drag: false });
  const isMouseDownRef = useRef(false);
  const hasMovedRef = useRef(false);

  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isTouch = window.matchMedia('(pointer: coarse), (hover: none)').matches;
    if (isTouch) return;

    setIsSupported(true);
    document.body.classList.add('has-custom-cursor');

    return () => {
      document.body.classList.remove('has-custom-cursor');
    };
  }, []);

  useEffect(() => {
    if (!isSupported) return;

    const root = rootRef.current;
    const dotWrap = dotWrapRef.current;
    const ringWrap = ringWrapRef.current;
    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!root || !dotWrap || !ringWrap || !dot || !ring) return;

    let rafId;

    const updateHoverState = (hovered, drag) => {
      const current = stateRef.current;
      if (current.hovered === hovered && current.drag === drag) return;

      stateRef.current = { hovered, drag };

      if (drag) {
        root.className = 'custom-cursor is-visible cursor--drag';
      } else if (hovered) {
        root.className = 'custom-cursor is-visible cursor--interactive';
      } else {
        root.className = 'custom-cursor is-visible';
      }

      if (isMouseDownRef.current) return;

      const targetScale = hovered ? (drag ? 1.45 : 1.6) : 1;
      const targetDotScale = hovered ? 0.65 : 1;
      const targetBorder = drag
        ? 'rgba(245, 158, 11, 0.65)'
        : hovered
          ? 'rgba(110, 231, 183, 0.7)'
          : 'rgba(52, 211, 153, 0.35)';
      const targetBg = drag
        ? 'rgba(245, 158, 11, 0.08)'
        : hovered
          ? 'rgba(52, 211, 153, 0.08)'
          : 'transparent';

      animate(ring, {
        scale: targetScale,
        borderColor: targetBorder,
        backgroundColor: targetBg,
        duration: 250,
        ease: createSpring({ stiffness: 320, damping: 22 }),
      });

      animate(dot, {
        scale: targetDotScale,
        duration: 200,
        ease: 'outQuad',
      });
    };

    const inspectTarget = (target) => {
      if (!target || !(target instanceof Element)) {
        updateHoverState(false, false);
        return;
      }

      const dragEl = target.closest(
        '.draggable-win, .win-header, .host-drag-handle, .viewer-drag-handle, [data-draggable]'
      );
      if (dragEl) {
        updateHoverState(true, true);
        return;
      }

      const interactiveEl = target.closest(
        'button, a, .btn-signal, .btn-ghost, .cmd-chip, .wb-cmd-btn, .tab-btn, .faq-trigger, [role="button"], input, textarea'
      );
      if (interactiveEl) {
        updateHoverState(true, false);
        return;
      }

      updateHoverState(false, false);
    };

    const onPointerMove = (e) => {
      const x = e.clientX;
      const y = e.clientY;

      if (!hasMovedRef.current) {
        hasMovedRef.current = true;
        ringPosRef.current = { x, y };
        root.classList.add('is-visible');
      }

      mousePosRef.current = { x, y };

      // Immediate low-latency translation on wrapper (never touched by Anime.js)
      dotWrap.style.transform = `translate3d(${x}px, ${y}px, 0)`;

      inspectTarget(e.target);
    };

    const onMouseDown = () => {
      isMouseDownRef.current = true;
      const { hovered } = stateRef.current;

      animate(ring, {
        scale: hovered ? 1.25 : 0.75,
        duration: 140,
        ease: 'outQuad',
      });

      animate(dot, {
        scale: 1.35,
        duration: 140,
        ease: 'outQuad',
      });
    };

    const onMouseUp = (e) => {
      isMouseDownRef.current = false;
      const { hovered, drag } = stateRef.current;
      const targetScale = hovered ? (drag ? 1.45 : 1.6) : 1;
      const targetDotScale = hovered ? 0.65 : 1;

      animate(ring, {
        scale: targetScale,
        duration: 250,
        ease: createSpring({ stiffness: 340, damping: 20 }),
      });

      animate(dot, {
        scale: targetDotScale,
        duration: 220,
        ease: createSpring({ stiffness: 340, damping: 20 }),
      });

      if (e?.target) {
        inspectTarget(e.target);
      }
    };

    const onBlur = () => {
      isMouseDownRef.current = false;
      onMouseUp();
    };

    const onMouseLeave = () => {
      root.classList.remove('is-visible');
    };

    const onMouseEnter = () => {
      if (hasMovedRef.current) {
        root.classList.add('is-visible');
      }
    };

    // Smooth render loop: updates wrapper positions every frame
    const renderLoop = () => {
      const targetX = mousePosRef.current.x;
      const targetY = mousePosRef.current.y;

      // Lock inner dot wrapper to exact mouse coordinates
      dotWrap.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;

      // Fluid damped follower for outer ring wrapper
      ringPosRef.current.x += (targetX - ringPosRef.current.x) * 0.18;
      ringPosRef.current.y += (targetY - ringPosRef.current.y) * 0.18;
      ringWrap.style.transform = `translate3d(${ringPosRef.current.x}px, ${ringPosRef.current.y}px, 0)`;

      rafId = requestAnimationFrame(renderLoop);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('mousemove', onPointerMove, { passive: true });
    window.addEventListener('dragover', onPointerMove, { passive: true });
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('mouseenter', onMouseEnter);

    rafId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('dragover', onPointerMove);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mouseleave', onMouseLeave);
      document.removeEventListener('mouseenter', onMouseEnter);
    };
  }, [isSupported]);

  if (!isSupported) return null;

  return (
    <div ref={rootRef} className="custom-cursor" aria-hidden="true">
      <div ref={ringWrapRef} className="cursor-ring-wrap">
        <div ref={ringRef} className="cursor-ring" />
      </div>
      <div ref={dotWrapRef} className="cursor-dot-wrap">
        <div ref={dotRef} className="cursor-dot" />
      </div>
    </div>
  );
}
