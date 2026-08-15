import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function Sellers({ v }) {
  return (
    <>
      <div style={css(`padding:22px 2px 18px;`)}>
        <h1 style={css(`margin:0;font-size:24px;font-weight:600;`)}>Sellers</h1>
        <p style={css(`margin:8px 0 0;font-size:15px;line-height:1.5;color:var(--mut);`)}>Every API being paid via x402, ranked by activity.</p>
      </div>
      <div style={css(`border:2px solid var(--ink);background:var(--panel);overflow-x:auto;`)}>
        <div style={css(`display:grid;grid-template-columns:44px minmax(180px,1.4fr) 110px minmax(0,1fr) 100px 90px 130px 100px;gap:14px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
          <span>RANK</span><span>SELLER</span><span>REGISTERED</span><span>ADDRESS</span><span style={css(`text-align:right;`)}>PAYMENTS</span><span style={css(`text-align:right;`)}>BUYERS</span><span style={css(`text-align:right;`)}>VOLUME</span><span style={css(`text-align:right;`)}>LAST SEEN</span>
        </div>
        {v.sellersLoading ? (
          <div style={css(`padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
        ) : null}
        {v.sellerRows.map((s, i) => (
          <Hov key={i} tag="div" onClick={s.open} style={css(`display:grid;grid-template-columns:44px minmax(180px,1.4fr) 110px minmax(0,1fr) 100px 90px 130px 100px;gap:14px;padding:13px 22px;border-bottom:1px solid var(--line);align-items:center;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:12px;`)} hover={css(`background:var(--head);`)}>
            <span style={css(`font-weight:700;color:var(--mut);`)}>{s.rank}</span>
            <span style={css(`font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${s.nameFg};`)}>{s.name}</span>
            <span><span style={css(`font-size:9px;font-weight:700;letter-spacing:.08em;padding:2px 7px;background:${s.regBg};color:${s.regFg};border:1.5px solid ${s.regBd};`)}>{s.regTxt}</span></span>
            <span style={css(`color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{s.addrShort}</span>
            <span style={css(`text-align:right;font-weight:700;`)}>{s.payTxt}</span>
            <span style={css(`text-align:right;color:var(--mut);`)}>{s.buyTxt}</span>
            <span style={css(`text-align:right;font-weight:700;`)}>{s.volTxt} <span style={css(`font-weight:400;color:var(--mut);font-size:10px;`)}>{s.volCode}</span></span>
            <span style={css(`text-align:right;font-size:11px;color:var(--mut);`)}>{s.lastTxt}</span>
          </Hov>
        ))}
        <div style={css(`display:flex;justify-content:space-between;align-items:center;padding:12px 22px;border-top:1.5px solid var(--ink);`)}>
          <button onClick={v.sellersPrev} disabled={v.sellersPrevDisabled} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:7px 14px;cursor:${v.sellersPrevCur};border:1.5px solid var(--ink);background:var(--panel);color:${v.sellersPrevFg};`)}>← PREV</button>
          <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.12em;color:var(--mut);`)}>{v.sellersPageTxt}</span>
          <button onClick={v.sellersNext} disabled={v.sellersNextDisabled} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:7px 14px;cursor:${v.sellersNextCur};border:1.5px solid var(--ink);background:var(--panel);color:${v.sellersNextFg};`)}>NEXT →</button>
        </div>
      </div>
      <div style={css(`padding:14px 4px;font-size:13px;line-height:1.5;color:var(--mut);`)}>Named sellers come from the Bazaar registry; unnamed ones are seen on-chain only.</div>
    </>
  );
}
