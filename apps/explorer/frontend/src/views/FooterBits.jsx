import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function FooterBits({ v }) {
  return (
    <>
      {v.routeFacs ? (
        <div style={css('display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:center;border:2px solid var(--ink);background:var(--ink);color:var(--panel);padding:22px 26px;margin-top:26px;flex-wrap:wrap;')}>
          <div>
            <div style={css('font-size:20px;font-weight:700;letter-spacing:-.01em;')}>New to x402? Facilitators are the machines that settle these payments.</div>
            <p style={css('margin:8px 0 0;font-size:14px;line-height:1.55;color:var(--line);')}>Learn more in our docs, or if you run one, click Add Your Facilitator to get listed. Deployed via Rail402? It is listed automatically.</p>
          </div>
          <div style={css('display:flex;gap:10px;flex-wrap:wrap;')}>
            <a href="https://docs.rail402.dev" target="_blank" rel="noopener" style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:10px 16px;border:1.5px solid var(--panel);background:transparent;color:var(--panel);text-decoration:none;white-space:nowrap;`)}>WHAT IS A FACILITATOR? →</a>
            <a href="https://docs.rail402.dev" target="_blank" rel="noopener" style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:10px 16px;border:1.5px solid var(--acc);background:var(--acc);color:var(--onacc);text-decoration:none;white-space:nowrap;`)}>ADD YOUR FACILITATOR →</a>
          </div>
        </div>
      ) : null}
      <div style={css('display:flex;justify-content:space-between;align-items:center;gap:20px;border:2px solid var(--ink);background:var(--panel);padding:16px 22px;margin-top:26px;flex-wrap:wrap;')}>
        <span style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;`)}>RAIL402 EXPLORER · X402 ON STELLAR</span>
        <div style={css('display:flex;gap:10px;flex-wrap:wrap;')}>
          <Hov tag="a" href="https://docs.rail402.dev" target="_blank" rel="noopener" style={css(`display:inline-flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;padding:9px 14px;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);text-decoration:none;`)} hover={css('background:var(--ink);color:var(--panel);')}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>DOCS</Hov>
          <Hov tag="a" href="https://github.com/tolgayayci/rail402" target="_blank" rel="noopener" style={css(`display:inline-flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;padding:9px 14px;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);text-decoration:none;`)} hover={css('background:var(--ink);color:var(--panel);')}><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18a11 11 0 0 1 5.76 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"></path></svg>GITHUB</Hov>
          <Hov tag="a" href="" target="_blank" rel="noopener" style={css(`display:inline-flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;padding:9px 14px;border:1.5px solid var(--acc);background:var(--acc);color:var(--onacc);text-decoration:none;`)} hover={css('background:var(--ink);color:var(--panel);border-color:var(--ink);')}><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>PLAYGROUND</Hov>
        </div>
      </div>
    </>
  );
}
