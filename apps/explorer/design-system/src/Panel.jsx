import React from 'react';
export function Panel({ title, children, style }) {
  return (
    <div style={{ border: 'var(--border-frame)', background: 'var(--panel)', ...style }}>
      {title != null && <div style={{ padding: '10px 16px', borderBottom: 'var(--border-divider)', background: 'var(--head)', fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 400, letterSpacing: 'var(--ls-label)', textTransform: 'uppercase', color: 'var(--mut)' }}>{title}</div>}
      {children}
    </div>
  );
}
