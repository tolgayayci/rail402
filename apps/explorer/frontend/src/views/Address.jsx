import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function Address({ v }) {
  return (
    <>
      <div style={css(`padding:22px 2px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;`)}>
        <button onClick={v.goFeed} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:6px 12px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);`)}>← FEED</button>
        <span style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.04em;color:var(--mut);word-break:break-all;`)}>{v.addr}</span>
        <button onClick={v.copyAddr} title="copy address" style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;padding:3px 8px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);`)}>{v.copyLabel}</button>
        {v.addrIsContract ? <span style={css(`font-size:9px;font-weight:700;background:var(--ink);color:var(--panel);padding:2px 6px;font-family:'JetBrains Mono',monospace;`)}>SMART-CONTRACT WALLET</span> : null}
      </div>
      {v.addrHasService ? (
        <div style={css(`border:2px solid var(--ink);background:var(--panel);padding:16px 22px;margin-bottom:-2px;`)}>
          <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--acc);font-weight:700;`)}>BAZAAR-CATALOGED SERVICE</div>
          <div style={css(`font-size:22px;font-weight:700;margin-top:6px;`)}>{v.addrServiceName}</div>
          {v.addrHasResource ? <a href={v.addrResource} target="_blank" rel="noopener" style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;`)}>{v.addrResource} ↗</a> : null}
          {v.addrHasDesc ? <p style={css(`margin:8px 0 0;font-size:14px;color:var(--mut);max-width:80ch;`)}>{v.addrDesc}</p> : null}
        </div>
      ) : null}
      <div style={css(`border:2px solid var(--ink);background:var(--panel);`)}>
        <div style={css(`display:flex;border-bottom:2px solid var(--ink);`)}>
          <button onClick={v.pickSellerTab} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:12px 18px;cursor:pointer;border:none;border-right:1.5px solid var(--ink);background:${v.tabSellerBg};color:${v.tabSellerFg};`)}>AS SELLER · {v.addrSellerCntTxt}</button>
          <button onClick={v.pickBuyerTab} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:12px 18px;cursor:pointer;border:none;border-right:1.5px solid var(--ink);background:${v.tabBuyerBg};color:${v.tabBuyerFg};`)}>AS BUYER · {v.addrBuyerCntTxt}</button>
        </div>
        {v.addrShowSellerStats ? (
          <div style={css(`display:grid;grid-template-columns:repeat(5,1fr);border-bottom:2px solid var(--ink);`)}>
            <div style={css(`padding:14px 22px;border-right:1.5px solid var(--ink);`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>PAYMENTS RECEIVED</div>
              <div style={css(`font-size:26px;font-weight:700;margin-top:4px;`)}>{v.addrPayTxt}</div>
            </div>
            <div style={css(`padding:14px 22px;border-right:1.5px solid var(--ink);`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>UNIQUE BUYERS</div>
              <div style={css(`font-size:26px;font-weight:700;margin-top:4px;`)}>{v.addrBuyTxt}</div>
            </div>
            <div style={css(`padding:14px 22px;border-right:1.5px solid var(--ink);`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>EXACT / UPTO</div>
              <div style={css(`font-size:26px;font-weight:700;margin-top:4px;`)}>{v.addrSchemeTxt}</div>
            </div>
            <div style={css(`padding:14px 22px;border-right:1.5px solid var(--ink);`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>LAST PAID</div>
              <div style={css(`font-size:26px;font-weight:700;margin-top:4px;`)}>{v.addrLastTxt}</div>
            </div>
            <div style={css(`padding:14px 22px;`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>ACTIVE SINCE</div>
              <div style={css(`font-size:26px;font-weight:700;margin-top:4px;white-space:nowrap;`)}>{v.addrSinceTxt}</div>
            </div>
          </div>
        ) : null}
        <div style={css(`display:grid;grid-template-columns:64px 130px minmax(0,1fr) 100px 160px 150px;gap:16px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
          <span>AGE</span><span>TX</span><span>BUYER → SELLER</span><span>SCHEME</span><span>SETTLED BY</span><span style={css(`text-align:right;`)}>AMOUNT</span>
        </div>
        {v.addrLoading ? (
          <div style={css(`padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
        ) : null}
        {v.addrEmpty ? (
          <div style={css(`padding:30px 22px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--mut);`)}>NO PAYMENTS IN THIS ROLE</div>
        ) : null}
        {v.addrRows.map((r, i) => (
          <div key={i} style={css(`display:grid;grid-template-columns:64px 130px minmax(0,1fr) 100px 160px 150px;gap:16px;padding:11px 22px;border-bottom:1px solid var(--line);align-items:center;font-family:'JetBrains Mono',monospace;font-size:12px;`)}>
            <span style={css(`color:var(--mut);`)} data-tip={r.timeTitle}>{r.time}</span>
            <Hov tag="span" onClick={r.openTx} style={css(`cursor:pointer;text-decoration:underline;text-decoration-color:var(--acc);text-underline-offset:3px;`)} hover={css(`color:var(--acc);`)}>{r.hashShort}</Hov>
            <span style={css(`overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}><Hov tag="span" onClick={r.openBuyer} style={css(`cursor:pointer;`)} hover={css(`color:var(--acc);`)}>{r.buyerShort}</Hov><span style={css(`color:var(--acc);margin:0 7px;font-weight:700;`)}>→</span><Hov tag="span" onClick={r.openSeller} style={css(`cursor:pointer;`)} hover={css(`color:var(--acc);`)}>{r.sellerShort}</Hov></span>
            <span style={css(`font-size:10px;color:var(--mut);letter-spacing:.06em;`)}>{r.schemeTxt}</span>
            <span onClick={r.openFac} style={css(`cursor:${r.facCursor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}><span style={css(`font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;background:${r.confBg};color:${r.confFg};border:1.5px solid ${r.confBd};`)}>{r.settledTxt}</span></span>
            <span style={css(`text-align:right;font-weight:700;`)}>{r.amtTxt} <span style={css(`font-weight:400;color:var(--mut);font-size:10px;`)}>{r.asset}</span></span>
          </div>
        ))}
        {v.addrMore ? (
          <button onClick={v.loadMoreAddr} style={css(`width:100%;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.16em;background:var(--ink);color:var(--panel);border:none;padding:14px;cursor:pointer;`)}>LOAD MORE ↓</button>
        ) : null}
      </div>
    </>
  );
}
