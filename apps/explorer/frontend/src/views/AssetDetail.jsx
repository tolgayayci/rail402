import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function AssetDetail({ v }) {
  return (
    <>
      <div style={css('padding:22px 2px 14px;')}>
        <button onClick={v.goAssets} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:6px 12px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);`)}>← ALL ASSETS</button>
      </div>
      {v.adLoading ? (
        <div style={css(`padding:44px 22px;border:2px solid var(--ink);background:var(--panel);min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
      ) : null}
      {v.adErr ? (
        <div style={css(`border:2px solid var(--ink);background:var(--panel);padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:10px;text-align:center;`)}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--acc)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>
          <div style={css(`font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;letter-spacing:.08em;color:var(--acc);`)}>{v.adErrCode}</div>
          <div style={css(`font-size:16px;font-weight:600;max-width:60ch;`)}>{v.adErrReason}</div>
          <button onClick={v.retryAsset} style={css(`margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:8px 16px;cursor:pointer;border:1.5px solid var(--ink);background:var(--ink);color:var(--panel);`)}>RETRY</button>
        </div>
      ) : null}
      {v.adReady ? (
        <div style={css(`border:2px solid var(--ink);background:var(--panel);`)}>
          <div style={css(`display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:2px solid var(--ink);flex-wrap:wrap;gap:12px;`)}>
            <div style={css(`display:flex;align-items:center;gap:12px;min-width:0;`)}>
              {v.adHasIcon ? <img src={v.adIcon} alt={v.adCode} style={css(`width:28px;height:28px;border-radius:50%;object-fit:cover;flex:none;`)} /> : null}
              {v.adNoIcon ? <span style={css('width:28px;height:28px;flex:none;border-radius:50%;background:var(--stripe);border:1px solid var(--line);')}></span> : null}
              <span style={css('font-size:26px;font-weight:700;')}>{v.adCode}</span>
              {v.adUnnamed ? <span title="this token has not published an asset code on chain" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.08em;padding:2px 6px;border:1px solid var(--line);color:var(--mut);`)}>UNNAMED</span> : null}
            </div>
            <div style={css(`display:flex;align-items:center;gap:8px;flex-wrap:wrap;`)}>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mut);word-break:break-all;`)}>{v.adContract}</span>
              <button onClick={v.adCopy} title="copy contract address" style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;padding:3px 8px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);`)}>{v.copyLabel}</button>
              <a href={v.adExpert} target="_blank" rel="noopener" style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;`)}>STELLAR.EXPERT ↗</a>
              <button onClick={v.adEco} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;padding:6px 12px;cursor:pointer;border:1.5px solid var(--acc);background:var(--acc);color:var(--onacc);`)}>VIEW IN ECOSYSTEM →</button>
            </div>
          </div>
          <div style={css(`display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-bottom:2px solid var(--ink);`)}>
            <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>PAYMENTS</div><div style={css('font-size:28px;font-weight:700;margin-top:4px;')}>{v.adPayTxt}</div></div>
            <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>VOLUME</div><div style={css('font-size:28px;font-weight:700;margin-top:4px;white-space:nowrap;')}>{v.adVolTxt}</div><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);margin-top:3px;`)}>{v.adVolCode}</div></div>
            <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>BUYERS</div><div style={css('font-size:28px;font-weight:700;margin-top:4px;')}>{v.adBuyTxt}</div></div>
            <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>SELLERS</div><div style={css('font-size:28px;font-weight:700;margin-top:4px;')}>{v.adSellTxt}</div></div>
            <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>FIRST PAYMENT</div><div style={css('font-size:28px;font-weight:700;margin-top:4px;white-space:nowrap;')}>{v.adSinceTxt}</div></div>
            <div style={css('padding:16px 20px;')}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>LAST PAYMENT</div><div style={css('font-size:28px;font-weight:700;margin-top:4px;white-space:nowrap;')}>{v.adLastTxt}</div></div>
          </div>
          <div style={css(`display:grid;grid-template-columns:52px 1fr 1fr 1fr 1fr;gap:12px;padding:10px 22px;border-bottom:1px solid var(--line);font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;color:var(--mut);`)}>
            <span></span><span style={css('text-align:right;')}>PAYMENTS</span><span style={css('text-align:right;')}>VOLUME</span><span style={css('text-align:right;')}>BUYERS</span><span style={css('text-align:right;')}>SELLERS</span>
          </div>
          {v.adWindows.map((w, i) => (
            <Hov key={i} tag="div" style={css(`display:grid;grid-template-columns:52px 1fr 1fr 1fr 1fr;gap:12px;padding:11px 22px;border-bottom:1px solid var(--line);font-family:'JetBrains Mono',monospace;font-size:12px;align-items:center;`)} hover={css('background:var(--head);')}>
              <span style={css('font-weight:700;color:var(--acc);')}>{w.k}</span>
              <span style={css('text-align:right;font-weight:700;')}>{w.pay}</span>
              <span style={css('text-align:right;white-space:nowrap;')}>{w.vol}</span>
              <span style={css('text-align:right;')}>{w.buyers}</span>
              <span style={css('text-align:right;')}>{w.sellers}</span>
            </Hov>
          ))}
          <div style={css(`display:grid;grid-template-columns:64px 130px minmax(0,1fr) 100px 160px 150px;gap:16px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
            <span>AGE</span><span>TX</span><span>BUYER → SELLER</span><span>SCHEME</span><span>SETTLED BY</span><span style={css('text-align:right;')}>AMOUNT</span>
          </div>
          {v.adRows.map((r, i) => (
            <Hov key={i} tag="div" onClick={r.openTx} style={css(`display:grid;grid-template-columns:64px 130px minmax(0,1fr) 100px 160px 150px;gap:16px;padding:11px 22px;border-bottom:1px solid var(--line);align-items:center;font-family:'JetBrains Mono',monospace;font-size:12px;cursor:pointer;`)} hover={css('background:var(--head);')}>
              <span style={css('color:var(--mut);')} data-tip={r.timeTitle}>{r.time}</span>
              <span style={css('display:flex;align-items:center;gap:6px;')}><Hov tag="span" onClick={r.openTx} style={css('cursor:pointer;text-decoration:underline;text-decoration-color:var(--acc);text-underline-offset:3px;')} hover={css('color:var(--acc);')}>{r.hashShort}</Hov><Hov tag="button" onClick={r.copyHash} title="copy tx hash" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;padding:1px 5px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--mut);`)} hover={css('color:var(--ink);border-color:var(--ink);')}>⧉</Hov></span>
              <span style={css('overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}><Hov tag="span" onClick={r.openBuyer} style={css('cursor:pointer;')} hover={css('color:var(--acc);')}>{r.buyerShort}</Hov><span style={css('color:var(--acc);margin:0 7px;font-weight:700;')}>→</span><Hov tag="span" onClick={r.openSeller} title={r.sellerTitle} style={css('cursor:pointer;')} hover={css('color:var(--acc);')}>{r.sellerLabel}</Hov></span>
              <span style={css('font-size:10px;color:var(--mut);letter-spacing:.06em;')}>{r.schemeTxt}</span>
              <span onClick={r.openFac} style={css(`cursor:${r.facCursor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}><span style={css(`font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;background:${r.confBg};color:${r.confFg};border:1.5px solid ${r.confBd};`)}>{r.settledTxt}</span></span>
              <span style={css('text-align:right;font-weight:700;')}>{r.amtTxt} <span style={css('font-weight:400;color:var(--mut);font-size:10px;')}>{r.asset}</span></span>
            </Hov>
          ))}
          {v.adMore ? (
            <button onClick={v.loadMoreAsset} style={css(`width:100%;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.16em;background:var(--ink);color:var(--panel);border:none;padding:14px;cursor:pointer;`)}>LOAD MORE ↓</button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
