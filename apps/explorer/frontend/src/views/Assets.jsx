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
      <div style={css(`border:2px solid var(--ink);background:var(--panel);`)}>
        <div style={css(`display:grid;grid-template-columns:repeat(3,1fr);border-bottom:2px solid var(--ink);`)}>
          <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>DISTINCT ASSETS</div>
            <div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.assetsKpiCountTxt}</div>
          </div>
          <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>TOP ASSET</div>
            <div style={css(`font-size:30px;font-weight:700;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`)}>{v.assetsKpiTopTxt}</div>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);margin-top:3px;`)}>{v.assetsKpiTopSub}</div>
          </div>
          <div style={css(`padding:16px 22px;`)}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>SETTLED IN LAST 30 DAYS</div>
            <div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.assetsKpiActiveTxt}</div>
          </div>
        </div>
        <div style={css(`display:flex;justify-content:flex-end;gap:8px;padding:12px 22px;border-bottom:1.5px solid var(--ink);flex-wrap:wrap;`)}>
          {v.assetsWinTabs.map((t, i) => (
            <button key={i} onClick={t.pick} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;background:${t.bg};color:${t.fg};border:1.5px solid var(--ink);`)}>{t.label}</button>
          ))}
        </div>
        <div style={css(`display:grid;grid-template-columns:40px minmax(150px,0.8fr) minmax(140px,0.7fr) 150px 120px 100px 120px;gap:14px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
          <span>RANK</span><span>ASSET</span><span>CONTRACT</span><span>SHARE OF PAYMENTS</span><span>LAST 30 DAYS</span><span style={css(`text-align:right;`)}>PAYMENTS</span><span style={css(`text-align:right;`)}>VOLUME</span>
        </div>
        {v.assetsWinLoading ? (
          <div style={css('padding:44px 22px;display:flex;justify-content:center;align-items:center;')}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
        ) : null}
        {v.assetRows.map((a, i) => (
          <Hov key={i} tag="div" onClick={a.open} title="open this asset's detail page" style={css(`display:grid;grid-template-columns:40px minmax(150px,0.8fr) minmax(140px,0.7fr) 150px 120px 100px 120px;gap:14px;padding:12px 22px;border-bottom:1px solid var(--line);align-items:center;font-family:'JetBrains Mono',monospace;font-size:12px;cursor:pointer;`)} hover={css('background:var(--head);')}>
            <span style={css(`font-weight:700;color:var(--mut);`)}>{a.rank}</span>
            <span style={css('min-width:0;')}>
              <span style={css(`display:flex;align-items:center;gap:8px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{a.hasIcon ? <img src={a.iconUrl} alt={a.code} style={css(`width:17px;height:17px;border-radius:50%;object-fit:cover;flex:none;`)} /> : null}{a.noIcon ? <span style={css('width:17px;height:17px;flex:none;border-radius:50%;background:var(--stripe);border:1px solid var(--line);')}></span> : null}<span style={css('overflow:hidden;text-overflow:ellipsis;')}>{a.code}</span>{a.unnamed ? <span title="this token has not published an asset code on chain" style={css('flex:none;font-size:8px;font-weight:700;letter-spacing:.08em;padding:2px 5px;border:1px solid var(--line);color:var(--mut);')}>UNNAMED</span> : null}</span>
            </span>
            <span style={css(`display:flex;align-items:center;gap:7px;min-width:0;`)}>
              <Hov tag="a" href={a.expertUrl} target="_blank" rel="noopener" onClick={a.stopProp} title="open on stellar.expert" style={css(`color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:underline;text-decoration-color:var(--acc);text-underline-offset:3px;`)} hover={css(`color:var(--acc);`)}>{a.contractShort}</Hov>
              <Hov tag="button" onClick={a.copyContract} title="copy contract address" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--mut);flex:none;`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>⧉</Hov>
            </span>
            <span style={css(`display:flex;align-items:center;gap:8px;`)}><span style={css(`flex:1;height:8px;border:1px solid var(--ink);background:var(--bg);`)}><span style={css(`display:block;height:100%;background:var(--acc);width:${a.sharePct};`)}></span></span><span style={css(`font-size:10px;color:var(--mut);`)}>{a.sharePct}</span></span>
            <span title="daily payments in this asset, trailing 30 days" style={css('display:flex;align-items:flex-end;gap:1px;height:22px;')}>
              {a.spark.map((sp, j) => (
                <span key={j} style={css(`flex:1;min-width:1px;height:${sp.h};background:${sp.bg};`)}></span>
              ))}
            </span>
            <span style={css(`text-align:right;font-weight:700;`)}>{a.countTxt}</span>
            <span style={css(`text-align:right;`)}>{a.volTxt}</span>
          </Hov>
        ))}
        <div style={css(`display:flex;justify-content:space-between;align-items:center;padding:12px 22px;border-top:1.5px solid var(--ink);`)}>
          <button onClick={v.assetPrev} disabled={v.assetPrevDisabled} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:7px 14px;cursor:${v.assetPrevCur};border:1.5px solid var(--ink);background:var(--panel);color:${v.assetPrevFg};`)}>← PREV</button>
          <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.12em;color:var(--mut);`)}>{v.assetPageTxt}</span>
          <button onClick={v.assetNext} disabled={v.assetNextDisabled} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:7px 14px;cursor:${v.assetNextCur};border:1.5px solid var(--ink);background:var(--panel);color:${v.assetNextFg};`)}>NEXT →</button>
        </div>
      </div>
      <div style={css(`padding:14px 4px;font-size:13px;line-height:1.5;color:var(--mut);`)}>Each volume is shown in that asset's own unit and is never summed across tokens. Click a row for that asset's full detail.</div>
    </>
  );
}
