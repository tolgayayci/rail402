import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function Facilitators({ v }) {
  return (
    <>
      <div style={css(`padding:22px 2px 18px;`)}>
        <h1 style={css(`margin:0;font-size:24px;font-weight:600;`)}>Facilitators</h1>
        <p style={css(`margin:8px 0 0;font-size:15px;line-height:1.5;color:var(--mut);`)}>The services that settle x402 traffic on Stellar.</p>
      </div>
      <div style={css(`display:grid;grid-template-columns:256px repeat(3,1fr);border:2px solid var(--ink);background:var(--panel);`)}>
        <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
          <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>REGISTERED</div>
          <div style={css(`font-size:32px;font-weight:700;margin-top:4px;`)}>{v.facCountTxt}</div>
        </div>
        <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
          <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>VERIFIED</div>
          <div style={css(`font-size:32px;font-weight:700;margin-top:4px;`)}>{v.facVerCountTxt}</div>
        </div>
        <div style={css(`padding:16px 22px;border-right:1.5px solid var(--ink);`)}>
          <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>ATTRIBUTED PAYMENTS</div>
          <div style={css(`font-size:32px;font-weight:700;margin-top:4px;`)}>{v.facAttrTxt}</div>
        </div>
        <div style={css(`padding:16px 22px;`)}>
          <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>UNATTRIBUTED TRAFFIC</div>
          <div style={css(`font-size:32px;font-weight:700;margin-top:4px;`)}>{v.facUnknownTxt} <span style={css(`font-size:14px;color:var(--mut);font-weight:400;`)}>({v.pctShaped})</span></div>
        </div>
      </div>
      <div style={css(`display:grid;grid-template-columns:256px minmax(0,1fr);border:2px solid var(--ink);border-top:none;background:var(--panel);`)}>
        <div style={css(`padding:22px;border-right:1.5px solid var(--ink);display:flex;flex-direction:column;align-items:center;gap:16px;`)}>
          <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);align-self:flex-start;`)}>MARKET SHARE (BY PAYMENTS)</div>
          <div style={css(`position:relative;width:180px;height:180px;`)}>
            <svg width="180" height="180" viewBox="0 0 180 180" style={css(`transform:rotate(-90deg);display:block;`)}>
              <circle cx="90" cy="90" r="60" fill="none" stroke="var(--line)" strokeWidth="42"></circle>
              {v.donutSlices.map((s, i) => (
                <circle key={i} onMouseEnter={s.enter} onMouseLeave={s.leave} cx="90" cy="90" r="60" fill="none" stroke={s.color} strokeWidth="42" strokeDasharray={s.dash} strokeDashoffset={s.off}></circle>
              ))}
            </svg>
            {v.donutIdleOn ? (
              <div style={css(`position:absolute;inset:52px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;pointer-events:none;`)}>
                <span style={css(`font-size:19px;font-weight:700;letter-spacing:-.02em;`)}>{v.donutTotalTxt}</span>
                <span style={css(`font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:.12em;color:var(--mut);`)}>PAYMENTS</span>
              </div>
            ) : null}
            {v.donutHoverOn ? (
              <div style={css(`position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:5;pointer-events:none;border:1.5px solid var(--ink);background:var(--panel);padding:8px 11px;font-family:'JetBrains Mono',monospace;white-space:nowrap;text-align:center;`)}>
                <div style={css(`display:flex;align-items:center;gap:6px;justify-content:center;`)}><span style={css(`width:8px;height:8px;background:${v.dhColor};border:1px solid var(--ink);flex:none;`)}></span><span style={css(`font-size:10px;font-weight:700;letter-spacing:.06em;`)}>{v.dhName}</span></div>
                <div style={css(`font-size:13px;font-weight:700;margin-top:4px;`)}>{v.dhCount}</div>
                <div style={css(`font-size:9px;color:var(--mut);margin-top:2px;letter-spacing:.06em;`)}>{v.dhPct} OF ALL PAYMENTS</div>
              </div>
            ) : null}
          </div>
          <div style={css(`display:flex;flex-direction:column;gap:6px;align-self:stretch;`)}>
            {v.shareLegend.map((s, i) => (
              <div key={i} style={css(`display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.04em;`)}>
                <span style={css(`width:10px;height:10px;background:${s.color};border:1px solid var(--ink);`)}></span>
                <span style={css(`flex:1;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{s.name}</span>
                <span style={css(`color:var(--mut);`)}>{s.pctTxt}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={css(`overflow-x:auto;`)}>
          <div style={css(`display:grid;grid-template-columns:32px minmax(190px,0.9fr) 130px 90px 64px 72px 110px 90px;gap:16px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
            <span>RANK</span><span>FACILITATOR</span><span>SHARE</span>
            <Hov tag="span" onClick={v.facHdrPay.pick} style={css(`text-align:right;cursor:pointer;color:${v.facHdrPay.fg};`)} hover={css(`color:var(--ink);`)}>{v.facHdrPay.label}</Hov>
            <span style={css(`text-align:right;`)}>30D</span>
            <Hov tag="span" onClick={v.facHdrBuy.pick} style={css(`text-align:right;cursor:pointer;color:${v.facHdrBuy.fg};`)} hover={css(`color:var(--ink);`)}>{v.facHdrBuy.label}</Hov>
            <span style={css(`text-align:right;`)}>TOP VOLUME</span>
            <Hov tag="span" onClick={v.facHdrLast.pick} style={css(`text-align:right;cursor:pointer;color:${v.facHdrLast.fg};`)} hover={css(`color:var(--ink);`)}>{v.facHdrLast.label}</Hov>
          </div>
          {v.facsLoading ? (
            <div style={css(`padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
          ) : null}
          {v.facs.map((f, i) => (
            <Hov key={i} tag="div" onClick={f.open} style={css(`display:grid;grid-template-columns:32px minmax(190px,0.9fr) 130px 90px 64px 72px 110px 90px;gap:16px;padding:13px 22px;border-bottom:1px solid var(--line);align-items:center;cursor:${f.cursor};`)} hover={css(`background:var(--head);`)}>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:var(--mut);`)}>{f.rank}</span>
              <span style={css(`min-width:0;`)}>
                {f.showBadges ? (
                  <span style={css(`display:flex;gap:5px;margin-bottom:4px;`)}>
                    <span style={css(`font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:700;letter-spacing:.06em;padding:2px 5px;background:#2FA36B;color:#FFFFFF;`)}>EXACT ✓</span>
                    <span style={css(`font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:700;letter-spacing:.06em;padding:2px 5px;background:${f.uptoBg};color:#FFFFFF;`)}>{f.uptoTxt}</span>
                  </span>
                ) : null}
                <span style={css(`font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:8px;`)}><span style={css(`width:9px;height:9px;background:${f.color};border:1px solid var(--ink);flex:none;`)}></span>{f.name}</span>
                <span style={css(`display:block;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.08em;color:var(--mut);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`)}>{f.chips}</span>
              </span>
              <span style={css(`display:flex;align-items:center;gap:8px;`)}><span style={css(`flex:1;height:8px;border:1px solid var(--ink);background:var(--bg);`)}><span style={css(`display:block;height:100%;background:${f.color};width:${f.sharePct};`)}></span></span><span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--mut);`)}>{f.sharePct}</span></span>
              <span style={css(`text-align:right;font-family:'JetBrains Mono',monospace;font-weight:700;`)}>{f.payTxt}</span>
              <span title="payments in the trailing 30 days" style={css(`text-align:right;font-family:'JetBrains Mono',monospace;color:var(--mut);`)}>{f.w30Txt}</span>
              <span style={css(`text-align:right;font-family:'JetBrains Mono',monospace;color:var(--mut);`)}>{f.buyTxt}</span>
              <span title="volume of the facilitator's most-used asset, in its own unit" style={css(`text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;white-space:nowrap;`)}>{f.volTxt}</span>
              <span style={css(`text-align:right;font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--mut);`)}>{f.lastTxt}</span>
            </Hov>
          ))}
        </div>
      </div>
      <div style={css(`padding:14px 4px;font-size:13px;line-height:1.5;color:var(--mut);`)}>Market share covers every indexed payment. Traffic no registered facilitator claims is counted as the unknown slice.</div>
    </>
  );
}
