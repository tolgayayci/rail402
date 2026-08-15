import React from 'react';
export function Badge({ variant = 'outline', children, ...rest }) {
  const variants = {
    accent: { background: 'var(--acc)', color: 'var(--onacc)', border: '1.5px solid var(--ink)' },
    solid: { background: 'var(--ink)', color: 'var(--panel)', border: '1.5px solid var(--ink)' },
    outline: { background: 'transparent', color: 'var(--ink)', border: '1.5px solid var(--ink)' },
    unknown: { background: 'transparent', color: 'var(--mut)', border: '1.5px solid var(--line)' }
  };
  return <span {...rest} style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 700, letterSpacing: 'var(--ls-badge)', textTransform: 'uppercase', padding: '3px 8px', display: 'inline-block', ...variants[variant] }}>{children}</span>;
}
