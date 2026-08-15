import React, { useState } from 'react';

/**
 * The design canvas's `style-hover` attribute as a component: renders `tag` with `style`,
 * merging `hover` on top while the pointer is inside — identical semantics, no CSS classes.
 */
export function Hov({ tag: Tag = 'span', hover, style, onMouseEnter, onMouseLeave, children, ...rest }) {
  const [on, setOn] = useState(false);
  return (
    <Tag
      {...rest}
      style={on && hover ? { ...style, ...hover } : style}
      onMouseEnter={e => { setOn(true); if (onMouseEnter) onMouseEnter(e); }}
      onMouseLeave={e => { setOn(false); if (onMouseLeave) onMouseLeave(e); }}
    >
      {children}
    </Tag>
  );
}
