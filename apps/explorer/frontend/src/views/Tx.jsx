import React from 'react';
import { css } from '../lib/css.js';
import { Hov } from '../lib/Hov.jsx';

export default function Tx({ v }) {
  return (
    <>
      <div style={css(`padding:22px 2px 14px;display:flex;align-items:center;gap:12px;`)}>
        <button onClick={v.goFeed} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:6px 12px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);`)}>← FEED</button>
        <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.06em;color:var(--mut);word-break:break-all;min-width:0;`)}>TX / {v.txHashShort}</span>
        <Hov tag="button" onClick={v.copyHash} title="copy tx hash" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;padding:2px 7px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--mut);flex:none;`)} hover={css('border-color:var(--ink);color:var(--ink);')}>{v.copyLabel}</Hov>
      </div>
      {v.txLoading ? (
        <div style={css(`padding:44px 22px;border:2px solid var(--ink);background:var(--panel);min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;justify-content:center;align-items:center;`)}><span style={css(`background:var(--acc);color:var(--onacc);font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;letter-spacing:.06em;padding:6px 11px;animation:pulse 1.3s ease-in-out infinite;`)}>RAIL402</span></div>
      ) : null}
      {v.txErr ? (
        <div style={css(`border:2px solid var(--ink);background:var(--panel);padding:44px 22px;min-height:calc(100vh - 460px);box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:10px;text-align:center;`)}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--acc)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>
          <div style={css(`font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;letter-spacing:.08em;color:var(--acc);`)}>{v.txErrCode}</div>
          <div style={css(`font-size:16px;font-weight:600;max-width:60ch;`)}>{v.txErrReason}</div>
          <div style={css(`font-size:13px;line-height:1.5;color:var(--mut);max-width:52ch;`)}>Ingestion tails the ledger with a few seconds of lag. A very recent settlement may not be here yet.</div>
          <button onClick={v.retryTx} style={css(`margin-top:6px;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:8px 16px;cursor:pointer;border:1.5px solid var(--ink);background:var(--ink);color:var(--panel);`)}>RETRY</button>
        </div>
      ) : null}
      {v.txReady ? (
        <div style={css(`border:2px solid var(--ink);background:var(--panel);`)}>
          <div style={css(`padding:20px 22px;border-bottom:2px solid var(--ink);`)}>
            <div style={css(`display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px;`)}>
              <span style={css(`display:inline-flex;align-items:center;gap:9px;font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;letter-spacing:.08em;`)}><span style={css(`display:inline-flex;width:18px;height:18px;background:var(--acc);color:var(--onacc);align-items:center;justify-content:center;font-size:11px;`)}>✓</span>PAYMENT SETTLED ON-CHAIN · {v.dAgo} AGO</span>
              <Hov tag="a" href={v.dLink} target="_blank" rel="noopener" style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;padding:8px 14px;border:1.5px solid var(--ink);background:var(--ink);color:var(--panel);text-decoration:none;`)} hover={css(`background:var(--acc);color:var(--onacc);`)}>VERIFY ON STELLAR.EXPERT ↗</Hov>
            </div>
            <div style={css(`display:flex;justify-content:space-between;align-items:center;gap:24px;flex-wrap:wrap;`)}>
              <div style={css('min-width:0;')}>
                <div style={css(`display:flex;align-items:center;gap:12px;flex-wrap:wrap;`)}>
                  {v.dHasIcon ? <img src={v.dIconUrl} alt={v.dAsset} style={css(`width:28px;height:28px;border-radius:50%;object-fit:cover;flex:none;`)} /> : null}
                  <span style={css(`font-size:38px;font-weight:700;letter-spacing:-.02em;`)}>{v.dAmt}</span>
                  <Hov tag="span" onClick={v.dGoAsset} title="open this asset's detail page" style={css(`font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;color:var(--ink);cursor:pointer;`)} hover={css('color:var(--acc);')}>{v.dAsset}</Hov>
                  <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;border:1.5px solid var(--ink);color:var(--ink);`)}>{v.dScheme}</span>
                </div>
                {v.dHasService ? (
                  <div style={css(`margin-top:8px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.06em;color:var(--mut);`)}>PAID TO <span style={css('color:var(--ink);font-weight:700;')}>{v.dServiceName}</span></div>
                ) : null}
              </div>
              {v.dIsUpto ? (
                <div style={css(`display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none;`)}>
                  <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;color:var(--acc);`)}>METERED: {v.dAmt} USED OF {v.dCeil} AUTHORIZED</div>
                  <div style={css(`height:10px;width:260px;border:1.5px solid var(--ink);background:var(--bg);`)}><div style={css(`height:100%;background:var(--acc);width:${v.dUptoPct};`)}></div></div>
                </div>
              ) : null}
            </div>
            <div style={css(`margin-top:10px;display:flex;align-items:center;gap:9px;flex-wrap:wrap;`)}>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.1em;color:var(--mut);`)}>SETTLED BY</span>
              <span onClick={v.dGoFac} style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;background:${v.dConfBg};color:${v.dConfFg};border:1.5px solid ${v.dConfBd};cursor:${v.dFacCursor};`)}>{v.dSettledTxt}</span>
            </div>
            {v.dMultiOp ? (
              <div style={css(`margin-top:12px;font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--acc);`)}>THIS TRANSACTION SETTLED {v.dOpCount} PAYMENTS. ALL OF THEM ARE LISTED BELOW; THE FIELDS ON THIS PAGE DESCRIBE THE FIRST.</div>
            ) : null}
          </div>
          <div style={css(`display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:2px solid var(--ink);background:var(--head);`)}>
            <div style={css(`padding:22px;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;text-align:center;`)}>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.16em;color:var(--mut);`)}>BUYER · THE AGENT THAT PAID {v.dBuyerKind}</span>
              <Hov tag="span" onClick={v.dGoBuyer} style={css(`font-family:'JetBrains Mono',monospace;font-size:17px;font-weight:700;cursor:pointer;text-decoration:underline;text-decoration-color:var(--acc);text-underline-offset:4px;`)} hover={css(`color:var(--acc);`)}>{v.dBuyerShort}</Hov>
              <div style={css(`display:flex;gap:6px;`)}>
                <Hov tag="button" onClick={v.dCopyBuyer} title="copy address" style={css(`font-size:10px;padding:3px 8px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--mut);font-family:'JetBrains Mono',monospace;`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>⧉ COPY</Hov>
                <Hov tag="a" href={v.dBuyerExpert} target="_blank" rel="noopener" title="open on stellar.expert" style={css(`font-size:10px;padding:3px 8px;border:1px solid var(--line);color:var(--mut);text-decoration:none;font-family:'JetBrains Mono',monospace;`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>↗ EXPERT</Hov>
              </div>
            </div>
            <div style={css(`padding:22px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border-left:1.5px solid var(--line);border-right:1.5px solid var(--line);text-align:center;`)}>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:700;display:flex;align-items:center;gap:7px;`)}>{v.dHasIcon ? <img src={v.dIconUrl} alt={v.dAsset} style={css(`width:17px;height:17px;border-radius:50%;object-fit:cover;flex:none;`)} /> : null}{v.dAmt} {v.dAsset}</span>
              <span style={css(`color:var(--acc);font-weight:700;font-size:20px;line-height:1;`)}>⟶</span>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.1em;color:var(--mut);`)}>SETTLED BY</span>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;padding:3px 8px;background:${v.dConfBg};color:${v.dConfFg};`)}>{v.dSettledTxt}</span>
            </div>
            <div style={css(`padding:22px;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;text-align:center;`)}>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.16em;color:var(--mut);`)}>SELLER · THE API THAT GOT PAID</span>
              <Hov tag="span" onClick={v.dGoSeller} style={css(`font-family:'JetBrains Mono',monospace;font-size:17px;font-weight:700;cursor:pointer;text-decoration:underline;text-decoration-color:var(--acc);text-underline-offset:4px;`)} hover={css(`color:var(--acc);`)}>{v.dSellerShort}</Hov>
              <div style={css(`display:flex;gap:6px;`)}>
                <Hov tag="button" onClick={v.dCopySeller} title="copy address" style={css(`font-size:10px;padding:3px 8px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--mut);font-family:'JetBrains Mono',monospace;`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>⧉ COPY</Hov>
                <Hov tag="a" href={v.dSellerExpert} target="_blank" rel="noopener" title="open on stellar.expert" style={css(`font-size:10px;padding:3px 8px;border:1px solid var(--line);color:var(--mut);text-decoration:none;font-family:'JetBrains Mono',monospace;`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>↗ EXPERT</Hov>
              </div>
            </div>
          </div>
          <div style={css('border-bottom:2px solid var(--ink);')}>
            <div style={css(`padding:10px 22px;border-bottom:1.5px solid var(--line);background:var(--head);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>PAYMENT LIFECYCLE · AGENT TO AGENT OVER HTTP 402</div>
            {v.dSteps.map((st, i) => (
              <div key={i} style={css(`display:grid;grid-template-columns:26px minmax(0,1fr) 130px;gap:14px;padding:13px 22px;border-bottom:1px solid var(--line);align-items:start;`)}>
                <span style={css(`width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;background:${st.mBg};color:${st.mFg};border:1.5px solid ${st.mBd};font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;`)}>✓</span>
                <span style={css('min-width:0;')}>
                  <span style={css(`display:block;font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.08em;`)}>{st.n} · {st.title}</span>
                  <span style={css('display:block;font-size:13px;line-height:1.6;margin-top:3px;')}>{st.parts.map((pt, j) => (
                    <span key={j} style={css(`font-weight:${pt.w};color:${pt.fg};text-decoration:${pt.deco};text-decoration-color:var(--acc);text-decoration-thickness:2px;text-underline-offset:3px;`)}>{pt.t}</span>
                  ))}</span>
                </span>
                <span style={css('display:flex;flex-direction:column;align-items:flex-end;gap:6px;padding-top:4px;')}>
                  <span style={css(`text-align:right;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.08em;color:${st.tagFg};`)}>{st.tag}</span>
                  {st.pShow ? (
                    <Hov tag="a" href={st.pHref} target="_blank" rel="noopener" title="verify this claim on stellar.expert" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;letter-spacing:.08em;padding:3px 7px;border:1px solid var(--line);color:var(--mut);text-decoration:none;white-space:nowrap;`)} hover={css('border-color:var(--ink);color:var(--ink);')}>{st.pLabel}</Hov>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          {v.dMultiOp ? (
            <div style={css('border-bottom:2px solid var(--ink);')}>
              <div style={css(`padding:10px 22px;border-bottom:1.5px solid var(--line);background:var(--head);font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--mut);`)}>ALL {v.dOpCount} PAYMENTS IN THIS TRANSACTION</div>
              {v.dPayments.map((p, i) => (
                <div key={i} style={css(`display:grid;grid-template-columns:40px minmax(0,1fr) 100px 150px;gap:16px;padding:10px 22px;border-bottom:1px solid var(--line);align-items:center;font-family:'JetBrains Mono',monospace;font-size:12px;`)}>
                  <span style={css('font-weight:700;color:var(--mut);')}>{p.idx}</span>
                  <span style={css('overflow:hidden;text-overflow:ellipsis;white-space:nowrap;')}><Hov tag="span" onClick={p.goBuyer} style={css('cursor:pointer;')} hover={css('color:var(--acc);')}>{p.buyer}</Hov><span style={css('color:var(--acc);margin:0 7px;font-weight:700;')}>→</span><Hov tag="span" onClick={p.goSeller} style={css('cursor:pointer;')} hover={css('color:var(--acc);')}>{p.seller}</Hov></span>
                  <span style={css('font-size:10px;color:var(--mut);letter-spacing:.06em;')}>{p.scheme}</span>
                  <span style={css('text-align:right;font-weight:700;')}>{p.amt} <span style={css('font-weight:400;color:var(--mut);font-size:10px;')}>{p.code}</span></span>
                </div>
              ))}
            </div>
          ) : null}
          <div>
            {v.dSections.map((sec, i) => (
              <div key={i} style={css(`display:grid;grid-template-columns:160px minmax(0,1fr);gap:20px;padding:18px 22px;border-bottom:1.5px solid var(--line);`)}>
                <div style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.16em;color:var(--acc);font-weight:700;padding-top:3px;`)}>{sec.t}</div>
                <div style={css(`display:flex;flex-wrap:wrap;gap:14px 44px;`)}>
                  {sec.rows.map((f, j) => (
                    <div key={j} style={css(`display:flex;flex-direction:column;gap:4px;`)}>
                      <span style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;color:var(--mut);`)}>{f.k}</span>
                      <span style={css(`display:inline-flex;align-items:center;gap:7px;`)}>
                        <Hov tag="span" onClick={f.go} title={f.full} style={css(`font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;white-space:nowrap;cursor:${f.cur};text-decoration:${f.deco};text-decoration-color:var(--acc);text-underline-offset:3px;`)} hover={css(`color:${f.hoverFg};`)}>{f.v}</Hov>
                        {f.hasCopy ? (
                          <Hov tag="button" onClick={f.copy} title="copy full value" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--mut);`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>⧉</Hov>
                        ) : null}
                        {f.hasExpert ? (
                          <Hov tag="a" href={f.expert} target="_blank" rel="noopener" title="open on stellar.expert" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;border:1px solid var(--line);color:var(--mut);text-decoration:none;`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>↗</Hov>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div style={css(`padding:16px 22px 24px;`)}>
            <div style={css(`display:flex;align-items:center;gap:12px;flex-wrap:wrap;`)}>
              <button onClick={v.toggleTech} style={css(`font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700;letter-spacing:.1em;padding:8px 14px;cursor:pointer;border:1.5px solid var(--ink);background:var(--panel);color:var(--ink);`)}>{v.techBtnLabel}</button>
              <span style={css(`font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--mut);`)}>SIGNING ACCOUNTS, TOKEN CONTRACT, FEES.</span>
            </div>
            {v.techOpen ? (
              <div style={css(`display:flex;flex-wrap:wrap;gap:14px 44px;margin-top:16px;padding:16px;border:1.5px solid var(--line);background:var(--head);`)}>
                {v.dTechRows.map((f, i) => (
                  <div key={i} style={css(`display:flex;flex-direction:column;gap:4px;`)}>
                    <span style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;letter-spacing:.12em;color:var(--mut);`)}>{f.k}</span>
                    <span style={css(`display:inline-flex;align-items:center;gap:7px;`)}>
                      <span title={f.full} style={css(`font-family:'JetBrains Mono',monospace;font-size:13px;font-weight:700;white-space:nowrap;`)}>{f.v}</span>
                      {f.hasCopy ? (
                        <Hov tag="button" onClick={f.copy} title="copy full value" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--mut);`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>⧉</Hov>
                      ) : null}
                      {f.hasExpert ? (
                        <Hov tag="a" href={f.expert} target="_blank" rel="noopener" title="open on stellar.expert" style={css(`font-family:'JetBrains Mono',monospace;font-size:9px;padding:2px 6px;border:1px solid var(--line);color:var(--mut);text-decoration:none;`)} hover={css(`border-color:var(--ink);color:var(--ink);`)}>↗</Hov>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
