import React from 'react';
export function StatBlock({ label, value, hint, size = 'md', style }) {
  const fs = size === 'lg' ? '36px' : size === 'sm' ? '22px' : '28px';
  return (
    <div style={{ padding: 'var(--pad-panel)', ...style }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: 'var(--ls-label)', textTransform: 'uppercase', color: 'var(--mut)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-sans)', fontSize: fs, fontWeight: 700, letterSpacing: '-.02em', marginTop: '4px', display: 'flex', alignItems: 'center', gap: '10px' }}>{value}{hint != null && <span style={{ fontSize: '14px', color: 'var(--mut)', fontWeight: 400 }}>{hint}</span>}</div>
    </div>
  );
}
