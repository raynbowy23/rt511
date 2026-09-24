import { useId, useLayoutEffect, useRef, useState, type ReactNode, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

export function HoverCard({ children, content }: { children: ReactNode; content: ReactNode | (() => ReactNode) }): ReactElement {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const position = (): void => {
      if (!trigger.current || !card.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const box = card.current.getBoundingClientRect();
      card.current.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - box.width - 8))}px`;
      card.current.style.top = `${Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8))}px`;
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open]);
  return <span ref={trigger} className="hover-trigger" tabIndex={0} aria-describedby={open ? id : undefined}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (document.activeElement !== trigger.current) setOpen(false); }}
    onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
    {children}
    {open && createPortal(<div ref={card} id={id} role="tooltip" className="hover-card">{typeof content === 'function' ? content() : content}</div>, document.body)}
  </span>;
}
