import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function Ecosystem({ v }) {
  return (
    <>
      <div style={css(`padding:22px 2px 18px;`)}>
        <h1 style={css(`margin:0;font-size:24px;font-weight:600;`)}>Ecosystem</h1>
        <p style={css(`margin:8px 0 0;font-size:15px;line-height:1.5;color:var(--mut);`)}>How big is the x402 economy on Stellar, who runs it, and is it growing?{' '}{v.ecoHasSince ? <><span style={css(`color:var(--ink);text-decoration:underline;text-decoration-color:var(--acc);text-decoration-thickness:2.5px;text-underline-offset:3px;`)}>{v.ecoSinceTxt}</span>.</> : null}</p>
      </div>
      {v.ecoLoading ? (
        <div style={css(`padding:44px 22px;border:2px solid var(--ink);background:var(--panel);min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
      ) : null}
      {v.ecoReady ? (
        <>
          <div style={css(`border:2px solid var(--ink);background:var(--panel);`)}>
            <div style={css(`display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-bottom:2px solid var(--ink);`)}>
              <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>TOTAL PAYMENTS</div><div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.ecoPayTxt}</div><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);margin-top:3px;`)}>ALL TIME</div></div>
              <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>{v.ecoTopAssetLabel}</div><div title={v.ecoAssetShareTxt} style={css(`font-size:30px;font-weight:700;letter-spacing:-.02em;margin-top:4px;display:flex;align-items:center;gap:8px;white-space:nowrap;`)}>{v.ecoSelHasIcon ? <img src={v.ecoSelIcon} alt="" style={css(`width:20px;height:20px;border-radius:50%;object-fit:cover;flex:none;`)} /> : null}{v.ecoVolTxt}</div><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);margin-top:3px;`)}>{v.ecoVolCode}</div></div>
              <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>BUYERS</div><div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.ecoBuyTxt}</div><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);margin-top:3px;`)}>UNIQUE ADDRESSES</div></div>
              <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>SELLERS</div><div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.ecoSellTxt}</div><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);margin-top:3px;`)}>UNIQUE ADDRESSES</div></div>
              <div style={css(`padding:16px 20px;border-right:1.5px solid var(--ink);`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>FACILITATORS</div><div style={css(`font-size:30px;font-weight:700;margin-top:4px;`)}>{v.ecoFacCntTxt}</div><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);margin-top:3px;`)}>REGISTERED</div></div>
              <div style={css(`padding:16px 20px;`)}><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>LAST PAYMENT</div><div style={css(`font-size:30px;font-weight:700;margin-top:4px;white-space:nowrap;`)}>{v.ecoLastTxt}</div><div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);margin-top:3px;`)}>SETTLED ON CHAIN</div></div>
            </div>
            <div style={css(`display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 20px;border-bottom:1.5px solid var(--ink);flex-wrap:wrap;`)}>
              <div style={css(`display:flex;gap:8px;`)}>
                <button onClick={v.pickSeriesPay} style={css(`display:inline-flex;align-items:center;gap:7px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;background:${v.serPayBg};color:${v.serPayFg};border:1.5px solid var(--ink);`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css(`flex:none;`)}><path d="m16 3 4 4-4 4"></path><path d="M20 7H4"></path><path d="m8 21-4-4 4-4"></path><path d="M4 17h16"></path></svg>PAYMENTS</button>
                <button onClick={v.pickSeriesBuy} style={css(`display:inline-flex;align-items:center;gap:7px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;background:${v.serBuyBg};color:${v.serBuyFg};border:1.5px solid var(--ink);`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css(`flex:none;`)}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>BUYERS · ALL ASSETS</button>
                <button onClick={v.pickSeriesVol} style={css(`display:inline-flex;align-items:center;gap:7px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;background:${v.serVolBg};color:${v.serVolFg};border:1.5px solid var(--ink);`)}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={css(`flex:none;`)}><path d="M3 3v18h18"></path><path d="M18 17V9"></path><path d="M13 17V5"></path><path d="M8 17v-3"></path></svg>VOLUME</button>
                <div style={css(`position:relative;`)}>
                  <button onClick={v.toggleEcoAssetMenu} style={css(`display:inline-flex;align-items:center;gap:7px;height:100%;box-sizing:border-box;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;background:var(--panel);color:var(--ink);border:1.5px solid var(--ink);`)}><span>ASSET ·</span>{v.ecoSelHasIcon ? <img src={v.ecoSelIcon} alt="" style={css(`width:13px;height:13px;border-radius:50%;object-fit:cover;flex:none;display:block;`)} /> : null}<span>{v.ecoSelCode}</span><span style={css(`font-size:8px;color:var(--mut);`)}>▼</span></button>
                  {v.ecoAssetMenuOpen ? (
                    <div style={css(`position:absolute;top:34px;left:0;width:280px;border:1.5px solid var(--ink);background:var(--panel);z-index:60;`)}>
                      <input value={v.ecoAssetQ} onChange={v.setEcoAssetQ} placeholder="FILTER ASSETS…" spellCheck="false" style={css(`width:100%;box-sizing:border-box;font-family:'JetBrains Mono',monospace;font-size:11px;padding:9px 11px;border:none;border-bottom:1.5px solid var(--ink);background:var(--bg);color:var(--ink);outline:none;`)} />
                      <div style={css(`max-height:290px;overflow-y:auto;`)}>
                        {v.ecoAssetOpts.map((a, i) => (
                          <Hov key={i} tag="div" onClick={a.pick} style={css(`display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;background:${a.bg};color:${a.fg};border-bottom:1px solid var(--line);font-family:'JetBrains Mono',monospace;`)} hover={css(`background:${a.hoverBg};color:${a.hoverFg};`)}>
                            <span style={css(`display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.06em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{a.hasIcon ? <img src={a.icon} alt={a.code} style={css(`width:16px;height:16px;border-radius:50%;object-fit:cover;flex:none;`)} /> : null}{a.noIcon ? <span style={css(`width:16px;height:16px;flex:none;border-radius:50%;background:var(--stripe);border:1px solid var(--line);`)}></span> : null}{a.code}</span>
                            <span style={css(`font-size:10px;color:${a.mutFg};white-space:nowrap;flex:none;`)}>{a.sub}</span>
                          </Hov>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
              <div style={css(`display:flex;gap:8px;`)}>
                {v.ecoRangeTabs.map((t, i) => (
                  <button key={i} onClick={t.pick} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.06em;padding:6px 11px;cursor:pointer;background:${t.bg};color:${t.fg};border:1.5px solid var(--ink);`)}>{t.label}</button>
                ))}
              </div>
            </div>
            {v.ecoTsLoading ? (
              <div style={css(`padding:22px;min-height:214px;box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
            ) : null}
            {v.ecoHasTs ? (
              <div style={css(`padding:12px 20px 8px;`)}>
                {v.ecoChartQuiet ? (
                  <div style={css(`margin-bottom:10px;font-size:13px;color:var(--mut);`)}>{v.ecoQuietTxt}</div>
                ) : null}
                <div style={css(`display:flex;gap:10px;align-items:stretch;margin-bottom:10px;flex-wrap:wrap;`)}>
                  <div style={css(`flex:1;min-width:240px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--mut);padding:6px 10px;border:1px solid var(--line);display:flex;align-items:center;`)}>{v.ecoScopeTxt}</div>
                  <div title="payments by scheme in the selected range (all assets)" style={css(`display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.06em;color:var(--mut);padding:6px 10px;border:1px solid var(--line);`)}>
                    <span>EXACT {v.ecoSchemeExactTxt}</span>
                    <span style={css(`width:60px;height:8px;border:1px solid var(--ink);background:var(--ink);display:inline-flex;justify-content:flex-end;`)}><span style={css(`display:block;height:100%;background:var(--acc);width:${v.ecoUptoW};`)}></span></span>
                    <span>UPTO {v.ecoSchemeUptoTxt}</span>
                  </div>
                </div>
                <div style={css(`position:relative;height:160px;border-bottom:1.5px solid var(--ink);`)}>
                  <div style={css(`position:absolute;left:0;right:0;top:0;border-top:1px dashed var(--line);`)}></div>
                  <div style={css(`position:absolute;left:0;right:0;top:50%;border-top:1px dashed var(--line);`)}></div>
                  <div style={css(`position:absolute;left:0;right:0;top:75%;border-top:1px dashed var(--line);`)}></div>
                  <span style={css(`position:absolute;right:0;top:2px;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.08em;color:var(--mut);background:var(--panel);padding:0 4px;z-index:2;`)}>{v.ecoMaxTxt}</span>
                  {v.tipShow ? (
                    <div style={css(`position:absolute;top:8px;left:${v.tipLeft};transform:translateX(-50%);z-index:5;pointer-events:none;border:1.5px solid var(--ink);background:var(--panel);padding:8px 11px;font-family:'JetBrains Mono',monospace;white-space:nowrap;`)}>
                      <div style={css(`font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--acc);`)}>{v.tipTitle}</div>
                      <div style={css(`font-size:11px;font-weight:700;margin-top:4px;`)}>{v.tipRow1}</div>
                      <div style={css(`font-size:9px;color:var(--mut);margin-top:3px;letter-spacing:.04em;`)}>{v.tipRow2}</div>
                    </div>
                  ) : null}
                  <div style={css(`position:absolute;inset:0;display:flex;align-items:flex-end;gap:2px;`)}>
                  {v.ecoBars.map((b, i) => (
                    <div key={i} onMouseEnter={b.enter} onMouseLeave={b.leave} style={css(`flex:1;background:${b.bg};height:${b.h};min-width:2px;border:${b.bd};box-sizing:border-box;cursor:crosshair;`)}></div>
                  ))}
                  </div>
                </div>
                <div style={css(`display:flex;justify-content:space-between;padding:6px 0 12px;font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;color:var(--mut);`)}>
                  <span>{v.ecoFromTxt}</span><span>▨ {v.ecoToTxt}</span>
                </div>
              </div>
            ) : null}
          </div>
          <div style={css(`display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);border:2px solid var(--ink);border-top:none;background:var(--panel);`)}>
            <div style={css(`border-right:1.5px solid var(--ink);`)}>
              <div style={css(`padding:12px 20px;border-bottom:1.5px solid var(--ink);background:var(--head);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>{v.ecoShareTitle}</div>
              {v.ecoFacs.map((f, i) => (
                <Hov key={i} tag="div" onClick={f.open} style={css(`display:flex;flex-direction:column;gap:8px;padding:13px 20px;border-bottom:1px solid var(--line);cursor:${f.cursor};font-family:'JetBrains Mono',monospace;font-size:12px;`)} hover={css(`background:var(--head);`)}>
                  <div style={css(`display:flex;align-items:center;justify-content:space-between;gap:12px;`)}>
                    <span style={css(`display:flex;align-items:center;gap:8px;font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;`)}><span style={css(`width:9px;height:9px;flex:none;background:${f.color};border:1px solid var(--ink);`)}></span>{f.name}</span>
                    <span style={css(`display:flex;gap:14px;flex:none;align-items:baseline;`)}><span style={css(`font-weight:700;`)}>{f.payTxt}</span><span style={css(`color:var(--mut);font-size:11px;`)}>{f.w30Txt}</span><span style={css(`color:var(--mut);font-size:11px;`)}>{f.lastTxt}</span></span>
                  </div>
                  <div style={css(`display:flex;align-items:center;gap:8px;`)}><span style={css(`flex:1;height:8px;border:1px solid var(--ink);background:var(--bg);`)}><span style={css(`display:block;height:100%;background:${f.color};width:${f.shareW};`)}></span></span><span style={css(`font-size:10px;color:var(--mut);flex:none;`)}>{f.sharePct}</span></div>
                </Hov>
              ))}
            </div>
            <div style={css(`display:flex;flex-direction:column;`)}>
              <div style={css(`padding:12px 20px;border-bottom:1.5px solid var(--ink);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);background:var(--head);`)}>{v.ecoGrowthTitle}</div>
              <div style={css(`display:grid;grid-template-columns:44px 1fr 1.1fr 1fr 1fr;gap:12px;padding:10px 20px;border-bottom:1px solid var(--line);font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;color:var(--mut);`)}>
                <span></span><span style={css(`text-align:right;`)}>PAYMENTS</span><span style={css(`text-align:right;`)}>VOLUME</span><span style={css(`text-align:right;`)}>BUYERS</span><span style={css(`text-align:right;`)}>SELLERS</span>
              </div>
              {v.ecoWindows.map((w, i) => (
                <Hov key={i} tag="div" title="Payments settled, selected-asset volume, and active/first-time buyers and sellers in this trailing window" style={css(`flex:1;display:grid;grid-template-columns:44px 1fr 1.1fr 1fr 1fr;gap:12px;padding:12px 20px;border-bottom:1px solid var(--line);font-family:'JetBrains Mono',monospace;align-items:center;background:${w.bg};`)} hover={css(`background:var(--head);`)}>
                  <span style={css(`font-weight:700;color:var(--acc);font-size:12px;`)}>{w.k}</span>
                  <span style={css(`text-align:right;`)}><span style={css(`display:block;font-size:14px;font-weight:700;white-space:nowrap;`)}>{w.pay}</span>{w.trendShow ? <span title={w.trendTitle} style={css(`display:inline-block;font-size:9px;font-weight:700;letter-spacing:.06em;padding:2px 6px;margin-top:3px;background:${w.trendBg};color:#FFFFFF;`)}>{w.trendTxt}</span> : null}</span>
                  <span style={css(`text-align:right;`)}><span style={css(`display:block;font-size:14px;font-weight:700;white-space:nowrap;`)}>{w.vol}</span><span style={css(`display:block;font-size:9px;color:var(--mut);letter-spacing:.08em;margin-top:2px;`)}>{w.volCode}</span></span>
                  <span style={css(`text-align:right;`)}><span style={css(`display:block;font-size:14px;font-weight:700;white-space:nowrap;`)}>{w.buyers}</span>{w.buyTrendShow ? <span title={w.buyTrendTitle} style={css(`display:inline-block;font-size:9px;font-weight:700;letter-spacing:.06em;padding:2px 6px;margin-top:3px;background:${w.buyTrendBg};color:#FFFFFF;white-space:nowrap;`)}>{w.buyTrendTxt}</span> : null}</span>
                  <span style={css(`text-align:right;`)}><span style={css(`display:block;font-size:14px;font-weight:700;white-space:nowrap;`)}>{w.sellers}</span>{w.sellTrendShow ? <span title={w.sellTrendTitle} style={css(`display:inline-block;font-size:9px;font-weight:700;letter-spacing:.06em;padding:2px 6px;margin-top:3px;background:${w.sellTrendBg};color:#FFFFFF;white-space:nowrap;`)}>{w.sellTrendTxt}</span> : null}</span>
                </Hov>
              ))}
            </div>
          </div>
          {v.ecoHasSellers ? (
            <div style={css(`border:2px solid var(--ink);border-top:none;background:var(--panel);`)}>
              <div style={css(`display:flex;justify-content:space-between;align-items:center;padding:12px 20px;border-bottom:1.5px solid var(--ink);background:var(--head);`)}>
                <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>{v.ecoSellersTitle}</span>
                <button onClick={v.goSellers} style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.1em;padding:5px 10px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);`)}>FULL DIRECTORY →</button>
              </div>
              {v.ecoTopSellers.map((s, i) => (
                <Hov key={i} tag="div" onClick={s.open} style={css(`display:grid;grid-template-columns:40px minmax(0,1.3fr) minmax(0,0.9fr) 120px 90px 80px 130px 90px;gap:12px;padding:12px 20px;border-bottom:1px solid var(--line);align-items:center;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:12px;`)} hover={css(`background:var(--head);`)}>
                  <span style={css(`font-weight:700;color:var(--mut);`)}>{s.rank}</span>
                  <span style={css(`font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{s.name}</span>
                  <span style={css(`color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`)}>{s.addr}</span>
                  <span title="share of all payments in the trailing 30 days" style={css(`display:flex;align-items:center;gap:7px;`)}><span style={css(`flex:1;height:7px;border:1px solid var(--ink);background:var(--bg);`)}><span style={css(`display:block;height:100%;background:var(--acc);width:${s.sharePct};`)}></span></span><span style={css(`font-size:10px;color:var(--mut);flex:none;`)}>{s.sharePct}</span></span>
                  <span style={css(`text-align:right;font-weight:700;`)}>{s.payTxt}</span>
                  <span style={css(`text-align:right;color:var(--mut);`)}>{s.buyTxt}</span>
                  <span style={css(`text-align:right;`)}>{s.volTxt}</span>
                  <span style={css(`text-align:right;font-size:11px;color:var(--mut);`)}>{s.lastTxt}</span>
                </Hov>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
