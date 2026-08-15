import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function Assets({ v }) {
  return (
    <>
      <div style={css(`padding:22px 2px 18px;`)}>
        <h1 style={css(`margin:0;font-size:24px;font-weight:600;`)}>Assets</h1>
        <p style={css(`margin:8px 0 0;font-size:15px;line-height:1.5;color:var(--mut);`)}>Every token x402 payments have settled in.</p>
      </div>
      <div style={css(`border:2px solid var(--ink);background:var(--panel);overflow-x:auto;`)}>
        <div style={css(`display:grid;grid-template-columns:44px minmax(120px,1fr) minmax(140px,1.4fr) 140px 110px 130px;gap:14px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
          <span>RANK</span><span>ASSET</span><span>CONTRACT</span><span>SHARE OF PAYMENTS</span><span style={css(`text-align:right;`)}>PAYMENTS</span><span style={css(`text-align:right;`)}>VOLUME</span>
        </div>
        {v.assetRows.map((a, i) => (
          <div key={i} style={css(`display:grid;grid-template-columns:44px minmax(120px,1fr) minmax(140px,1.4fr) 140px 110px 130px;gap:14px;padding:12px 22px;border-bottom:1px solid var(--line);align-items:center;font-family:'JetBrains Mono',monospace;font-size:12px;`)}>
            <span style={css(`font-weight:700;color:var(--mut);`)}>{a.rank}</span>
            <span style={css(`display:flex;align-items:center;gap:8px;font-weight:700;`)}>{a.hasIcon ? <img src={a.iconUrl} alt={a.code} style={css(`width:17px;height:17px;border-radius:50%;object-fit:cover;flex:none;`)} /> : null}{a.code}</span>
            <span style={css(`display:flex;align-items:center;gap:7px;min-width:0;`)}>
              <Hov tag="a" href={a.expertUrl} target="_blank" rel="noopener" title="open on stellar.expert" style={css(`color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:underline;text-decoration-color:var(--acc);text-underline-offset:3px;`)} hover={css(`color:var(--acc);`)}>{a.contractShort}</Hov>
              <Hov tag="button" onClick={a.copyContract} title="copy contract address" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--mut);flex:none;`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>⧉</Hov>
            </span>
            <span style={css(`display:flex;align-items:center;gap:8px;`)}><span style={css(`flex:1;height:8px;border:1px solid var(--ink);background:var(--bg);`)}><span style={css(`display:block;height:100%;background:var(--acc);width:${a.sharePct};`)}></span></span><span style={css(`font-size:10px;color:var(--mut);`)}>{a.sharePct}</span></span>
            <span style={css(`text-align:right;font-weight:700;`)}>{a.countTxt}</span>
            <span style={css(`text-align:right;`)}>{a.volTxt}</span>
          </div>
        ))}
        <div style={css(`display:flex;justify-content:space-between;align-items:center;padding:12px 22px;border-top:1.5px solid var(--ink);`)}>
          <button onClick={v.assetPrev} disabled={v.assetPrevDisabled} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:7px 14px;cursor:${v.assetPrevCur};border:1.5px solid var(--ink);background:var(--panel);color:${v.assetPrevFg};`)}>← PREV</button>
          <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.12em;color:var(--mut);`)}>{v.assetPageTxt}</span>
          <button onClick={v.assetNext} disabled={v.assetNextDisabled} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:7px 14px;cursor:${v.assetNextCur};border:1.5px solid var(--ink);background:var(--panel);color:${v.assetNextFg};`)}>NEXT →</button>
        </div>
      </div>
    </>
  );
}
