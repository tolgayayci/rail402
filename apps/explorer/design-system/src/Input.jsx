import React from 'react';
export function Input({ error = false, style, ...rest }) {
  return <input {...rest} spellCheck={false} style={{
    fontFamily: 'var(--font-mono)', fontSize: '11px', padding: '8px 10px',
    border: '1.5px solid ' + (error ? 'var(--acc)' : 'var(--line)'),
    background: 'var(--bg)', color: 'var(--ink)', outline: 'none', borderRadius: 0, ...style
  }} />;
}
