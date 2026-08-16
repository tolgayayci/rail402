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
      <div style={css(`border:2px solid var(--ink);background:var(--panel);`)}>
        <div style={css(`display:grid;grid-template-columns:repeat(3,1fr);border-bottom:2px solid var(--ink);`)}>
          <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>TOTAL SELLERS</div>
            <div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.sellersKpiTotalTxt}</div>
          </div>
          <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>BAZAAR REGISTERED</div>
            <div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.sellersKpiBazaarTxt}</div>
          </div>
          <div style={css(`padding:16px 22px;`)}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>ACTIVE LAST 7 DAYS</div>
            <div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.sellersKpi7dTxt}</div>
          </div>
        </div>
        <div style={css(`display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 22px;border-bottom:1.5px solid var(--ink);flex-wrap:wrap;`)}>
          <div style={css(`display:flex;gap:8px;`)}>
            {v.sellersRegTabs.map((t, i) => (
              <button key={i} onClick={t.pick} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;background:${t.bg};color:${t.fg};border:1.5px solid var(--ink);`)}>{t.label}</button>
            ))}
          </div>
          <div style={css(`display:flex;gap:8px;`)}>
            {v.sellersWinTabs.map((t, i) => (
              <button key={i} onClick={t.pick} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;background:${t.bg};color:${t.fg};border:1.5px solid var(--ink);`)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div style={css(`display:grid;grid-template-columns:44px minmax(200px,1.5fr) 110px 100px 90px 130px 100px;gap:14px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
          <span>RANK</span><span>SELLER</span><span>REGISTERED</span><span style={css(`text-align:right;`)}>PAYMENTS</span><span style={css(`text-align:right;`)}>BUYERS</span><span style={css(`text-align:right;`)}>VOLUME</span><span style={css(`text-align:right;`)}>LAST SEEN</span>
        </div>
        {v.sellersErr ? (
          <div style={css('padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:10px;text-align:center;')}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--acc)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>
            <div style={css('font-size:16px;font-weight:600;')}>Could not load data</div>
            <div style={css('font-size:13px;line-height:1.5;color:var(--mut);max-width:52ch;')}>The explorer API did not respond. The network may be slow or the service briefly unavailable.</div>
            <button onClick={v.retrySellers} style={css(`margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:8px 16px;cursor:pointer;border:1.5px solid var(--ink);background:var(--ink);color:var(--panel);`)}>RETRY</button>
          </div>
        ) : null}
        {v.sellersEmpty ? (
          <div style={css('padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:10px;text-align:center;')}><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--mut)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path></svg><div style={css('font-size:16px;font-weight:600;')}>No sellers in this view</div><div style={css('font-size:13px;line-height:1.5;color:var(--mut);max-width:52ch;')}>No sellers match these filters in the selected window. Try a wider window or clear the filter.</div></div>
        ) : null}
        {v.sellersLoading ? (
          <div style={css(`padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
        ) : null}
        {v.sellerRows.map((s, i) => (
          <Hov key={i} tag="div" onClick={s.open} title={s.desc} style={css(`display:grid;grid-template-columns:44px minmax(200px,1.5fr) 110px 100px 90px 130px 100px;gap:14px;padding:13px 22px;border-bottom:1px solid var(--line);align-items:center;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:12px;`)} hover={css(`background:var(--head);`)}>
            <span style={css(`font-weight:700;color:var(--mut);`)}>{s.rank}</span>
            <span style={css('min-width:0;')}>
              <span style={css(`display:block;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${s.nameFg};`)}>{s.name}</span>
              <span style={css(`display:block;font-size:9px;letter-spacing:.06em;color:var(--mut);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`)}>{s.sub}</span>
            </span>
            <span><span style={css(`font-size:9px;font-weight:700;letter-spacing:.08em;padding:2px 7px;background:${s.regBg};color:${s.regFg};border:1.5px solid ${s.regBd};`)}>{s.regTxt}</span></span>
            <span style={css(`text-align:right;font-weight:700;`)}>{s.payTxt}</span>
            <span style={css(`text-align:right;color:var(--mut);`)}>{s.buyTxt}</span>
            <span style={css(`text-align:right;font-weight:700;display:flex;align-items:center;justify-content:flex-end;gap:6px;`)}>{s.volHasIcon ? <img src={s.volIcon} alt={s.volCode} style={css('width:15px;height:15px;border-radius:50%;object-fit:cover;flex:none;')} /> : null}{s.volTxt} <span style={css(`font-weight:400;color:var(--mut);font-size:10px;`)}>{s.volCode}</span></span>
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
