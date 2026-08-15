import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function Feed({ v }) {
  return (
    <>
      <div style={css('padding:22px 2px 18px;')}>
        <h1 style={css('margin:0;font-size:24px;font-weight:600;letter-spacing:-.01em;')}>The public record of x402 payments on Stellar.</h1>
        <p style={css('margin:8px 0 0;font-size:15px;line-height:1.5;color:var(--mut);')}>Every payment, live from the ledger. Who paid, who got paid, who settled it.</p>
      </div>
      <div style={css('border:2px solid var(--ink);background:var(--panel);')}>
        <div style={css('display:grid;grid-template-columns:repeat(4,1fr);border-bottom:2px solid var(--ink);')}>
          <div style={css('padding:18px 22px;border-right:1.5px solid var(--ink);')}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>PAYMENTS INDEXED</div>
            <div style={css('font-size:36px;font-weight:700;letter-spacing:-.02em;margin-top:4px;')}>{v.totalTxt}</div>
          </div>
          <div style={css('padding:18px 22px;border-right:1.5px solid var(--ink);')}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>{v.topAssetKpiLabel}</div>
            <div style={css('font-size:36px;font-weight:700;letter-spacing:-.02em;margin-top:4px;display:flex;align-items:center;gap:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;')}>{v.topAssetKpiHasIcon ? <img src={v.topAssetKpiIcon} alt="" style={css('width:24px;height:24px;border-radius:50%;object-fit:cover;flex:none;')} /> : null}{v.usdcVolTxt} <span style={css('font-size:13px;color:var(--mut);font-weight:400;')}>{v.topAssetKpiCode}</span></div>
          </div>
          <div style={css('padding:18px 22px;border-right:1.5px solid var(--ink);')}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>BUYERS</div>
            <div style={css('font-size:36px;font-weight:700;letter-spacing:-.02em;margin-top:4px;')}>{v.buyersTxt}</div>
          </div>
          <div style={css('padding:18px 22px;')}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>SELLERS</div>
            <div style={css('font-size:36px;font-weight:700;letter-spacing:-.02em;margin-top:4px;')}>{v.sellersTxt}</div>
          </div>
        </div>
        <div style={css('display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1fr);border-bottom:2px solid var(--ink);')}>
          <div style={css('padding:14px 22px;border-right:1.5px solid var(--ink);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;')}>
            <div style={css('display:flex;gap:12px;flex-wrap:wrap;align-items:center;')}>
              {v.filterDds.map((dd, i) => (
                <div key={i} style={css('position:relative;')}>
                  <div style={css('display:inline-flex;border:1.5px solid var(--ink);')}>
                    <span style={css(`display:inline-flex;align-items:center;padding:0 11px;height:34px;box-sizing:border-box;background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;border-right:1.5px solid var(--ink);`)}>{dd.label}</span>
                    <button onClick={dd.toggle} style={css(`display:inline-flex;align-items:center;gap:7px;height:34px;box-sizing:border-box;padding:0 11px;cursor:pointer;border:none;background:var(--panel);color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.04em;line-height:1;`)}><span>{dd.valueLabel}</span><span style={css('font-size:9px;font-weight:400;color:var(--mut);')}>{dd.valueCountTxt}</span><span style={css('font-size:8px;color:var(--mut);')}>▼</span></button>
                  </div>
                  {dd.open ? (
                    <div style={css('position:absolute;top:38px;left:0;min-width:100%;border:1.5px solid var(--ink);background:var(--panel);z-index:60;')}>
                      {dd.options.map((o, j) => (
                        <Hov key={j} tag="div" onClick={o.pick} style={css(`display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 12px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.04em;cursor:pointer;background:${o.bg};color:${o.fg};white-space:nowrap;`)} hover={css('background:var(--acc);color:var(--onacc);')}><span>{o.label}</span><span style={css('font-size:9px;font-weight:400;opacity:.6;')}>{o.countTxt}</span></Hov>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {v.hasAddrFilter ? (
                <div style={css('display:inline-flex;border:1.5px solid var(--ink);')} title={v.addrFilterFull}>
                  <span style={css(`display:inline-flex;align-items:center;padding:0 11px;height:34px;box-sizing:border-box;background:var(--ink);color:var(--panel);font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;border-right:1.5px solid var(--ink);`)}>{v.addrFilterRole}</span>
                  <Hov tag="span" onClick={v.openAddrPage} title="open address page" style={css(`display:inline-flex;align-items:center;height:34px;box-sizing:border-box;padding:0 11px;background:var(--panel);color:var(--ink);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.04em;cursor:pointer;`)} hover={css('color:var(--acc);')}>{v.addrFilterShort}</Hov>
                  <Hov tag="button" onClick={v.clearAddrFilter} title="remove address filter" style={css(`display:inline-flex;align-items:center;height:34px;box-sizing:border-box;padding:0 10px;cursor:pointer;border:none;border-left:1.5px solid var(--ink);background:var(--panel);color:var(--mut);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;`)} hover={css('background:var(--acc);color:var(--onacc);')}>✕</Hov>
                </div>
              ) : null}
              {v.hasActiveFilter ? (
                <Hov tag="button" onClick={v.clearFilters} style={css(`display:inline-flex;align-items:center;gap:6px;height:37px;box-sizing:border-box;padding:0 13px;cursor:pointer;border:1.5px solid var(--ink);background:var(--ink);color:var(--panel);font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;line-height:1;`)} hover={css('background:var(--acc);color:var(--onacc);border-color:var(--ink);')}>✕ CLEAR</Hov>
              ) : null}
            </div>
            <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;color:var(--mut);`)}>{v.filterResultTxt}</span>
          </div>
          <div style={css('padding:14px 22px;')}>
            <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>WHO SETTLED IT</div>
            <div style={css('display:flex;height:12px;margin-top:8px;border:1.5px solid var(--ink);')}>
              <div style={css(`background:var(--acc);width:${v.pctRail};min-width:3px;`)}></div>
              <div style={css(`background:var(--ink);width:${v.pctVer};`)}></div>
              <div style={css(`background:var(--stripe);width:${v.pctShaped};`)}></div>
            </div>
            <div style={css(`display:flex;justify-content:space-between;margin-top:7px;font-family:'JetBrains Mono',monospace;font-size:8px;letter-spacing:.03em;color:var(--mut);white-space:nowrap;`)}>
              <span style={css('display:inline-flex;align-items:center;gap:4px;')}><span style={css('width:7px;height:7px;background:var(--acc);border:1px solid var(--ink);flex:none;')}></span>RAIL402 {v.pctRail}</span>
              <span style={css('display:inline-flex;align-items:center;gap:4px;')}><span style={css('width:7px;height:7px;background:var(--ink);flex:none;')}></span>VERIFIED {v.pctVer}</span>
              <span style={css('display:inline-flex;align-items:center;gap:4px;')}><span style={css('width:7px;height:7px;background:var(--stripe);border:1px solid var(--line);flex:none;')}></span>UNKNOWN {v.pctShaped}</span>
            </div>
          </div>
        </div>
        <div style={css(`display:grid;grid-template-columns:64px 130px minmax(0,1fr) 100px 160px 150px;gap:16px;padding:10px 22px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.14em;color:var(--mut);background:var(--head);`)}>
          <span>AGE</span><span>TX</span><span>BUYER → SELLER</span><span>SCHEME</span><span>SETTLED BY</span><span style={css('text-align:right;')}>AMOUNT</span>
        </div>
        {v.loading ? (
          <div style={css('padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;')}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
        ) : null}
        {v.hasNew ? (
          <button onClick={v.revealNew} style={css(`width:100%;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.12em;background:var(--acc);color:var(--onacc);border:none;border-bottom:1.5px solid var(--ink);padding:10px;cursor:pointer;`)}>↑ {v.newCount} NEW PAYMENTS · CLICK TO SHOW</button>
        ) : null}
        {v.feedEmpty ? (
          <div style={css('padding:36px 22px;font-size:14px;color:var(--mut);')}>No payments match these filters yet. The feed is live; new settlements appear as they land.</div>
        ) : null}
        {v.rows.map((r, i) => (
          <Hov key={i} tag="div" onClick={r.openTx} style={css(`display:grid;grid-template-columns:64px 130px minmax(0,1fr) 100px 160px 150px;gap:16px;padding:11px 22px;border-bottom:1px solid var(--line);align-items:center;font-family:'JetBrains Mono',monospace;font-size:12px;animation:${r.anim};cursor:pointer;`)} hover={css('background:var(--head);')}>
            <span style={css('color:var(--mut);')} data-tip={r.timeTitle}>{r.time}</span>
            <span style={css('display:flex;align-items:center;gap:6px;')}><Hov tag="span" onClick={r.openTx} style={css('cursor:pointer;text-decoration:underline;text-decoration-color:var(--acc);text-underline-offset:3px;')} hover={css('color:var(--acc);')}>{r.hashShort}</Hov><Hov tag="button" onClick={r.copyHash} title="copy tx hash" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;padding:1px 5px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--mut);`)} hover={css('color:var(--ink);border-color:var(--ink);')}>⧉</Hov></span>
            <span style={css('overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}><Hov tag="span" onClick={r.openBuyer} style={css('cursor:pointer;')} hover={css('color:var(--acc);')}>{r.buyerShort}</Hov>{r.isContract ? <span title="smart-contract wallet" style={css('margin-left:6px;font-size:9px;font-weight:700;background:var(--ink);color:var(--panel);padding:1px 5px;')}>C</span> : null}<span style={css('color:var(--acc);margin:0 7px;font-weight:700;')}>→</span><Hov tag="span" onClick={r.openSeller} title={r.sellerTitle} style={css('cursor:pointer;')} hover={css('color:var(--acc);')}>{r.sellerLabel}</Hov></span>
            <span style={css('font-size:10px;color:var(--mut);letter-spacing:.06em;')}>{r.isUpto ? <span title="metered: settled share of the authorized ceiling" style={css('display:inline-block;width:34px;height:7px;border:1px solid var(--ink);background:var(--bg);margin-right:6px;vertical-align:middle;')}><span style={css(`display:block;height:100%;background:var(--acc);width:${r.uptoPct};`)}></span></span> : null}{r.schemeTxt}</span>
            <span onClick={r.openFac} style={css(`cursor:${r.facCursor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}><span style={css(`font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;background:${r.confBg};color:${r.confFg};border:1.5px solid ${r.confBd};`)}>{r.settledTxt}</span></span>
            <span style={css('text-align:right;font-weight:700;display:flex;align-items:center;justify-content:flex-end;gap:6px;')}>{r.hasIcon ? <img src={r.iconUrl} alt={r.asset} style={css('width:16px;height:16px;border-radius:50%;object-fit:cover;flex:none;')} /> : null}{r.amtTxt} <span style={css('font-weight:400;color:var(--mut);font-size:10px;')}>{r.asset}</span></span>
          </Hov>
        ))}
        {v.more ? (
          <button onClick={v.loadMore} style={css(`width:100%;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.16em;background:var(--ink);color:var(--panel);border:none;padding:14px;cursor:pointer;`)}>LOAD MORE ↓</button>
        ) : null}
      </div>
      <div style={css(`display:flex;justify-content:space-between;gap:20px;padding:14px 4px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.06em;color:var(--mut);flex-wrap:wrap;`)}>
        <span style={css(`font-family:'Space Grotesk',sans-serif;font-size:13px;letter-spacing:0;line-height:1.5;`)}>▨ Unknown: a real on-chain x402 payment that no registered facilitator claims.</span>
        <span style={css(`font-family:'Space Grotesk',sans-serif;font-size:13px;letter-spacing:0;`)}>Source: Rail402</span>
      </div>
    </>
  );
}
