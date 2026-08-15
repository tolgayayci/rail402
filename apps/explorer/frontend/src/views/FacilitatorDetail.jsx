import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

/** Row link span: the template's repeated `style-hover="color:var(--acc);"` shorthand. */
function Hovv({ children, ...rest }) {
  return <Hov tag="span" hover={css(`color:var(--acc);`)} {...rest}>{children}</Hov>;
}

export default function FacilitatorDetail({ v }) {
  return (
    <>
      <div style={css(`padding:22px 2px 14px;`)}>
        <button onClick={v.goFacs} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:6px 12px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);`)}>← ALL FACILITATORS</button>
      </div>
      {v.facLoading ? (
        <div style={css(`padding:44px 22px;border:2px solid var(--ink);background:var(--panel);min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
      ) : null}
      {v.facReady ? (
        <div style={css(`border:2px solid var(--ink);background:var(--panel);`)}>
          <div style={css(`display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:2px solid var(--ink);flex-wrap:wrap;gap:12px;`)}>
            <div style={css(`display:flex;align-items:center;gap:14px;`)}>
              <span style={css(`font-size:26px;font-weight:700;`)}>{v.facName}</span>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;background:${v.facVBg};color:${v.facVFg};border:1.5px solid var(--ink);`)}>{v.facVTxt}</span>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--mut);letter-spacing:.08em;`)}>SOURCE: {v.facSource}</span>
            </div>
            <a href={v.facUrl} target="_blank" rel="noopener" style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;`)}>{v.facUrlTxt} ↗</a>
          </div>
          <div style={css(`display:grid;grid-template-columns:repeat(5,1fr);border-bottom:2px solid var(--ink);`)}>
            <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>PAYMENTS</div>
              <div style={css(`font-size:28px;font-weight:700;margin-top:4px;`)}>{v.facPayTxt}</div>
            </div>
            <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>EXACT / UPTO</div>
              <div style={css(`font-size:28px;font-weight:700;margin-top:4px;`)}>{v.facSchemeTxt}</div>
            </div>
            <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>BUYERS</div>
              <div style={css(`font-size:28px;font-weight:700;margin-top:4px;`)}>{v.facBuyTxt}</div>
            </div>
            <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>SELLERS</div>
              <div style={css(`font-size:28px;font-weight:700;margin-top:4px;`)}>{v.facSellTxt}</div>
            </div>
            <div style={css(`padding:16px 22px;`)}>
              <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>LAST SEEN</div>
              <div style={css(`font-size:28px;font-weight:700;margin-top:4px;`)}>{v.facLastTxt}</div>
            </div>
          </div>
          <div style={css(`padding:14px 22px;border-bottom:2px solid var(--ink);display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;`)}>
            <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>SIGNERS →</span>
            {v.facSigners.map((s, i) => (
              <span key={i} title={s.full} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;border:1px solid var(--line);padding:3px 8px;`)}>{s.short}</span>
            ))}
            {v.facHasUpto ? (
              <>
                <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);margin-left:10px;`)}>UPTO CONTRACTS →</span>
                {v.facUpto.map((s, i) => (
                  <span key={i} title={s.full} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;border:1px solid var(--line);padding:3px 8px;color:var(--acc);`)}>{s.short}</span>
                ))}
              </>
            ) : null}
          </div>
          <div style={css(`display:grid;grid-template-columns:64px 130px minmax(0,1fr) 90px 150px;gap:16px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
            <span>AGE</span><span>TX</span><span>BUYER → SELLER</span><span>SCHEME</span><span style={css(`text-align:right;`)}>AMOUNT</span>
          </div>
          {v.facRows.map((r, i) => (
            <div key={i} style={css(`display:grid;grid-template-columns:64px 130px minmax(0,1fr) 90px 150px;gap:16px;padding:11px 22px;border-bottom:1px solid var(--line);align-items:center;font-family:'JetBrains Mono',monospace;font-size:12px;`)}>
              <span style={css(`color:var(--mut);`)} data-tip={r.timeTitle}>{r.time}</span>
              <Hovv onClick={r.openTx} style={css(`cursor:pointer;text-decoration:underline;text-decoration-color:var(--acc);text-underline-offset:3px;`)}>{r.hashShort}</Hovv>
              <span style={css(`overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}><Hovv onClick={r.openBuyer} style={css(`cursor:pointer;`)}>{r.buyerShort}</Hovv><span style={css(`color:var(--acc);margin:0 7px;font-weight:700;`)}>→</span><Hovv onClick={r.openSeller} style={css(`cursor:pointer;`)}>{r.sellerShort}</Hovv></span>
              <span style={css(`font-size:10px;color:var(--mut);letter-spacing:.06em;`)}>{r.schemeTxt}</span>
              <span style={css(`text-align:right;font-weight:700;`)}>{r.amtTxt} <span style={css(`font-weight:400;color:var(--mut);font-size:10px;`)}>{r.asset}</span></span>
            </div>
          ))}
          {v.facMore ? (
            <button onClick={v.loadMoreFac} style={css(`width:100%;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.16em;background:var(--ink);color:var(--panel);border:none;padding:14px;cursor:pointer;`)}>LOAD MORE ↓</button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
