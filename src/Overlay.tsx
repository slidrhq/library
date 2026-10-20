import { useEffect, type ReactNode } from 'react';
import { useT } from './i18n';

/**
 * An item of the library up close, over its section: the item's views, and beside them what it
 * is made of. The arrow keys step through the section as it is listed; Escape closes.
 */
export function ItemOverlay({
  title,
  subtitle,
  actions,
  side,
  children,
  onClose,
  onStep,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  side?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  /** Steps to the item before (-1) or after (1) this one, when there is one. */
  onStep?: (by: -1 | 1) => void;
}) {
  const t = useT();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select')) return;
      if (event.key === 'Escape') onClose();
      // The page is right to left: the arrow to the left goes on to the next item.
      else if (event.key === 'ArrowLeft') onStep?.(1);
      else if (event.key === 'ArrowRight') onStep?.(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onStep]);

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="detail">
        <header className="detail-head">
          <div className="detail-title">
            <h2>{title}</h2>
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          <div className="actions">
            {actions}
            {onStep && (
              <div className="segmented" role="group" aria-label={t('library.overlay.stepLabel')}>
                <button
                  type="button"
                  onClick={() => onStep(-1)}
                  aria-label={t('library.overlay.previous')}
                  title={t('library.overlay.previousTitle')}
                >
                  →
                </button>
                <button
                  type="button"
                  onClick={() => onStep(1)}
                  aria-label={t('library.overlay.next')}
                  title={t('library.overlay.nextTitle')}
                >
                  ←
                </button>
              </div>
            )}
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              aria-label={t('library.overlay.close')}
            >
              ✕
            </button>
          </div>
        </header>
        <div className={side ? 'detail-body' : 'detail-body single'}>
          <div className="stage">{children}</div>
          {side && <aside className="side">{side}</aside>}
        </div>
      </div>
    </div>
  );
}

/** Steps through a list from one of its items; undefined when the list has only that one. */
export function stepper<T>(
  list: readonly T[],
  current: T | undefined,
  open: (item: T) => void,
): ((by: -1 | 1) => void) | undefined {
  if (current === undefined || list.length < 2) return undefined;
  return (by) => {
    const at = list.indexOf(current);
    const next = list[(at + by + list.length) % list.length];
    if (next !== undefined) open(next);
  };
}
