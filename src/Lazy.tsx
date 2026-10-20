import { ScaledSlide, SlideRenderer } from '@slidr/renderer';
import type { AssetResolver } from '@slidr/renderer';
import type { Deck, Slide } from '@slidr/model';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useWidth } from './width';

/**
 * Draws its content once it comes near the viewport, and keeps it drawn: a gallery of hundreds of
 * slides draws only the ones the person scrolls to.
 */
export function WhenSeen({ children, ratio = '16 / 9' }: { children: ReactNode; ratio?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return (
    <div ref={ref} className="when-seen" style={seen ? undefined : { aspectRatio: ratio }}>
      {seen ? children : null}
    </div>
  );
}

/** A slide drawn by the app's renderer at the width of its container, or at a fixed width. */
export function DeckSlide({
  deck,
  slide,
  resolveAsset,
  width: fixed,
  lazy = false,
}: {
  deck: Deck;
  slide: Slide;
  resolveAsset?: AssetResolver;
  width?: number;
  lazy?: boolean;
}) {
  const [ref, measured] = useWidth<HTMLDivElement>();
  const width = fixed ?? measured;
  const drawn =
    width > 0 ? (
      <ScaledSlide
        deck={deck}
        slide={slide}
        width={width}
        mode="thumbnail"
        resolveAsset={resolveAsset}
      />
    ) : (
      <div className="slide-empty" />
    );
  return (
    <div ref={ref} className="slide-frame" style={fixed ? { width: fixed } : undefined}>
      {lazy ? <WhenSeen>{drawn}</WhenSeen> : drawn}
    </div>
  );
}

/**
 * An element alone on a slide (a card set, a frame), as the renderer draws it, cut to its own
 * box at the slide's corner and scaled to `width`: as the Elements panel shows it. `bleed` is the
 * room around the box where a shadow may fall, in pixels of the picture.
 */
export function ElementPicture({
  deck,
  slide,
  size,
  width,
  resolveAsset,
  bleed = 0,
}: {
  deck: Deck;
  slide: Slide;
  size: { w: number; h: number };
  width: number;
  resolveAsset?: AssetResolver;
  bleed?: number;
}) {
  const scale = width / size.w;
  return (
    // Scaled from its left corner, in a page that reads from the right.
    <div
      aria-hidden
      dir="ltr"
      className="element-picture"
      style={{ width, height: size.h * scale, overflowClipMargin: bleed }}
    >
      <div style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', scale }}>
        <SlideRenderer deck={deck} slide={slide} mode="thumbnail" resolveAsset={resolveAsset} />
      </div>
    </div>
  );
}
