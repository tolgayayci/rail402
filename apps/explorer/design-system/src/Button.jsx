import React from 'react';
export function Button({ variant = 'default', size = 'md', active = false, disabled = false, children, ...rest }) {
  const pad = size === 'sm' ? '5px 11px' : size === 'lg' ? '12px 18px' : '8px 14px';
  const variants = {
    default: { background: active ? 'var(--ink)' : 'var(--panel)', color: active ? 'var(--panel)' : 'var(--ink)', border: '1.5px solid var(--ink)' },
    accent: { background: 'var(--acc)', color: 'var(--onacc)', border: '1.5px solid var(--acc)' },
    solid: { background: 'var(--ink)', color: 'var(--panel)', border: '1.5px solid var(--ink)' },
    ghost: { background: 'transparent', color: 'var(--mut)', border: '1.5px solid var(--line)' }
  };
  return (
    <button {...rest} disabled={disabled} style={{
      fontFamily: 'var(--font-mono)', fontSize: size === 'lg' ? '12px' : '11px', fontWeight: 700,
      letterSpacing: 'var(--ls-control)', textTransform: 'uppercase', padding: pad, borderRadius: 0,
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, ...variants[variant]
    }}>{children}</button>
  );
}
